import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chosenProxies,
  envProxyBlock,
  envProxyBlockFor,
  noProxyMatches,
  mergedNoProxy,
  nodeHonoursEnvProxyFlag,
  proxyVariables,
  resetEnvProxyForTests,
  setupEnvProxy,
} from '../src/env-proxy.js';

// Network-privacy principle, rules 1 and 2: follow the environment's proxy or
// do not send requests that carry a vendor account. Never connect directly
// while a proxy is configured.

function fakeHttp({ throws = false } = {}) {
  const calls = [];
  return {
    calls,
    setGlobalProxyFromEnv(proxyEnv) {
      calls.push(proxyEnv);
      if (throws) throw Object.assign(new Error('invalid'), { code: 'ERR_PROXY_INVALID_CONFIG' });
      return () => {};
    },
  };
}

const NODE_24 = { node: '24.22.3' };

// Runtime decisions alone: the tunnel that takes over what the runtime cannot
// follow is tested below and in child processes.
const setup = options => setupEnvProxy({ installTunnel: () => false, ...options });
const LOOP = 'localhost,127.0.0.1,::1,[::1]';

test.afterEach(() => resetEnvProxyForTests());

test('no proxy variable: nothing to follow', () => {
  const env = { PATH: '/bin', HTTPS_PROXY: '  ' };
  const httpModule = fakeHttp();
  assert.deepEqual(setup({ env, versions: NODE_24, execArgv: [], httpModule }), { state: 'none' });
  assert.deepEqual(httpModule.calls, []);
  assert.equal(envProxyBlock(), null);
});

test('reads all four spellings in Node/Claude Code order', () => {
  assert.deepEqual(
    proxyVariables({ http_proxy: 'http://a:1', HTTPS_PROXY: 'http://b:2', HTTP_PROXY: '' }).map(v => v.name),
    ['HTTPS_PROXY', 'http_proxy'],
  );
});

test('the runtime gets the chosen proxies directly; the environment is never changed', () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:7890' };
  const before = { ...env };
  const httpModule = fakeHttp();
  assert.equal(setup({ env, versions: NODE_24, execArgv: [], httpModule }).state, 'active');
  assert.deepEqual(httpModule.calls, [{ HTTPS_PROXY: 'http://127.0.0.1:7890', HTTP_PROXY: undefined, NO_PROXY: LOOP }]);
  assert.deepEqual(env, before);
  assert.equal(envProxyBlock(), null);
});

test('a value without a scheme is read as http://, as curl does', () => {
  const env = { https_proxy: '127.0.0.1:7890', NO_PROXY: 'corp.example' };
  const httpModule = fakeHttp();
  setup({ env, versions: NODE_24, execArgv: [], httpModule });
  assert.equal(httpModule.calls[0].HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(httpModule.calls[0].NO_PROXY, `corp.example,${LOOP}`);
  assert.equal(env.https_proxy, '127.0.0.1:7890');
});

test('the bypass list Node would use (lowercase wins), plus loopback; * stays *', () => {
  assert.equal(mergedNoProxy({ no_proxy: 'corp.invalid' }), `corp.invalid,${LOOP}`);
  assert.equal(mergedNoProxy({ NO_PROXY: 'upper.invalid', no_proxy: '' }), `upper.invalid,${LOOP}`);
  assert.equal(mergedNoProxy({ NO_PROXY: 'a', no_proxy: 'b' }), `b,${LOOP}`);
  // A lowercase list overriding an inherited uppercase `*`: Node follows the
  // lowercase one, so vendor hosts keep going through the proxy.
  assert.equal(mergedNoProxy({ NO_PROXY: '*', no_proxy: 'localhost' }), `localhost,127.0.0.1,::1,[::1]`);
  assert.equal(mergedNoProxy({ no_proxy: '*' }), '*');
  assert.equal(mergedNoProxy({}), LOOP);
});

test('each scheme takes its own variable, then ALL_PROXY, as curl does', () => {
  assert.deepEqual(chosenProxies({ http_proxy: 'http://a:1', ALL_PROXY: 'socks5h://b:2' }), {
    https: { name: 'ALL_PROXY', value: 'socks5h://b:2' },
    http: { name: 'http_proxy', value: 'http://a:1' },
  });
  // An HTTP_PROXY alone also covers https (Node's fetch already does that).
  assert.deepEqual(chosenProxies({ HTTP_PROXY: 'http://a:1' }).https, { name: 'HTTP_PROXY', value: 'http://a:1' });
});

test('http_proxy plus a SOCKS ALL_PROXY: https would go through SOCKS, so blocked', () => {
  const env = { http_proxy: 'http://a:1', ALL_PROXY: 'socks5h://b:2' };
  assert.equal(setup({ env, versions: NODE_24, execArgv: [], httpModule: fakeHttp() }).state, 'socks');
});

test('ALL_PROXY alone: SOCKS blocks; HTTP is followed only where the runtime can be told', () => {
  assert.equal(setup({
    env: { all_proxy: 'socks5://127.0.0.1:7891' }, versions: NODE_24, execArgv: [], httpModule: fakeHttp(),
  }).state, 'socks');
  const httpModule = fakeHttp();
  assert.equal(setup({
    env: { ALL_PROXY: 'http://127.0.0.1:7890' }, versions: NODE_24, execArgv: [], httpModule,
  }).state, 'active');
  assert.deepEqual(httpModule.calls[0], { HTTPS_PROXY: 'http://127.0.0.1:7890', HTTP_PROXY: 'http://127.0.0.1:7890', NO_PROXY: LOOP });
  // Startup switch only: Node never read ALL_PROXY, so it is not followed.
  assert.equal(setup({
    env: { ALL_PROXY: 'http://127.0.0.1:7890', NODE_USE_ENV_PROXY: '1' }, versions: { node: '22.23.1' }, execArgv: [], httpModule: {},
  }).state, 'unsupported');
});

test('SOCKS cannot be followed by Node https, so vendor requests are blocked', () => {
  for (const value of ['socks5://127.0.0.1:7891', 'SOCKS5H://127.0.0.1:7891', 'socks://h:1']) {
    const env = { HTTPS_PROXY: value };
    const httpModule = fakeHttp();
    assert.equal(setup({ env, versions: NODE_24, execArgv: [], httpModule }).state, 'socks');
    assert.deepEqual(httpModule.calls, []);
    const block = envProxyBlock();
    assert.equal(block.reason, 'socks');
    assert.match(block.notice, /SOCKS.*为避免直连已跳过/);
  }
});

test('an invalid value that the runtime rejects blocks instead of going direct', () => {
  const env = { HTTPS_PROXY: 'http://[bad' };
  assert.equal(setup({ env, versions: NODE_24, execArgv: [], httpModule: fakeHttp({ throws: true }) }).state, 'unsupported');
  assert.equal(envProxyBlock().reason, 'unsupported');
});

test('without setGlobalProxyFromEnv the startup switch decides, by Node version', () => {
  const run = (node, { flag = '1', execArgv = [], NODE_OPTIONS, value = 'http://p:1' } = {}) => setup({
    env: { HTTPS_PROXY: value, ...(flag ? { NODE_USE_ENV_PROXY: flag } : {}), ...(NODE_OPTIONS ? { NODE_OPTIONS } : {}) },
    versions: { node }, execArgv, httpModule: {},
  }).state;
  assert.equal(run('22.23.1'), 'active');               // the Windows app's bundled Node
  assert.equal(run('22.19.0'), 'unsupported');          // switch did not exist yet
  assert.equal(run('24.4.0'), 'unsupported');
  assert.equal(run('24.5.0'), 'active');
  assert.equal(run('20.18.0'), 'unsupported');
  assert.equal(run('22.23.1', { flag: null }), 'unsupported');
  assert.equal(run('22.23.1', { flag: null, execArgv: ['--use-env-proxy'] }), 'active');
  assert.equal(run('22.23.1', { flag: null, NODE_OPTIONS: '--max-old-space-size=1 --use-env-proxy' }), 'active');
  assert.equal(run('22.23.1', { value: '127.0.0.1:7890' }), 'unsupported'); // Node read it without a scheme
  assert.equal(nodeHonoursEnvProxyFlag('26.0.0'), true);
  assert.equal(nodeHonoursEnvProxyFlag('23.11.0'), false);
});

test('Bun follows the proxy variables it read itself', () => {
  const bun = { bun: '1.3.14', node: '24.3.0' };
  assert.equal(setup({ env: { HTTPS_PROXY: 'http://p:1' }, versions: bun, execArgv: [], httpModule: {} }).state, 'active');
  assert.equal(setup({ env: { ALL_PROXY: 'http://p:1' }, versions: bun, execArgv: [], httpModule: {} }).state, 'unsupported');
  // Bun's https requests read only HTTPS_PROXY.
  assert.equal(setup({ env: { HTTP_PROXY: 'http://p:1' }, versions: bun, execArgv: [], httpModule: {} }).state, 'unsupported');
});

// The real runtime running this suite (CI: Node 20 / 22 / 24): with a proxy
// configured, both request paths reach the proxy wherever the runtime can
// follow it, and vendor requests are blocked where it cannot — never direct.
// The stand-in proxy answers 502 and connects nowhere.
async function runChild(t, extraEnv) {
  const seen = [];
  const proxy = net.createServer(socket => {
    socket.once('data', data => {
      seen.push(data.toString().split('\r\n')[0]);
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => proxy.close());
  const port = proxy.address().port;
  const moduleUrl = new URL('../src/env-proxy.js', import.meta.url).href;
  const script = `
    import https from 'node:https';
    const { setupEnvProxy } = await import(${JSON.stringify(moduleUrl)});
    const { state } = setupEnvProxy();
    const out = { state };
    if (state === 'active' || state === 'tunnel') {
      out.https = await new Promise(res => {
        const req = https.get('https://https-path.vibe-usage-proxy-test.invalid/', r => { r.resume(); res('status ' + r.statusCode); });
        req.on('error', e => res('error ' + (e.code || e.message)));
      });
      try { const r = await fetch('https://fetch-path.vibe-usage-proxy-test.invalid/'); out.fetch = 'status ' + r.status; }
      catch (e) { out.fetch = 'error ' + (e.cause?.code || e.message); }
    }
    console.log(JSON.stringify(out));
  `;
  const env = { ...process.env };
  for (const name of ['NODE_USE_ENV_PROXY', 'NODE_OPTIONS', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy',
    'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) delete env[name];
  Object.assign(env, extraEnv(port));
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env });
    const timer = setTimeout(() => { child.kill(); reject(new Error('child timed out')); }, 20_000);
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; });
    child.on('error', reject);
    child.on('close', () => { clearTimeout(timer); resolve(text); });
  });
  return { out: JSON.parse(stdout.trim().split('\n').pop()), seen };
}

// Either the runtime follows the proxy itself (`active`) or our tunnel takes
// over (`tunnel`); both reach the stand-in proxy, never the target directly.
function assertFollowed({ out, seen }, runtimeFollows) {
  assert.equal(out.state, runtimeFollows ? 'active' : 'tunnel', `Node ${process.version}: ${JSON.stringify(out)}`);
  assert.ok(seen.includes('CONNECT https-path.vibe-usage-proxy-test.invalid:443 HTTP/1.1'), `https: ${JSON.stringify(seen)}`);
  assert.ok(seen.includes('CONNECT fetch-path.vibe-usage-proxy-test.invalid:443 HTTP/1.1'), `fetch: ${JSON.stringify(seen)}`);
}

const canSetAtRuntime = typeof http.setGlobalProxyFromEnv === 'function';

test('on this runtime: a terminal-style proxy variable (no switch, no scheme)', async (t) => {
  assertFollowed(await runChild(t, port => ({ HTTPS_PROXY: `127.0.0.1:${port}` })), canSetAtRuntime);
});

test('on this runtime: only ALL_PROXY plus the switch (Node never reads ALL_PROXY)', async (t) => {
  const result = await runChild(t, port => ({ ALL_PROXY: `http://127.0.0.1:${port}`, NODE_USE_ENV_PROXY: '1' }));
  assertFollowed(result, canSetAtRuntime);
});

test('on this runtime: the Windows app style (full URL plus NODE_USE_ENV_PROXY=1)', async (t) => {
  const result = await runChild(t, port => ({
    HTTPS_PROXY: `http://127.0.0.1:${port}`, HTTP_PROXY: `http://127.0.0.1:${port}`, NODE_USE_ENV_PROXY: '1',
  }));
  assertFollowed(result, canSetAtRuntime || nodeHonoursEnvProxyFlag(process.versions.node));
});

test('quota providers that carry a vendor credential are not run while blocked', async (t) => {
  const { fetchQuotaProducts } = await import('../src/quotas/registry.js');
  const block = envProxyBlock('socks');
  const home = mkdtempSync(join(tmpdir(), 'vibe-usage-env-proxy-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const envelope = await fetchQuotaProducts(['kimi-code', 'zcode', 'opencode-go', 'cursor'], {
    envProxyBlock: block,
    fetchImpl: () => { throw new Error('must not reach the network'); },
    home,
    environment: { HOME: home, VIBE_USAGE_QUOTA_CACHE_DIR: join(home, 'quota-cache'), Z_AI_API_KEY: 'test-key' },
  });
  for (const product of envelope.products) {
    assert.equal(product.status, 'unsupported', product.id);
    assert.equal(product.message, block.message);
  }
});

test('a request on the bypass list is the user\'s own direct rule', () => {
  const env = { no_proxy: 'api.kimi.com,.bigmodel.cn,*.example.com,corp.example:8080,[::1]:9000,10.0.0.1' };
  assert.equal(noProxyMatches('https://api.kimi.com/coding/v1/usages', env), true);
  assert.equal(noProxyMatches('https://open.bigmodel.cn/api', env), true);
  assert.equal(noProxyMatches('https://bigmodel.cn/', env), false);
  assert.equal(noProxyMatches('https://a.example.com/', env), true);
  assert.equal(noProxyMatches('https://example.com/', env), false);
  assert.equal(noProxyMatches('http://corp.example:8080/', env), true);
  assert.equal(noProxyMatches('https://cursor.com/', env), false);
  assert.equal(noProxyMatches('http://[::1]:9000/', env), true);
  assert.equal(noProxyMatches('http://[::1]:9001/', env), false);
  assert.equal(noProxyMatches('https://10.0.0.1/', env), true);
  assert.equal(noProxyMatches('https://anything/', { NO_PROXY: '*' }), true);
  assert.equal(envProxyBlockFor(['https://api.kimi.com/'], { env, state: 'socks' }), null);
  assert.equal(envProxyBlockFor(['https://api.kimi.com/', 'https://cursor.com/'], { env, state: 'socks' }).reason, 'socks');
  assert.equal(envProxyBlockFor(['https://cursor.com/'], { env, state: 'active' }), null);
});

test('a bypass entry with a port covers that port only', () => {
  const env = { NO_PROXY: 'api.z.ai:8080' };
  assert.equal(noProxyMatches('https://api.z.ai/api/monitor/usage/quota/limit', env), false);
  assert.equal(noProxyMatches('https://api.z.ai:8080/', env), true);
  assert.equal(envProxyBlockFor(['https://api.z.ai/'], { env, state: 'socks' }).reason, 'socks');
});

test('a bare domain on the bypass list covers itself, not its subdomains', () => {
  // The fetch in Node 22 reads `kimi.com` as that host only; reading it wider
  // would let a request go direct that the user did not exempt.
  const env = { NO_PROXY: 'kimi.com' };
  assert.equal(noProxyMatches('https://kimi.com/', env), true);
  assert.equal(noProxyMatches('https://api.kimi.com/', env), false);
});

test('the guard checks the addresses the provider will actually use', async (t) => {
  const { fetchQuotaProducts } = await import('../src/quotas/registry.js');
  const home = mkdtempSync(join(tmpdir(), 'vibe-usage-env-proxy-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  setup({ env: { HTTPS_PROXY: 'socks5://127.0.0.1:7891' }, versions: NODE_24, execArgv: [], httpModule: fakeHttp() });
  const base = { HOME: home, VIBE_USAGE_QUOTA_CACHE_DIR: join(home, 'quota-cache') };
  const run = async (ids, environment) => Object.fromEntries((await fetchQuotaProducts(ids, {
    fetchImpl: () => { throw new Error('no network in tests'); }, home, environment: { ...base, ...environment },
  })).products.map(product => [product.id, product.status]));
  // Kimi with its login server moved elsewhere: exempting the default hosts
  // is not enough.
  assert.equal((await run(['kimi-code'], {
    KIMI_CODE_OAUTH_HOST: 'https://login.example.net', NO_PROXY: 'api.kimi.com,auth.kimi.com',
  }))['kimi-code'], 'unsupported');
  // A whitespace-only BigModel key falls back to Z.ai, like the read itself.
  assert.equal((await run(['zcode'], {
    BIGMODEL_API_KEY: '  ', Z_AI_API_KEY: 'test-key', NO_PROXY: 'open.bigmodel.cn',
  })).zcode, 'unsupported');
  assert.notEqual((await run(['zcode'], {
    BIGMODEL_API_KEY: '  ', Z_AI_API_KEY: 'test-key', NO_PROXY: 'api.z.ai',
  })).zcode, 'unsupported');
  // No key: nothing is requested, so nothing is blocked.
  assert.equal((await run(['zcode'], {})).zcode, 'missing_credentials');
});

// A PAC that sends domestic hosts direct and the rest through SOCKS (the
// desktop apps put the direct hosts in NO_PROXY): domestic providers keep
// working, foreign ones are not sent.
test('SOCKS blocks only the providers whose hosts are not bypassed', async (t) => {
  const { fetchQuotaProducts } = await import('../src/quotas/registry.js');
  const home = mkdtempSync(join(tmpdir(), 'vibe-usage-env-proxy-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  setup({ env: { HTTPS_PROXY: 'socks5://127.0.0.1:7891' }, versions: NODE_24, execArgv: [], httpModule: fakeHttp() });
  const envelope = await fetchQuotaProducts(['kimi-code', 'cursor'], {
    fetchImpl: () => { throw new Error('no network in tests'); },
    home,
    environment: {
      HOME: home, VIBE_USAGE_QUOTA_CACHE_DIR: join(home, 'quota-cache'),
      NO_PROXY: 'localhost,127.0.0.1,::1,api.kimi.com,auth.kimi.com',
    },
  });
  const byId = Object.fromEntries(envelope.products.map(product => [product.id, product]));
  assert.notEqual(byId['kimi-code'].status, 'unsupported');
  assert.equal(byId.cursor.status, 'unsupported');
});

// --- Our own tunnel (SOCKS5, HTTP CONNECT) for what the runtime cannot follow.

test('proxy values the tunnel can speak', async () => {
  const { parseProxy } = await import('../src/proxy-tunnel.js');
  assert.deepEqual(parseProxy('socks5://127.0.0.1:7891'), { kind: 'socks5', host: '127.0.0.1', port: 7891, auth: undefined });
  assert.deepEqual(parseProxy('socks5h://u:p%40ss@proxy.lan'), { kind: 'socks5', host: 'proxy.lan', port: 1080, auth: { user: 'u', pass: 'p@ss' } });
  assert.deepEqual(parseProxy('127.0.0.1:7890'), { kind: 'http', host: '127.0.0.1', port: 7890, auth: undefined });
  assert.equal(parseProxy('https://proxy.lan:8443').kind, 'https');
  assert.equal(parseProxy('socks4://127.0.0.1:1080'), null);
  assert.equal(parseProxy('socks://127.0.0.1:1080'), null);
  assert.equal(parseProxy(''), null);
});

test('a SOCKS proxy on Node goes through the tunnel instead of being skipped', () => {
  let installed;
  const state = setupEnvProxy({
    env: { HTTPS_PROXY: 'socks5://127.0.0.1:7891', NO_PROXY: 'corp.example' },
    versions: NODE_24, execArgv: [], httpModule: fakeHttp(),
    installTunnel: options => { installed = options; return () => {}; },
  }).state;
  assert.equal(state, 'tunnel');
  assert.equal(envProxyBlock(), null);
  assert.deepEqual(installed.proxies, { https: 'socks5://127.0.0.1:7891', http: undefined });
  assert.equal(installed.bypass('127.0.0.1', 8080), true);
  assert.equal(installed.bypass('localhost', 443), true);
  assert.equal(installed.bypass('corp.example', 443), true);
  assert.equal(installed.bypass('api.kimi.com', 443), false);
  // What the tunnel cannot speak stays blocked.
  assert.equal(setupEnvProxy({ env: { HTTPS_PROXY: 'socks4://127.0.0.1:1080' }, versions: NODE_24, execArgv: [],
    httpModule: fakeHttp() }).state, 'socks');
  assert.ok(envProxyBlock());
});

const FIXTURE = new URL('./fixtures/proxy-tunnel/', import.meta.url);
const TARGET_HOST = 'tunnel-target.vibe-usage-proxy-test.invalid';

async function tunnelHarness(t, kind) {
  const { readFileSync } = await import('node:fs');
  const https = await import('node:https');
  const target = https.createServer({
    key: readFileSync(new URL('key.pem', FIXTURE)), cert: readFileSync(new URL('cert.pem', FIXTURE)),
  }, (req, res) => { res.setHeader('content-type', 'text/plain'); res.end(`ok ${req.method} ${req.url}`); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  t.after(() => target.close());
  const seen = [];
  const forward = (socket, host, port, reply) => {
    seen.push(`${host}:${port}`);
    const upstream = net.connect(target.address().port, '127.0.0.1', () => {
      socket.write(reply);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  };
  const proxy = net.createServer(socket => {
    if (kind === 'socks5') {
      socket.once('data', () => {
        socket.write(Buffer.from([5, 0]));
        socket.once('data', request => {
          const length = request[4];
          const host = request.subarray(5, 5 + length).toString();
          const port = request.readUInt16BE(5 + length);
          forward(socket, request[3] === 3 ? host : `type-${request[3]}`, port, Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        });
      });
    } else {
      socket.once('data', data => {
        const [, hostPort] = data.toString().split('\r\n')[0].split(' ');
        const [host, port] = hostPort.split(':');
        forward(socket, host, Number(port), 'HTTP/1.1 200 Connection Established\r\n\r\n');
      });
    }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => proxy.close());
  return { port: proxy.address().port, seen };
}

async function runTunnelChild(env) {
  const moduleUrl = new URL('../src/env-proxy.js', import.meta.url).href;
  const script = `
    import https from 'node:https';
    const { setupEnvProxy } = await import(${JSON.stringify(moduleUrl)});
    const out = { state: setupEnvProxy().state };
    try {
      const r = await fetch('https://${TARGET_HOST}/fetch?x=1', { method: 'POST', body: new URLSearchParams({ a: 'b' }) });
      out.fetch = r.status + ' ' + await r.text();
    } catch (e) { out.fetch = 'error ' + (e.cause?.code || e.message); }
    out.https = await new Promise(res => {
      const req = https.get('https://${TARGET_HOST}/https', r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(r.statusCode + ' ' + d)); });
      req.on('error', e => res('error ' + (e.code || e.message)));
    });
    console.log(JSON.stringify(out));
  `;
  const childEnv = { ...process.env };
  for (const name of ['NODE_USE_ENV_PROXY', 'NODE_OPTIONS', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy',
    'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) delete childEnv[name];
  Object.assign(childEnv, { NODE_EXTRA_CA_CERTS: fileURLToPath(new URL('cert.pem', FIXTURE)) }, env);
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: childEnv });
    const timer = setTimeout(() => { child.kill(); reject(new Error('child timed out')); }, 20_000);
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; });
    child.on('error', reject);
    child.on('close', () => { clearTimeout(timer); resolve(text); });
  });
  return JSON.parse(stdout.trim().split('\n').pop());
}

test('on this runtime: a SOCKS5 proxy is followed through the tunnel (fetch and https)', async (t) => {
  const { port, seen } = await tunnelHarness(t, 'socks5');
  const out = await runTunnelChild({ ALL_PROXY: `socks5://127.0.0.1:${port}` });
  assert.equal(out.state, 'tunnel', JSON.stringify(out));
  assert.equal(out.fetch, '200 ok POST /fetch?x=1', JSON.stringify(out));
  assert.equal(out.https, '200 ok GET /https', JSON.stringify(out));
  // The proxy got the host name, never a locally resolved address.
  assert.deepEqual(seen, [`${TARGET_HOST}:443`, `${TARGET_HOST}:443`]);
});

test('on this runtime: an HTTP proxy the runtime cannot follow goes through the tunnel', async (t) => {
  const { port, seen } = await tunnelHarness(t, 'connect');
  // ALL_PROXY is never read by Node itself.
  const out = await runTunnelChild({ ALL_PROXY: `http://127.0.0.1:${port}` });
  const runtimeFollows = typeof http.setGlobalProxyFromEnv === 'function';
  assert.equal(out.state, runtimeFollows ? 'active' : 'tunnel', JSON.stringify(out));
  assert.equal(out.fetch, '200 ok POST /fetch?x=1', JSON.stringify(out));
  assert.equal(out.https, '200 ok GET /https', JSON.stringify(out));
  assert.equal(seen.length, 2);
});

test('the startup switch alone counts only with HTTPS_PROXY (https uploads read nothing else)', () => {
  const node = { node: '22.21.0' };
  assert.equal(setup({ env: { HTTP_PROXY: 'http://p:1', NODE_USE_ENV_PROXY: '1' }, versions: node, execArgv: [],
    httpModule: {} }).state, 'unsupported');
  assert.equal(setup({ env: { HTTPS_PROXY: 'http://p:1', NODE_USE_ENV_PROXY: '1' }, versions: node, execArgv: [],
    httpModule: {} }).state, 'active');
  let installed;
  setupEnvProxy({ env: { HTTPS_PROXY: 'socks5://127.0.0.1:1' }, versions: NODE_24, execArgv: [], httpModule: fakeHttp(),
    installTunnel: options => { installed = options; return () => {}; } });
  assert.equal(installed.bypass('127.0.0.9', 80), true);
  assert.equal(installed.bypass('127.service.example', 443), false);
});

// In-process tunnel checks: a stand-in HTTP proxy that forwards absolute-form
// requests (plain HTTP targets) and CONNECT tunnels (https targets) to one
// local server, whatever host was asked for.
async function connectHarness(t, handler, { answer = true } = {}) {
  const target = http.createServer(handler);
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  t.after(() => { target.closeAllConnections(); target.close(); });
  const asked = [];
  const open = new Set();
  const proxy = http.createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    if (!answer) return; // accepts, never replies
    const url = new URL(req.url);
    // Its own agent: the global agent (and `agent: false`, a new one of its
    // class) is the tunnel under test.
    const upstream = http.request({ host: '127.0.0.1', port: target.address().port, method: req.method,
      path: url.pathname + url.search, headers: req.headers, agent: new http.Agent() }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
      response.on('aborted', () => res.destroy());
      response.on('error', () => res.destroy());
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  proxy.on('connection', socket => { open.add(socket); socket.on('close', () => open.delete(socket)); });
  proxy.on('connect', (req, socket) => {
    asked.push(`CONNECT ${req.url}`);
    if (!answer) return;
    const upstream = net.connect(target.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of open) socket.destroy(); proxy.closeAllConnections(); proxy.close(); });
  return { proxyURL: `http://127.0.0.1:${proxy.address().port}`, asked };
}

async function withTunnel(t, proxyURL, options = {}) {
  const { installProxyTunnel } = await import('../src/proxy-tunnel.js');
  const uninstall = installProxyTunnel({ proxies: { http: proxyURL, https: proxyURL }, bypass: () => false, ...options });
  t.after(() => uninstall());
}

test('a redirect to another site drops the credential; a body is never replayed there', async (t) => {
  const seen = [];
  const { proxyURL } = await connectHarness(t, (req, res) => {
    seen.push(`${req.headers.host} ${req.url} auth=${req.headers.authorization || '-'}`);
    if (req.url === '/same') { res.writeHead(302, { location: '/landed' }); res.end(); return; }
    if (req.url === '/away') { res.writeHead(302, { location: 'http://other.vibe-usage-proxy-test.invalid/landed' }); res.end(); return; }
    if (req.url === '/away-307') { res.writeHead(307, { location: 'http://other.vibe-usage-proxy-test.invalid/landed' }); res.end(); return; }
    res.end('ok');
  });
  await withTunnel(t, proxyURL);
  const headers = { authorization: 'Bearer test-token' };
  assert.equal(await (await fetch('http://api.vibe-usage-proxy-test.invalid/same', { headers })).text(), 'ok');
  assert.equal(await (await fetch('http://api.vibe-usage-proxy-test.invalid/away', { headers })).text(), 'ok');
  assert.deepEqual(seen, [
    'api.vibe-usage-proxy-test.invalid /same auth=Bearer test-token',
    'api.vibe-usage-proxy-test.invalid /landed auth=Bearer test-token',
    'api.vibe-usage-proxy-test.invalid /away auth=Bearer test-token',
    'other.vibe-usage-proxy-test.invalid /landed auth=-',
  ]);
  await assert.rejects(fetch('http://api.vibe-usage-proxy-test.invalid/away-307',
    { method: 'POST', headers, body: new URLSearchParams({ refresh_token: 'x' }) }), /cross-origin redirect/);
});

test('a proxy that accepts but never answers fails the request instead of hanging it', async (t) => {
  const { proxyURL, asked } = await connectHarness(t, (req, res) => res.end('never'), { answer: false });
  await withTunnel(t, proxyURL, { handshakeTimeoutMs: 300 });
  const started = Date.now();
  await assert.rejects(fetch('https://api.vibe-usage-proxy-test.invalid/'));
  assert.ok(Date.now() - started < 5000);
  assert.equal(asked.length, 1);
});

test('a compressed body cut off mid-way errors instead of never ending', async (t) => {
  const { gzipSync } = await import('node:zlib');
  const { randomBytes } = await import('node:crypto');
  const whole = gzipSync(randomBytes(64 * 1024));
  const { proxyURL } = await connectHarness(t, (req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(whole.length) });
    res.write(whole.subarray(0, 1000));
    setTimeout(() => res.socket.destroy(), 50);
  });
  await withTunnel(t, proxyURL);
  const response = await fetch('http://api.vibe-usage-proxy-test.invalid/');
  await assert.rejects(response.text());
});

test('a form body arrives intact through the tunnel', async (t) => {
  const { proxyURL } = await connectHarness(t, (req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => res.end(`${req.headers['content-type']}|${body}`));
  });
  await withTunnel(t, proxyURL);
  const text = await (await fetch('http://api.vibe-usage-proxy-test.invalid/token', {
    method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', a: 'b c' }),
  })).text();
  assert.equal(text, 'application/x-www-form-urlencoded;charset=UTF-8|grant_type=refresh_token&a=b+c');
});

test('plain HTTP through an HTTP proxy uses the absolute-form request, not CONNECT', async (t) => {
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} auth=${req.headers['proxy-authorization'] || '-'} host=${req.headers.host}`);
    req.resume();
    res.end('via proxy');
  });
  proxy.on('connect', (req, socket) => { seen.push(`CONNECT ${req.url}`); socket.destroy(); });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  const { installProxyTunnel } = await import('../src/proxy-tunnel.js');
  const port = proxy.address().port;
  const uninstall = installProxyTunnel({ proxies: { http: `http://u:p@127.0.0.1:${port}` }, bypass: () => false });
  t.after(() => uninstall());
  assert.equal(await (await fetch('http://doctor-target.invalid/api/usage/settings')).text(), 'via proxy');
  const viaRequest = await new Promise((resolve, reject) => {
    http.get('http://doctor-registry.invalid:8080/-/ping', r => { let d = ''; r.on('data', c => { d += c; }); r.on('end', () => resolve(d)); })
      .on('error', reject);
  });
  assert.equal(viaRequest, 'via proxy');
  const auth = `Basic ${Buffer.from('u:p').toString('base64')}`;
  assert.deepEqual(seen, [
    `GET http://doctor-target.invalid/api/usage/settings auth=${auth} host=doctor-target.invalid`,
    `GET http://doctor-registry.invalid:8080/-/ping auth=${auth} host=doctor-registry.invalid:8080`,
  ]);
});

test('a proxy that never answers is closed, not left holding a socket', async (t) => {
  const closed = [];
  const proxy = net.createServer(socket => {
    socket.on('data', () => {}); // never answers
    socket.on('close', () => closed.push('closed'));
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => proxy.close());
  const { installProxyTunnel } = await import('../src/proxy-tunnel.js');
  const uninstall = installProxyTunnel({ proxies: { https: `http://127.0.0.1:${proxy.address().port}` },
    bypass: () => false, handshakeTimeoutMs: 200 });
  t.after(() => uninstall());
  await assert.rejects(fetch('https://api.vibe-usage-proxy-test.invalid/'), error => {
    const code = error.code || error.cause?.code;
    return code === 'ETIMEDOUT' || /timed out/.test(String(error.cause?.message || error.message));
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(closed, ['closed']);
});

test('a hop from a bypassed site to another goes back through the proxy', async (t) => {
  const seen = [];
  const { proxyURL, asked } = await connectHarness(t, (req, res) => {
    seen.push(req.url);
    res.end('landed');
  });
  const direct = http.createServer((req, res) => {
    res.writeHead(302, { location: 'http://api.vibe-usage-proxy-test.invalid/landed' });
    res.end();
  });
  await new Promise(resolve => direct.listen(0, '127.0.0.1', resolve));
  t.after(() => { direct.closeAllConnections(); direct.close(); });
  const { installProxyTunnel } = await import('../src/proxy-tunnel.js');
  const uninstall = installProxyTunnel({ proxies: { http: proxyURL }, bypass: host => host === '127.0.0.1' });
  t.after(() => uninstall());
  const text = await (await fetch(`http://127.0.0.1:${direct.address().port}/start`)).text();
  assert.equal(text, 'landed');
  assert.deepEqual(asked, ['GET http://api.vibe-usage-proxy-test.invalid/landed']);
  assert.deepEqual(seen, ['/landed']);
});
