import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import {
  envProxyBlock,
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
    setGlobalProxyFromEnv() {
      calls.push('set');
      if (throws) throw Object.assign(new Error('invalid'), { code: 'ERR_PROXY_INVALID_CONFIG' });
      return () => {};
    },
  };
}

test.afterEach(() => resetEnvProxyForTests());

test('no proxy variable: nothing to follow, environment untouched', () => {
  const env = { PATH: '/bin', HTTPS_PROXY: '  ' };
  const httpModule = fakeHttp();
  assert.deepEqual(setupEnvProxy({ env, versions: { node: '24.22.3' }, execArgv: [], httpModule }), { state: 'none' });
  assert.equal(env.NO_PROXY, undefined);
  assert.deepEqual(httpModule.calls, []);
  assert.equal(envProxyBlock(), null);
});

test('reads all four spellings in Node/Claude Code order', () => {
  assert.deepEqual(
    proxyVariables({ http_proxy: 'http://a:1', HTTPS_PROXY: 'http://b:2', HTTP_PROXY: '' }).map(v => v.name),
    ['HTTPS_PROXY', 'http_proxy'],
  );
});

test('an http proxy is turned on in-process where the runtime allows it', () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:7890' };
  const httpModule = fakeHttp();
  assert.equal(setupEnvProxy({ env, versions: { node: '24.22.3' }, execArgv: [], httpModule }).state, 'active');
  assert.deepEqual(httpModule.calls, ['set']);
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
  assert.equal(envProxyBlock(), null);
});

test('a value without a scheme is read as http://, as curl does', () => {
  const env = { https_proxy: '127.0.0.1:7890', NO_PROXY: 'corp.example' };
  setupEnvProxy({ env, versions: { node: '24.22.3' }, execArgv: [], httpModule: fakeHttp() });
  assert.equal(env.https_proxy, 'http://127.0.0.1:7890');
  assert.equal(env.NO_PROXY, 'corp.example,localhost,127.0.0.1,::1');
});

test('lowercase no_proxy (which Node prefers) also gets loopback; * is left alone', () => {
  const env = { HTTPS_PROXY: 'http://p:1', no_proxy: 'a.example', NO_PROXY: '*' };
  setupEnvProxy({ env, versions: { node: '24.22.3' }, execArgv: [], httpModule: fakeHttp() });
  assert.equal(env.no_proxy, 'a.example,localhost,127.0.0.1,::1');
  assert.equal(env.NO_PROXY, '*');
});

test('SOCKS cannot be followed by Node https, so vendor requests are blocked', () => {
  for (const value of ['socks5://127.0.0.1:7891', 'SOCKS5H://127.0.0.1:7891', 'socks://h:1']) {
    const env = { HTTPS_PROXY: 'http://p:1', ALL_PROXY: value, http_proxy: value };
    const httpModule = fakeHttp();
    assert.equal(setupEnvProxy({ env, versions: { node: '24.22.3' }, execArgv: [], httpModule }).state, 'socks');
    assert.deepEqual(httpModule.calls, []);
    const block = envProxyBlock();
    assert.equal(block.reason, 'socks');
    assert.match(block.notice, /SOCKS.*为避免直连已跳过/);
  }
});

test('an invalid value that the runtime rejects blocks instead of going direct', () => {
  const env = { HTTPS_PROXY: 'http://[bad' };
  assert.equal(setupEnvProxy({ env, versions: { node: '24.22.3' }, execArgv: [], httpModule: fakeHttp({ throws: true }) }).state, 'unsupported');
  assert.equal(envProxyBlock().reason, 'unsupported');
});

test('without setGlobalProxyFromEnv the startup switch decides, by Node version', () => {
  const run = (node, { flag = '1', execArgv = [], NODE_OPTIONS } = {}) => setupEnvProxy({
    env: { HTTPS_PROXY: 'http://p:1', ...(flag ? { NODE_USE_ENV_PROXY: flag } : {}), ...(NODE_OPTIONS ? { NODE_OPTIONS } : {}) },
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
  assert.equal(nodeHonoursEnvProxyFlag('26.0.0'), true);
  assert.equal(nodeHonoursEnvProxyFlag('23.11.0'), false);
});

test('Bun follows http proxies on its own', () => {
  assert.equal(setupEnvProxy({
    env: { HTTPS_PROXY: 'http://p:1' }, versions: { bun: '1.3.14', node: '24.3.0' }, execArgv: [], httpModule: {},
  }).state, 'active');
});

// The real runtime running this suite (CI: Node 20 / 22 / 24): with a proxy
// configured, every request either reaches the proxy or is blocked — never
// direct. The stand-in proxy answers 502 and connects nowhere.
test('on this runtime a configured proxy is followed or vendor requests are blocked', async (t) => {
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
        const req = https.get('https://vibe-usage-proxy-test.invalid/', r => { r.resume(); res('status ' + r.statusCode); });
        req.on('error', e => res('error ' + (e.code || e.message)));
      });
      try { const r = await fetch('https://vibe-usage-proxy-test.invalid/f'); out.fetch = 'status ' + r.status; }
      catch (e) { out.fetch = 'error ' + (e.cause?.code || e.message); }
    }
    console.log(JSON.stringify(out));
  `;
  const env = { ...process.env, HTTPS_PROXY: `127.0.0.1:${port}` };
  delete env.NODE_USE_ENV_PROXY;
  delete env.https_proxy; delete env.HTTP_PROXY; delete env.http_proxy; delete env.NO_PROXY; delete env.no_proxy;
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env });
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(text));
  });
  const out = JSON.parse(stdout.trim().split('\n').pop());
  if (out.state === 'active') {
    assert.equal(seen.filter(line => line.startsWith('CONNECT vibe-usage-proxy-test.invalid:443')).length, 2,
      `both https and fetch must reach the proxy (${JSON.stringify(out)})`);
  } else {
    assert.equal(out.state, 'unsupported', `unexpected state on Node ${process.version}`);
    assert.ok(envProxyBlock('unsupported'));
  }
});

test('quota providers that carry a vendor credential are not run while blocked', async () => {
  const { fetchQuotaProducts } = await import('../src/quotas/registry.js');
  const block = envProxyBlock('socks');
  const envelope = await fetchQuotaProducts(['kimi-code', 'zcode', 'opencode-go', 'cursor'], {
    envProxyBlock: block,
    fetchImpl: () => { throw new Error('must not reach the network'); },
    environment: { HOME: '/nonexistent-vibe-usage-test' },
  });
  for (const product of envelope.products) {
    assert.equal(product.status, 'unsupported', product.id);
    assert.equal(product.message, block.message);
  }
});
