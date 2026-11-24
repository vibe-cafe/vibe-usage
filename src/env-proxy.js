// Follow the proxy the environment names, or do not send requests that carry
// a vendor account (network-privacy principle, rules 1, 2 and 6, workspace
// AGENTS.md).
//
// Node's built-in fetch and https follow HTTP_PROXY / HTTPS_PROXY / NO_PROXY
// only when told to. Measured 2026-11-24 with a local stand-in proxy that never
// connects out:
//   - Node 22.19 ignores NODE_USE_ENV_PROXY entirely and connects directly.
//   - Node 24.22.3 (the Mac app's bundled runtime) honours an http:// proxy for
//     both fetch and https, with NODE_USE_ENV_PROXY=1 or after
//     http.setGlobalProxyFromEnv(); a socks5:// value makes https connect
//     directly without an error (fetch does go through SOCKS); a value without
//     a scheme makes setGlobalProxyFromEnv throw and requests go direct.
//   - `http.setGlobalProxyFromEnv()` exists from Node 24.14 / 25.4; the startup
//     switch (NODE_USE_ENV_PROXY=1 or --use-env-proxy) covers fetch and https
//     from 22.21 / 24.5 (Node docs, Built-in Proxy Support).
//   - Bun 1.3.14 honours http:// for fetch and https on its own and rejects
//     socks5:// with an error, so nothing leaks there.
// `setupEnvProxy()` runs once at start. Where the runtime can follow the
// proxy, it is turned on for this process. Where it cannot — a SOCKS5 proxy,
// an older Node, a value Node never reads such as ALL_PROXY — our own tunnel
// takes over (`proxy-tunnel.js`: HTTP CONNECT and SOCKS5 over node:net/tls), so
// those requests still go through the user's proxy instead of being skipped.
// Only what neither can follow (SOCKS4 and other unknown kinds, and Bun, which
// cannot host the tunnel) is recorded, so callers holding a vendor credential
// refuse to send (`envProxyBlock()`).
//
// Loopback is always bypassed: the Antigravity quota and parser talk to a
// language server on 127.0.0.1, which must never be sent to a proxy.

import http from 'node:http';
import net from 'node:net';
import { installProxyTunnel } from './proxy-tunnel.js';

const PROXY_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
const LOOPBACK = ['localhost', '127.0.0.1', '::1', '[::1]'];

let current = { state: 'none' };

/** Non-empty proxy variables, in the order Node and Claude Code read them. */
export function proxyVariables(env = process.env) {
  return PROXY_VARIABLES
    .filter(name => typeof env[name] === 'string' && env[name].trim() !== '')
    .map(name => ({ name, value: env[name].trim() }));
}

function first(env, names) {
  for (const name of names) {
    const value = typeof env[name] === 'string' ? env[name].trim() : '';
    if (value) return { name, value };
  }
  return null;
}

/**
 * The proxy for each scheme, read as curl reads the variables: the scheme's
 * own variable (lowercase first), then ALL_PROXY. For https an HTTP_PROXY
 * alone is the last resort, as Node's fetch already uses it.
 */
export function chosenProxies(env = process.env) {
  return {
    https: first(env, ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'http_proxy', 'HTTP_PROXY']),
    http: first(env, ['http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY']),
  };
}

function isSocks(value) {
  return /^socks[0-9a-z]*:\/\//i.test(value);
}

function withScheme(value) {
  // A scheme written in capitals (`HTTP://`) is not recognised by Node's agent.
  return value.includes('://')
    ? value.replace(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//, (_, scheme) => `${scheme.toLowerCase()}://`)
    : `http://${value}`;
}

/** `--use-env-proxy` or NODE_USE_ENV_PROXY=1, the startup switches Node reads. */
function envProxyFlagOn(env, execArgv) {
  return env.NODE_USE_ENV_PROXY === '1'
    || execArgv.includes('--use-env-proxy')
    || /(^|\s)--use-env-proxy(\s|$)/.test(env.NODE_OPTIONS || '');
}

/**
 * Node releases whose startup switch covers both fetch and https:
 * 22.21+ in the 22 line, 24.5+, and anything newer.
 */
export function nodeHonoursEnvProxyFlag(version) {
  const [major, minor] = String(version || '').split('.').map(Number);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  if (major >= 25) return true;
  if (major === 24) return minor >= 5;
  if (major === 22) return minor >= 21;
  return false;
}

/**
 * The bypass list Node itself would use (lowercase `no_proxy` wins over
 * `NO_PROXY`, as Node reads them; an empty value counts as unset), plus
 * loopback (`[::1]` too: Node's fetch matches the bracketed host). A `*`
 * stays exactly `*`.
 */
export function mergedNoProxy(env = process.env) {
  const effective = first(env, ['no_proxy', 'NO_PROXY'])?.value || '';
  const entries = effective.split(/[,\s]+/).filter(Boolean);
  if (entries.includes('*')) return '*';
  return [...entries, ...LOOPBACK.filter(host => !entries.includes(host))].join(',');
}

/**
 * Decide, once per process, whether this process follows the environment's
 * proxy. Returns and remembers `{ state }`:
 *   - `none`: no proxy variable set (nothing to follow);
 *   - `active`: requests go through the proxy;
 *   - `tunnel`: the runtime cannot follow it, our tunnel does (`proxy-tunnel.js`);
 *   - `socks`: a SOCKS proxy neither the runtime nor the tunnel can follow
 *     (SOCKS4, or Bun);
 *   - `unsupported`: a proxy is set that neither can follow.
 * The environment itself is never changed (children such as `agy` see what
 * the user or the app set). Where the runtime can be configured at run time
 * (`http.setGlobalProxyFromEnv`, Node 24.14+ / 25.4+), it gets the chosen
 * proxies directly, a value without a scheme read as `http://`. Where only
 * the startup switch exists, Node already decided from the environment as it
 * was, so only an `HTTPS_PROXY` / `HTTP_PROXY` that was there with a scheme
 * counts; anything this function would have had to add (ALL_PROXY, a
 * missing scheme) means the proxy is not followed.
 */
export function setupEnvProxy({
  env = process.env,
  versions = process.versions,
  execArgv = process.execArgv,
  httpModule = http,
  installTunnel = installProxyTunnel,
} = {}) {
  current.uninstall?.();
  current = runtimeProxyState({ env, versions, execArgv, httpModule });
  // What the runtime cannot follow goes through our own tunnel instead of
  // being skipped (rule 6: no "not sent" while a way through exists). Bun
  // cannot host the tunnel's sockets; its cases stay blocked.
  if ((current.state === 'socks' || current.state === 'unsupported') && !versions.bun) {
    const { https, http: plain } = chosenProxies(env);
    const installed = installTunnel({
      proxies: { https: https?.value, http: plain?.value },
      bypass: (host, port) => isLoopback(host)
        || noProxyMatches(`http://${net.isIPv6(host) ? `[${host}]` : host}:${port}`, env),
    });
    if (installed) current = { state: 'tunnel', uninstall: typeof installed === 'function' ? installed : undefined };
  }
  return current;
}

function isLoopback(host) {
  const name = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return name === 'localhost' || name.endsWith('.localhost') || name === '::1'
    || (net.isIPv4(name) && name.startsWith('127.'));
}

function runtimeProxyState({ env, versions, execArgv, httpModule }) {
  const { https, http: plain } = chosenProxies(env);
  if (!https && !plain) {
    return { state: 'none' };
  }
  if ([https, plain].some(choice => choice && isSocks(choice.value))) {
    return { state: 'socks' };
  }
  // Bun and the startup switch read only these variables, as they were.
  const readAtStartup = proxyVariables(env).every(({ value }) => value.includes('://'))
    && Boolean(first(env, PROXY_VARIABLES))
    && [https, plain].every(choice => !choice || PROXY_VARIABLES.includes(choice.name));
  if (versions.bun) {
    // Bun's https requests read only HTTPS_PROXY / https_proxy.
    const httpsOwn = https && ['https_proxy', 'HTTPS_PROXY'].includes(https.name);
    return { state: readAtStartup && httpsOwn ? 'active' : 'unsupported' };
  }
  if (typeof httpModule.setGlobalProxyFromEnv === 'function') {
    try {
      const restore = httpModule.setGlobalProxyFromEnv({
        HTTPS_PROXY: https ? withScheme(https.value) : undefined,
        HTTP_PROXY: plain ? withScheme(plain.value) : undefined,
        NO_PROXY: mergedNoProxy(env),
      });
      return { state: 'active', uninstall: typeof restore === 'function' ? restore : undefined };
    } catch {
      return { state: 'unsupported' };
    }
  }
  // Node's https agent reads only HTTPS_PROXY / https_proxy at start (fetch
  // also falls back to HTTP_PROXY): without one, uploads would go direct.
  const httpsOwn = !https || ['https_proxy', 'HTTPS_PROXY'].includes(https.name);
  return {
    state: readAtStartup && httpsOwn && envProxyFlagOn(env, execArgv) && nodeHonoursEnvProxyFlag(versions.node)
      ? 'active'
      : 'unsupported',
  };
}

// Left only for what the tunnel cannot speak: SOCKS4 and other unknown
// proxy kinds, and Bun.
const BLOCK_MESSAGES = {
  socks: 'The configured SOCKS proxy cannot be followed here (only SOCKS5 is supported, and not under Bun); not sent, to avoid a direct connection.',
  unsupported: 'A proxy is configured but cannot be followed here (an unrecognised proxy address, or Bun without a full HTTPS_PROXY=http://…); not sent, to avoid a direct connection.',
};

const BLOCK_NOTICES = {
  socks: '设置的 SOCKS 代理无法照着走（只支持 SOCKS5，Bun 下不支持），为避免直连已跳过',
  unsupported: '设置了代理但无法照着走（代理地址无法识别，或在 Bun 下没有写成完整的 HTTPS_PROXY=http://…），为避免直连已跳过',
};

/**
 * Why a request carrying a vendor account must not be sent right now, or
 * null when it may. `message` is English free text for the quota contract;
 * `notice` is the Chinese clause for terminal and log output.
 */
export function envProxyBlock(state = current.state) {
  if (state !== 'socks' && state !== 'unsupported') return null;
  return { reason: state, message: BLOCK_MESSAGES[state], notice: BLOCK_NOTICES[state] };
}

const DEFAULT_PORTS = { 'https:': '443', 'http:': '80' };

function requestTarget(url) {
  try {
    const parsed = new URL(String(url).includes('://') ? url : `https://${url}`);
    return {
      host: parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ''),
      port: parsed.port || DEFAULT_PORTS[parsed.protocol] || '',
    };
  } catch {
    return null;
  }
}

function bypassEntry(raw) {
  const entry = raw.toLowerCase();
  const bracketed = entry.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) return { host: bracketed[1], port: bracketed[2] || '' };
  const withPort = entry.match(/^([^:]+):(\d+)$/);
  if (withPort) return { host: withPort[1], port: withPort[2] };
  return { host: entry, port: '' };
}

/**
 * Whether a request to `url` is bypassed by the bypass list Node would use.
 * Read the way every runtime agrees on, so a match is never wider than the
 * user's rule: `*`; an exact host (a bare `example.com` is itself only — the
 * fetch in Node 22 does not extend it to subdomains); `.example.com` /
 * `*.example.com` for subdomains; an entry with a port only for that port.
 */
export function noProxyMatches(url, env = process.env) {
  const target = requestTarget(url);
  if (!target) return false;
  const list = first(env, ['no_proxy', 'NO_PROXY'])?.value || '';
  return list.split(/[,\s]+/).filter(Boolean).some(raw => {
    if (raw === '*') return true;
    const { host, port } = bypassEntry(raw);
    if (port && port !== target.port) return false;
    const suffix = host.startsWith('*.') ? host.slice(1) : host.startsWith('.') ? host : null;
    return suffix ? target.host.endsWith(suffix) : target.host === host;
  });
}

/**
 * `envProxyBlock()` for requests to these URLs: none when every one is on
 * the user's bypass list (a direct route is the user's own rule — the desktop
 * apps put the hosts a PAC sends direct there), so a domestic provider keeps
 * working when only foreign hosts would need the SOCKS proxy.
 */
export function envProxyBlockFor(urls, { env = process.env, state = current.state } = {}) {
  const block = envProxyBlock(state);
  if (!block) return null;
  return urls.length > 0 && urls.every(url => noProxyMatches(url, env)) ? null : block;
}

/** Test hook: forget the decision made by the last `setupEnvProxy()`. */
export function resetEnvProxyForTests() {
  current.uninstall?.();
  current = { state: 'none' };
}
