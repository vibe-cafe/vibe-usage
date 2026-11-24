/**
 * Our own way through the user's proxy, for the cases the runtime cannot
 * follow by itself: a SOCKS5 proxy (Node's https silently connects directly,
 * measured on 24.22.3) or a runtime without built-in proxy support (Node 20,
 * 22 before 22.21, a value Node never reads such as `ALL_PROXY`). Without it
 * those requests would have to be skipped (network-privacy principle, rules
 * 1, 2 and 6 in the workspace AGENTS.md: follow the user's network, and do
 * not trade the user's experience for it).
 *
 * Zero dependencies: `node:net` and `node:tls` open the tunnel (HTTP CONNECT
 * for http:// and https:// proxies, SOCKS5 with optional username/password),
 * TLS to the target runs inside it, and `node:https` speaks HTTP over it.
 * SOCKS5 always sends the host name, never a locally resolved address, so no
 * DNS query for a vendor host leaves the machine outside the proxy. Hosts on
 * the bypass list and loopback addresses are not tunnelled.
 *
 * `installProxyTunnel` points `globalThis.fetch`, `https.globalAgent` and
 * `http.globalAgent` at it for the rest of the process. Requests that pass
 * their own agent (the Antigravity loopback reader) are unaffected.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { Readable, pipeline } from 'node:stream';

const DEFAULT_PORTS = { 'http:': 80, 'https:': 443, 'socks5:': 1080, 'socks5h:': 1080 };
const CONNECT_TIMEOUT_MS = 10_000;
// From the first byte to the proxy until the target's TLS is up: a proxy that
// accepts but whose upstream is gone must fail the request, not hang it.
const HANDSHAKE_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 20;

/**
 * `{ kind: 'http' | 'https' | 'socks5', host, port, auth? }` for a proxy value,
 * or null for one this tunnel cannot speak (SOCKS4, anything unparseable). A
 * value without a scheme is an http:// proxy, as curl and Node read it.
 */
export function parseProxy(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text.includes('://') ? text : `http://${text}`);
  } catch {
    return null;
  }
  const kind = { 'http:': 'http', 'https:': 'https', 'socks5:': 'socks5', 'socks5h:': 'socks5' }[url.protocol];
  if (!kind || !url.hostname) return null;
  const port = Number(url.port || DEFAULT_PORTS[url.protocol]);
  const auth = url.username
    ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) }
    : undefined;
  return { kind, host: url.hostname.replace(/^\[|\]$/g, ''), port, auth };
}

/** Reads from a socket on demand, keeping bytes that arrive early. */
function reader(socket) {
  let buffered = Buffer.alloc(0);
  let waiting = null;
  let failure = null;
  const wake = () => { const w = waiting; waiting = null; w?.(); };
  const onData = chunk => { buffered = Buffer.concat([buffered, chunk]); wake(); };
  const onEnd = () => { failure ??= new Error('proxy closed the connection'); wake(); };
  const onError = error => { failure ??= error; wake(); };
  socket.on('data', onData);
  socket.on('end', onEnd);
  socket.on('error', onError);
  const until = async test => {
    for (;;) {
      const end = test(buffered);
      if (end >= 0) {
        const out = buffered.subarray(0, end);
        buffered = buffered.subarray(end);
        return out;
      }
      if (failure) throw failure;
      await new Promise(resolve => { waiting = resolve; });
    }
  };
  return {
    bytes: n => until(b => (b.length >= n ? n : -1)),
    headers: () => until(b => { const i = b.indexOf('\r\n\r\n'); return i >= 0 ? i + 4 : -1; }),
    release() {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
      if (buffered.length) socket.unshift(buffered);
    },
  };
}

function openProxySocket(proxy) {
  return new Promise((resolve, reject) => {
    const socket = proxy.kind === 'https'
      ? tls.connect({ host: proxy.host, port: proxy.port, servername: net.isIP(proxy.host) ? undefined : proxy.host })
      : net.connect({ host: proxy.host, port: proxy.port });
    const timer = setTimeout(() => socket.destroy(new Error('proxy connect timed out')), CONNECT_TIMEOUT_MS);
    socket.once(proxy.kind === 'https' ? 'secureConnect' : 'connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

async function httpConnect(socket, proxy, host, port) {
  const target = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
  const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
  if (proxy.auth) {
    lines.push(`Proxy-Authorization: Basic ${Buffer.from(`${proxy.auth.user}:${proxy.auth.pass}`).toString('base64')}`);
  }
  const read = reader(socket);
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  const head = (await read.headers()).toString('latin1');
  read.release();
  const status = Number(head.match(/^HTTP\/1\.[01] (\d{3})/)?.[1]);
  if (status !== 200) throw new Error(`proxy refused the tunnel (${status || 'bad reply'})`);
}

async function socks5Connect(socket, proxy, host, port) {
  const read = reader(socket);
  socket.write(Buffer.from(proxy.auth ? [5, 2, 0, 2] : [5, 1, 0]));
  const [version, method] = await read.bytes(2);
  if (version !== 5) throw new Error('not a SOCKS5 proxy');
  if (method === 2 && proxy.auth) {
    const user = Buffer.from(proxy.auth.user);
    const pass = Buffer.from(proxy.auth.pass);
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
    const [, status] = await read.bytes(2);
    if (status !== 0) throw new Error('SOCKS5 proxy rejected the username or password');
  } else if (method !== 0) {
    throw new Error('SOCKS5 proxy offers no usable authentication');
  }
  let address;
  if (net.isIPv4(host)) address = Buffer.from([1, ...host.split('.').map(Number)]);
  else if (net.isIPv6(host)) address = Buffer.concat([Buffer.from([4]), ipv6Bytes(host)]);
  else {
    const name = Buffer.from(host);
    address = Buffer.concat([Buffer.from([3, name.length]), name]);
  }
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, portBytes]));
  const [, reply, , type] = await read.bytes(4);
  if (reply !== 0) throw new Error(`SOCKS5 proxy could not connect (code ${reply})`);
  const rest = type === 1 ? 4 + 2 : type === 4 ? 16 + 2 : (await read.bytes(1))[0] + 2;
  await read.bytes(rest);
  read.release();
}

function ipv6Bytes(host) {
  const [head, tail = ''] = host.split('::');
  const parts = s => (s ? s.split(':') : []);
  const left = parts(head);
  const right = parts(tail);
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  const out = Buffer.alloc(16);
  groups.forEach((group, i) => out.writeUInt16BE(parseInt(group, 16) || 0, i * 2));
  return out;
}

/** A raw socket to `host:port` through `proxy`. */
export async function connectThroughProxy(proxy, host, port) {
  const socket = await openProxySocket(proxy);
  try {
    if (proxy.kind === 'socks5') await socks5Connect(socket, proxy, host, port);
    else await httpConnect(socket, proxy, host, port);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/**
 * `connectThroughProxy`, then TLS to the target when `secure`, all within
 * `timeoutMs`: past it every socket is destroyed and the request fails.
 */
function openTunnel(proxy, host, port, secure, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    let current = null;
    let settled = false;
    const finish = (error, socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        current?.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const timer = setTimeout(() => finish(new Error('proxy tunnel timed out')), timeoutMs);
    connectThroughProxy(proxy, host, port).then(raw => {
      if (settled) { raw.destroy(); return; }
      current = raw;
      if (!secure) { finish(null, raw); return; }
      const socket = tls.connect({
        ...tlsOptions(options),
        socket: raw,
        // The name the certificate must match; SNI only for a host name.
        host,
        servername: options.servername ?? (net.isIP(host) ? undefined : host),
        ALPNProtocols: ['http/1.1'],
      });
      current = socket;
      socket.once('secureConnect', () => finish(null, socket));
      socket.once('error', error => finish(error));
    }, error => finish(error));
  });
}

function tlsOptions(options) {
  const picked = {};
  for (const key of ['ca', 'cert', 'key', 'pfx', 'passphrase', 'rejectUnauthorized', 'checkServerIdentity',
    'minVersion', 'maxVersion', 'ciphers', 'servername', 'session']) {
    if (options[key] !== undefined) picked[key] = options[key];
  }
  return picked;
}

/**
 * Agent whose connections go through the proxy chosen for its scheme;
 * `bypass(host)` true means a direct connection.
 */
function tunnelAgent(Base, secure, proxy, bypass, timeoutMs) {
  const target = options => ({
    host: String(options.host || options.hostname || 'localhost').replace(/^\[|\]$/g, ''),
    port: Number(options.port) || (secure ? 443 : 80),
  });
  return new (class extends Base {
    addRequest(request, options) {
      const { host, port } = target(options);
      if (!secure && proxy?.kind === 'http' && !bypass(host, port)) {
        // Plain HTTP through an HTTP proxy: the standard absolute-form
        // request to the proxy (many proxies allow CONNECT to 443 only).
        const name = net.isIPv6(host) ? `[${host}]` : host;
        request.path = `http://${name}${port === 80 ? '' : `:${port}`}${request.path}`;
        if (proxy.auth) {
          request.setHeader('proxy-authorization',
            `Basic ${Buffer.from(`${proxy.auth.user}:${proxy.auth.pass}`).toString('base64')}`);
        }
        return super.addRequest(request, { ...options, host: proxy.host, hostname: proxy.host, port: proxy.port,
          vibeUsageForward: true });
      }
      return super.addRequest(request, options);
    }

    createConnection(options, callback) {
      if (options.vibeUsageForward) return super.createConnection(options, callback);
      const { host, port } = target(options);
      if (!proxy || bypass(host, port)) return super.createConnection(options, callback);
      openTunnel(proxy, host, port, secure, options, timeoutMs).then(socket => callback(null, socket), callback);
      return undefined;
    }
  })({ keepAlive: false });
}

function headerList(headers) {
  const list = new Headers(headers || {});
  return list;
}

async function bodyBytes(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return { bytes: Buffer.from(body), type: 'text/plain;charset=UTF-8' };
  if (body instanceof URLSearchParams) {
    return { bytes: Buffer.from(body.toString()), type: 'application/x-www-form-urlencoded;charset=UTF-8' };
  }
  if (body instanceof ArrayBuffer) return { bytes: Buffer.from(body), type: null };
  if (ArrayBuffer.isView(body)) return { bytes: Buffer.from(body.buffer, body.byteOffset, body.byteLength), type: null };
  return { bytes: Buffer.from(await new Response(body).arrayBuffer()), type: null };
}

/** The body, decoded as `fetch` does; a broken source errors the result. */
function decoded(response) {
  const encoding = String(response.headers['content-encoding'] || '').trim().toLowerCase();
  const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? zlib.createGunzip()
    : encoding === 'deflate' ? zlib.createInflate()
      : encoding === 'br' ? zlib.createBrotliDecompress()
        : null;
  if (!decoder) return response;
  pipeline(response, decoder, () => {});
  return decoder;
}

const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

/**
 * `fetch` over the tunnel agents: the subset the CLI uses (method, headers,
 * string / URLSearchParams / bytes body, signal, redirects), answered with a
 * real `Response`. Compressed bodies are decoded, as `fetch` does.
 */
function tunnelFetch(agents, routeOf, nativeFetch) {
  return async function fetchThroughProxy(input, init = {}) {
    let url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    let method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let body = await bodyBytes(init.body);
    const headers = headerList(init.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has('accept')) headers.set('accept', '*/*');
    if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'gzip, deflate, br');
    if (!headers.has('user-agent')) headers.set('user-agent', 'node');
    if (body?.type && !headers.has('content-type')) headers.set('content-type', body.type);
    const signal = init.signal ?? undefined;
    for (let redirects = 0; ; redirects += 1) {
      const secure = url.protocol === 'https:';
      const mod = secure ? https : http;
      const outgoing = Object.fromEntries(headers.entries());
      if (body) outgoing['content-length'] = String(body.bytes.length);
      const response = await new Promise((resolve, reject) => {
        const request = mod.request(url, { method, headers: outgoing, agent: secure ? agents.https : agents.http, signal },
          resolve);
        request.on('error', reject);
        request.end(body ? body.bytes : undefined);
      });
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && location && init.redirect !== 'manual') {
        response.resume();
        if (init.redirect === 'error') throw new TypeError('fetch failed: redirect');
        if (redirects >= MAX_REDIRECTS) throw new TypeError('fetch failed: too many redirects');
        if (response.statusCode === 303 || ([301, 302].includes(response.statusCode) && method === 'POST')) {
          method = 'GET';
          body = null;
          headers.delete('content-type');
        }
        const next = new URL(location, url);
        if (next.origin !== url.origin) {
          // Never hand a credential, or a body that may carry one, to
          // another site (as `fetch` does for Authorization).
          if (body) throw new TypeError('fetch failed: cross-origin redirect with a body');
          for (const name of CREDENTIAL_HEADERS) headers.delete(name);
        }
        url = next;
        if (routeOf(url) !== 'tunnel') {
          // This hop goes direct (bypass list, loopback, no proxy for its
          // scheme): the native stack takes it from here.
          return nativeFetch(url, { method, headers, body: body ? body.bytes : undefined, signal, redirect: init.redirect });
        }
        continue;
      }
      const responseHeaders = new Headers();
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        responseHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
      }
      const empty = [101, 204, 205, 304].includes(response.statusCode) || method === 'HEAD';
      if (empty) response.resume();
      const stream = empty ? null : decoded(response);
      if (!empty) {
        responseHeaders.delete('content-encoding');
        responseHeaders.delete('content-length');
      }
      return new Response(empty ? null : Readable.toWeb(stream), {
        status: response.statusCode,
        statusText: response.statusMessage,
        headers: responseHeaders,
      });
    }
  };
}

/**
 * Sends the rest of the process's requests through `proxies` (`{ https, http }`
 * values as chosen per scheme) unless `bypass(host, port)` says direct. Returns
 * a function that undoes it, or false, changing nothing, when a chosen value
 * is not a proxy this tunnel can speak.
 */
export function installProxyTunnel({ proxies, bypass, nativeFetch = globalThis.fetch,
  httpModule = http, httpsModule = https, handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS } = {}) {
  const chosen = { https: proxies.https ? parseProxy(proxies.https) : null, http: proxies.http ? parseProxy(proxies.http) : null };
  if ((proxies.https && !chosen.https) || (proxies.http && !chosen.http)) return false;
  const agents = {
    https: tunnelAgent(httpsModule.Agent, true, chosen.https, bypass, handshakeTimeoutMs),
    http: tunnelAgent(httpModule.Agent, false, chosen.http, bypass, handshakeTimeoutMs),
  };
  const routeOf = url => {
    if (!['http:', 'https:'].includes(url.protocol)) return 'native';
    const secure = url.protocol === 'https:';
    const proxy = secure ? chosen.https : chosen.http;
    const port = Number(url.port) || (secure ? 443 : 80);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return proxy && !bypass(host, port) ? 'tunnel' : 'native';
  };
  const throughProxy = tunnelFetch(agents, routeOf, nativeFetch);
  const previous = { fetch: globalThis.fetch, https: httpsModule.globalAgent, http: httpModule.globalAgent };
  httpsModule.globalAgent = agents.https;
  httpModule.globalAgent = agents.http;
  globalThis.fetch = (input, init) => {
    let url;
    try {
      url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    } catch {
      return nativeFetch(input, init);
    }
    return routeOf(url) === 'tunnel' ? throughProxy(input, init) : nativeFetch(input, init);
  };
  return function uninstall() {
    globalThis.fetch = previous.fetch;
    httpsModule.globalAgent = previous.https;
    httpModule.globalAgent = previous.http;
  };
}
