import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const LOOP = 'localhost,127.0.0.1,::1,[::1]';

test.afterEach(() => resetEnvProxyForTests());

test('no proxy variable: nothing to follow', () => {
  const env = { PATH: '/bin', HTTPS_PROXY: '  ' };
  const httpModule = fakeHttp();
  assert.deepEqual(setupEnvProxy({ env, versions: NODE_24, execArgv: [], httpModule }), { state: 'none' });
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
  assert.equal(setupEnvProxy({ env, versions: NODE_24, execArgv: [], httpModule }).state, 'active');
  assert.deepEqual(httpModule.calls, [{ HTTPS_PROXY: 'http://127.0.0.1:7890', HTTP_PROXY: undefined, NO_PROXY: LOOP }]);
  assert.deepEqual(env, before);
  assert.equal(envProxyBlock(), null);
});

test('a value without a scheme is read as http://, as curl does', () => {
  const env = { https_proxy: '127.0.0.1:7890', NO_PROXY: 'corp.example' };
  const httpModule = fakeHttp();
  setupEnvProxy({ env, versions: NODE_24, execArgv: [], httpModule });
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
  assert.equal(setupEnvProxy({ env, versions: NODE_24, execArgv: [], httpModule: fakeHttp() }).state, 'socks');
});

test('ALL_PROXY alone: SOCKS blocks; HTTP is followed only where the runtime can be told', () => {
  assert.equal(setupEnvProxy({
    env: { all_proxy: 'socks5://127.0.0.1:7891' }, versions: NODE_24, execArgv: [], httpModule: fakeHttp(),
  }).state, 'socks');
  const httpModule = fakeHttp();
  assert.equal(setupEnvProxy({
    env: { ALL_PROXY: 'http://127.0.0.1:7890' }, versions: NODE_24, execArgv: [], httpModule,
  }).state, 'active');
  assert.deepEqual(httpModule.calls[0], { HTTPS_PROXY: 'http://127.0.0.1:7890', HTTP_PROXY: 'http://127.0.0.1:7890', NO_PROXY: LOOP });
  // Startup switch only: Node never read ALL_PROXY, so it is not followed.
  assert.equal(setupEnvProxy({
    env: { ALL_PROXY: 'http://127.0.0.1:7890', NODE_USE_ENV_PROXY: '1' }, versions: { node: '22.23.1' }, execArgv: [], httpModule: {},
  }).state, 'unsupported');
});

test('SOCKS cannot be followed by Node https, so vendor requests are blocked', () => {
  for (const value of ['socks5://127.0.0.1:7891', 'SOCKS5H://127.0.0.1:7891', 'socks://h:1']) {
    const env = { HTTPS_PROXY: value };
    const httpModule = fakeHttp();
    assert.equal(setupEnvProxy({ env, versions: NODE_24, execArgv: [], httpModule }).state, 'socks');
    assert.deepEqual(httpModule.calls, []);
    const block = envProxyBlock();
    assert.equal(block.reason, 'socks');
    assert.match(block.notice, /SOCKS.*为避免直连已跳过/);
  }
});

test('an invalid value that the runtime rejects blocks instead of going direct', () => {
  const env = { HTTPS_PROXY: 'http://[bad' };
  assert.equal(setupEnvProxy({ env, versions: NODE_24, execArgv: [], httpModule: fakeHttp({ throws: true }) }).state, 'unsupported');
  assert.equal(envProxyBlock().reason, 'unsupported');
});

test('without setGlobalProxyFromEnv the startup switch decides, by Node version', () => {
  const run = (node, { flag = '1', execArgv = [], NODE_OPTIONS, value = 'http://p:1' } = {}) => setupEnvProxy({
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
  assert.equal(setupEnvProxy({ env: { HTTPS_PROXY: 'http://p:1' }, versions: bun, execArgv: [], httpModule: {} }).state, 'active');
  assert.equal(setupEnvProxy({ env: { ALL_PROXY: 'http://p:1' }, versions: bun, execArgv: [], httpModule: {} }).state, 'unsupported');
  // Bun's https requests read only HTTPS_PROXY.
  assert.equal(setupEnvProxy({ env: { HTTP_PROXY: 'http://p:1' }, versions: bun, execArgv: [], httpModule: {} }).state, 'unsupported');
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
    if (state === 'active') {
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

function assertFollowedOrBlocked({ out, seen }, expectActive) {
  assert.equal(out.state, expectActive ? 'active' : 'unsupported', `Node ${process.version}: ${JSON.stringify(out)}`);
  if (expectActive) {
    assert.ok(seen.includes('CONNECT https-path.vibe-usage-proxy-test.invalid:443 HTTP/1.1'), `https: ${JSON.stringify(seen)}`);
    assert.ok(seen.includes('CONNECT fetch-path.vibe-usage-proxy-test.invalid:443 HTTP/1.1'), `fetch: ${JSON.stringify(seen)}`);
  } else {
    assert.ok(envProxyBlock('unsupported'));
  }
}

const canSetAtRuntime = typeof http.setGlobalProxyFromEnv === 'function';

test('on this runtime: a terminal-style proxy variable (no switch, no scheme)', async (t) => {
  assertFollowedOrBlocked(await runChild(t, port => ({ HTTPS_PROXY: `127.0.0.1:${port}` })), canSetAtRuntime);
});

test('on this runtime: only ALL_PROXY plus the switch (Node never reads ALL_PROXY)', async (t) => {
  const result = await runChild(t, port => ({ ALL_PROXY: `http://127.0.0.1:${port}`, NODE_USE_ENV_PROXY: '1' }));
  assertFollowedOrBlocked(result, canSetAtRuntime);
});

test('on this runtime: the Windows app style (full URL plus NODE_USE_ENV_PROXY=1)', async (t) => {
  const result = await runChild(t, port => ({
    HTTPS_PROXY: `http://127.0.0.1:${port}`, HTTP_PROXY: `http://127.0.0.1:${port}`, NODE_USE_ENV_PROXY: '1',
  }));
  assertFollowedOrBlocked(result, canSetAtRuntime || nodeHonoursEnvProxyFlag(process.versions.node));
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
  setupEnvProxy({ env: { HTTPS_PROXY: 'socks5://127.0.0.1:7891' }, versions: NODE_24, execArgv: [], httpModule: fakeHttp() });
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
  setupEnvProxy({ env: { HTTPS_PROXY: 'socks5://127.0.0.1:7891' }, versions: NODE_24, execArgv: [], httpModule: fakeHttp() });
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
