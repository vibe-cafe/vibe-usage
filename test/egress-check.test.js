import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EGRESS_GATED_PRODUCTS, egressPauseFor, fetchTraceRegion, networkFingerprint, ownRouteFor, routeFor, traceRegion,
} from '../src/egress-check.js';
import { fetchQuotaProducts } from '../src/quotas/registry.js';
import { quotaResult } from '../src/quotas/schema.js';

function cacheDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-egress-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tracer(answers) {
  const calls = [];
  const trace = async host => {
    calls.push(host);
    const answer = typeof answers === 'function' ? answers(host, calls.length) : answers;
    return answer;
  };
  return { trace, calls };
}

const NOW = new Date('2026-11-24T12:00:00Z');

test('traceRegion reads only a two-letter loc= line', () => {
  assert.equal(traceRegion('fl=1\nh=chatgpt.com\nip=203.0.113.9\nloc=US\ntls=TLSv1.3\n'), 'US');
  assert.equal(traceRegion('loc=cn\n'), 'CN');
  assert.equal(traceRegion('loc=XX\n'), null);
  assert.equal(traceRegion('loc=T1\n'), null);
  assert.equal(traceRegion('loc=USA\n'), null);
  assert.equal(traceRegion('colo=HKG\n'), null);
  assert.equal(traceRegion(''), null);
});

test('routeFor reads the proxy as agy does, ownRouteFor as the CLI does', () => {
  assert.equal(routeFor('https://chatgpt.com/', {}), 'direct');
  assert.equal(routeFor('https://chatgpt.com/', { HTTPS_PROXY: 'http://127.0.0.1:7890' }), 'proxy');
  // agy takes neither for https: it would go direct, so it is checked.
  assert.equal(routeFor('https://chatgpt.com/', { ALL_PROXY: 'socks5h://127.0.0.1:7891' }), 'direct');
  assert.equal(routeFor('https://chatgpt.com/', { HTTP_PROXY: 'http://127.0.0.1:7890' }), 'direct');
  // The CLI's own requests follow both, and read a bare bypass entry narrowly.
  assert.equal(ownRouteFor('https://chatgpt.com/', { ALL_PROXY: 'socks5h://127.0.0.1:7891' }), 'proxy');
  assert.equal(ownRouteFor('https://chatgpt.com/', { HTTP_PROXY: 'http://127.0.0.1:7890' }), 'proxy');
  assert.equal(ownRouteFor('https://api.anthropic.com/', {
    HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'anthropic.com',
  }), 'proxy');
  assert.equal(routeFor('https://daily-cloudcode-pa.googleapis.com/', {
    HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: '.googleapis.com',
  }), 'direct');
  // Read broadly: agy takes a bare domain for its subdomains too.
  for (const list of ['googleapis.com', '*.googleapis.com:443', 'localhost, googleapis.com', '*']) {
    assert.equal(routeFor('https://daily-cloudcode-pa.googleapis.com/', {
      HTTPS_PROXY: 'http://127.0.0.1:7890', no_proxy: list,
    }), 'direct', list);
  }
  assert.equal(routeFor('https://daily-cloudcode-pa.googleapis.com/', {
    HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'notgoogleapis.com',
  }), 'proxy');
});

test('a product whose hosts all go through a proxy is never checked', async t => {
  const { trace, calls } = tracer('CN');
  const environment = { HTTPS_PROXY: 'http://127.0.0.1:7890', VIBE_USAGE_QUOTA_CACHE_DIR: cacheDir(t) };
  assert.equal(await egressPauseFor('antigravity', { environment, now: NOW, trace, fingerprint: 'a' }), null);
  assert.deepEqual(calls, []);
});

test('products that do not pause are never checked', async t => {
  const { trace, calls } = tracer('CN');
  const environment = { VIBE_USAGE_QUOTA_CACHE_DIR: cacheDir(t) };
  for (const id of ['cursor', 'kimi-code', 'zcode', 'opencode-go']) {
    assert.equal(await egressPauseFor(id, { environment, now: NOW, trace, fingerprint: 'a' }), null);
  }
  assert.deepEqual(calls, []);
});

test('a direct read pauses for an unsupported egress and goes ahead for a supported one', async t => {
  for (const [region, expected] of [
    ['US', null],
    ['JP', null],
    ['CN', { pauseReason: 'egressRegionUnsupported', region: 'CN' }],
    ['HK', { pauseReason: 'egressRegionUnsupported', region: 'HK' }],
    ['MO', { pauseReason: 'egressRegionUnsupported', region: 'MO' }],
    [null, { pauseReason: 'egressUnconfirmed', region: undefined }],
  ]) {
    const { trace, calls } = tracer(region);
    const environment = { VIBE_USAGE_QUOTA_CACHE_DIR: cacheDir(t) };
    const result = await egressPauseFor('antigravity', { environment, now: NOW, trace, fingerprint: 'a' });
    assert.deepEqual(calls, ['chatgpt.com'], `${region}`);
    if (!expected) {
      assert.equal(result, null);
    } else {
      assert.equal(result.pauseReason, expected.pauseReason);
      assert.equal(result.region, expected.region);
      assert.match(result.message, /^Paused: /);
    }
  }
});

test('a bare bypass entry for Google with a proxy set still checks (and the manual setting still pauses)', async t => {
  const { trace, calls } = tracer('CN');
  const base = { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'googleapis.com,chatgpt.com', VIBE_USAGE_QUOTA_CACHE_DIR: cacheDir(t) };
  const paused = await egressPauseFor('antigravity', { environment: base, now: NOW, trace, fingerprint: 'a' });
  assert.equal(paused.pauseReason, 'egressRegionUnsupported');
  assert.deepEqual(calls, ['chatgpt.com']);
  const manual = await egressPauseFor('antigravity', {
    environment: { ...base, VIBE_USAGE_REQUIRE_PROXY: '1' }, now: NOW, trace, fingerprint: 'a',
  });
  assert.equal(manual.pauseReason, 'proxyNotDetected');
});

test('a proxy agy cannot use is no proxy; a stand-in the CLI would proxy is never sent direct', async t => {
  for (const variable of ['ALL_PROXY', 'HTTP_PROXY']) {
    const { trace, calls } = tracer('US');
    const environment = { [variable]: 'http://127.0.0.1:7890', VIBE_USAGE_QUOTA_CACHE_DIR: cacheDir(t) };
    // agy would go direct; both stand-ins go through the CLI's proxy.
    assert.equal((await egressPauseFor('antigravity', { environment, now: NOW, trace, fingerprint: 'a' })).pauseReason,
      'egressUnconfirmed', variable);
    assert.deepEqual(calls, []);
    assert.equal((await egressPauseFor('antigravity', {
      environment: { ...environment, VIBE_USAGE_REQUIRE_PROXY: '1' }, now: NOW, trace, fingerprint: 'a',
    })).pauseReason, 'proxyNotDetected', variable);
  }
  // Google direct by a broad entry; `anthropic.com` alone does not send the
  // CLI's own request to api.anthropic.com direct.
  const { trace, calls } = tracer('US');
  const result = await egressPauseFor('antigravity', {
    environment: { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: '.googleapis.com,anthropic.com', VIBE_USAGE_QUOTA_CACHE_DIR: cacheDir(t) },
    now: NOW, trace, fingerprint: 'a',
  });
  assert.equal(result.pauseReason, 'egressUnconfirmed');
  assert.deepEqual(calls, []);
});

test('the manual "relies on a local proxy" setting pauses a direct read without a check', async t => {
  const { trace, calls } = tracer('US');
  const environment = { VIBE_USAGE_REQUIRE_PROXY: '1', VIBE_USAGE_QUOTA_CACHE_DIR: cacheDir(t) };
  const result = await egressPauseFor('antigravity', { environment, now: NOW, trace, fingerprint: 'a' });
  assert.equal(result.pauseReason, 'proxyNotDetected');
  assert.deepEqual(calls, []);
  // With a proxy for the hosts it reads as usual.
  assert.equal(await egressPauseFor('antigravity', {
    environment: { ...environment, HTTPS_PROXY: 'http://127.0.0.1:7890' }, now: NOW, trace, fingerprint: 'a',
  }), null);
});

test('the check switched off sends a direct read as before, without a check', async t => {
  for (const value of ['0', 'false', 'off', 'NO']) {
    const { trace, calls } = tracer('CN');
    const environment = { VIBE_USAGE_EGRESS_CHECK: value, VIBE_USAGE_QUOTA_CACHE_DIR: cacheDir(t) };
    assert.equal(await egressPauseFor('antigravity', { environment, now: NOW, trace, fingerprint: 'a' }), null);
    assert.deepEqual(calls, []);
  }
});

test('the stand-in host must take the same direct route; a proxied one is never sent direct', async t => {
  const base = {
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    VIBE_USAGE_QUOTA_CACHE_DIR: cacheDir(t),
  };
  // Google direct by the user's rule, OpenAI and Anthropic through the proxy.
  let probe = tracer('US');
  let result = await egressPauseFor('antigravity', {
    environment: { ...base, NO_PROXY: '.googleapis.com' }, now: NOW, trace: probe.trace, fingerprint: 'a',
  });
  assert.equal(result.pauseReason, 'egressUnconfirmed');
  assert.deepEqual(probe.calls, []);
  // Anthropic direct as well: it stands in.
  probe = tracer('US');
  result = await egressPauseFor('antigravity', {
    environment: { ...base, NO_PROXY: '.googleapis.com,api.anthropic.com' }, now: NOW, trace: probe.trace, fingerprint: 'a',
  });
  assert.equal(result, null);
  assert.deepEqual(probe.calls, ['api.anthropic.com']);
});

test('answers are cached per network: 10 minutes when supported, 1 minute when paused', async t => {
  const environment = { VIBE_USAGE_QUOTA_CACHE_DIR: cacheDir(t) };
  const at = minutes => new Date(NOW.getTime() + minutes * 60 * 1000);
  let answer = 'US';
  const { trace, calls } = tracer(() => answer);
  const check = (minutes, fingerprint = 'net-a') => egressPauseFor('antigravity', {
    environment, now: at(minutes), trace, fingerprint,
  });

  assert.equal(await check(0), null);
  assert.equal(await check(9.9), null);
  assert.equal(calls.length, 1);
  // A different network (Wi-Fi switched, TUN adapter gone) asks again.
  answer = 'CN';
  assert.equal((await check(9.95, 'net-b')).region, 'CN');
  assert.equal(calls.length, 2);
  // A paused answer is kept only a minute, so a proxy turned on is seen soon.
  assert.equal((await check(10.5, 'net-b')).region, 'CN');
  assert.equal(calls.length, 2);
  answer = 'US';
  assert.equal(await check(11, 'net-b'), null);
  assert.equal(calls.length, 3);
  // Supported answers expire after 10 minutes.
  assert.equal(await check(21.5, 'net-b'), null);
  assert.equal(calls.length, 4);

  const file = join(environment.VIBE_USAGE_QUOTA_CACHE_DIR, 'egress-checks.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(saved.entries), ['chatgpt.com']);
  assert.deepEqual(Object.keys(saved.entries['chatgpt.com']).sort(), ['checkedAt', 'network', 'region']);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('a cache that cannot be read or written only costs another check', async t => {
  const dir = cacheDir(t);
  const environment = { VIBE_USAGE_QUOTA_CACHE_DIR: join(dir, 'file-not-dir') };
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'file-not-dir'), 'x');
  const { trace, calls } = tracer('US');
  assert.equal(await egressPauseFor('antigravity', { environment, now: NOW, trace, fingerprint: 'a' }), null);
  assert.equal(await egressPauseFor('antigravity', { environment, now: NOW, trace, fingerprint: 'a' }), null);
  assert.equal(calls.length, 2);
  assert.equal(existsSync(join(dir, 'egress-checks.json')), false);
});

test('networkFingerprint covers external addresses only and changes with them', () => {
  const lo = { address: '127.0.0.1', family: 'IPv4', internal: true };
  const wifi = { address: '192.168.1.20', family: 'IPv4', internal: false };
  const tun = { address: '198.18.0.1', family: 'IPv4', internal: false };
  const base = networkFingerprint({ lo0: [lo], en0: [wifi] });
  assert.equal(networkFingerprint({ en0: [wifi], lo0: [lo] }), base);
  assert.equal(networkFingerprint({ en0: [wifi] }), base);
  assert.notEqual(networkFingerprint({ lo0: [lo], en0: [wifi], utun4: [tun] }), base);
  const linkLocal = { address: 'fe80::1c2b:3cff:fe4d:5e6f', family: 'IPv6', internal: false };
  assert.equal(networkFingerprint({ lo0: [lo], en0: [wifi], awdl0: [linkLocal] }), base);
  assert.match(base, /^[0-9a-f]{16}$/);
});

function fakeHttps(respond) {
  const seen = [];
  class Agent { constructor(options) { this.options = options; } }
  const module = {
    Agent,
    globalAgent: new Agent({ proxy: 'global' }),
    request(options, onResponse) {
      seen.push(options);
      const request = new EventEmitter();
      request.destroyed = false;
      request.destroy = () => { request.destroyed = true; };
      request.end = () => setImmediate(() => respond(request, onResponse));
      return request;
    },
  };
  return { module, seen };
}

function response(statusCode, chunks) {
  const emitter = new EventEmitter();
  emitter.statusCode = statusCode;
  emitter.setEncoding = () => {};
  emitter.resume = () => {};
  setImmediate(() => {
    for (const chunk of chunks) emitter.emit('data', chunk);
    emitter.emit('end');
  });
  return emitter;
}

test('the trace request is anonymous, direct and bounded', async () => {
  const { module, seen } = fakeHttps((request, onResponse) => onResponse(response(200, ['h=x\n', 'loc=HK\n'])));
  assert.equal(await fetchTraceRegion('chatgpt.com', { httpsModule: module }), 'HK');
  const [options] = seen;
  assert.equal(options.host, 'chatgpt.com');
  assert.equal(options.port, 443);
  assert.equal(options.path, '/cdn-cgi/trace');
  assert.equal(options.method, 'GET');
  // Its own agent: not the global one an environment proxy or our tunnel sits on.
  assert.ok(options.agent instanceof module.Agent);
  assert.notEqual(options.agent, module.globalAgent);
  assert.deepEqual(options.headers, { accept: 'text/plain' });

  let destroyed;
  const status = fakeHttps((request, onResponse) => { destroyed = request; onResponse(response(403, ['loc=US\n'])); });
  assert.equal(await fetchTraceRegion('chatgpt.com', { httpsModule: status.module }), null);
  assert.equal(destroyed.destroyed, true);
  const failing = fakeHttps(request => request.emit('error', new Error('ECONNRESET')));
  assert.equal(await fetchTraceRegion('chatgpt.com', { httpsModule: failing.module }), null);
  const silent = fakeHttps(() => {});
  assert.equal(await fetchTraceRegion('chatgpt.com', { httpsModule: silent.module, timeoutMs: 20 }), null);
  const huge = fakeHttps((request, onResponse) => onResponse(response(200, ['x'.repeat(5000), '\nloc=US\n'])));
  assert.equal(await fetchTraceRegion('chatgpt.com', { httpsModule: huge.module }), null);
  const early = fakeHttps((request, onResponse) => onResponse(response(200, ['loc=US\n', 'x'.repeat(5000)])));
  assert.equal(await fetchTraceRegion('chatgpt.com', { httpsModule: early.module }), null);
});

test('quota fetch reports a pause as unsupported with its reason and starts nothing', async t => {
  const environment = { VIBE_USAGE_QUOTA_CACHE_DIR: cacheDir(t), ANTIGRAVITY_CLI_PATH: process.execPath };
  // Antigravity used here before, so a read is due and only the egress check stands in its way.
  const home = cacheDir(t);
  mkdirSync(join(home, '.gemini', 'antigravity-cli', 'conversations'), { recursive: true });
  writeFileSync(join(home, '.gemini', 'antigravity-cli', 'conversations', 'earlier.db'), 'used before');
  const started = [];
  const never = async () => { started.push('agy'); throw new Error('must not start'); };
  const { products: [region] } = await fetchQuotaProducts(['antigravity'], {
    environment, home, platform: 'linux', commandImpl: never, sessionImpl: never,
    egressPause: async id => (id === 'antigravity'
      ? { pauseReason: 'egressRegionUnsupported', region: 'CN', message: 'Paused: CN' } : null),
  });
  assert.equal(region.status, 'unsupported');
  assert.equal(region.pauseReason, 'egressRegionUnsupported');
  assert.equal(region.egressRegion, 'CN');
  assert.deepEqual(region.meters, []);

  // The built-in gate, through the environment the apps pass: nothing is sent.
  const { products: [manual] } = await fetchQuotaProducts(['antigravity'], {
    environment: { ...environment, VIBE_USAGE_REQUIRE_PROXY: '1' }, home, platform: 'linux',
    commandImpl: never, sessionImpl: never,
  });
  assert.equal(manual.status, 'unsupported');
  assert.equal(manual.pauseReason, 'proxyNotDetected');
  assert.equal(manual.egressRegion, undefined);
  assert.deepEqual(started, []);

  // Nothing installed: nothing would reach Google, so nothing is checked.
  let checked = 0;
  const { products: [missing] } = await fetchQuotaProducts(['antigravity'], {
    environment: { VIBE_USAGE_QUOTA_CACHE_DIR: environment.VIBE_USAGE_QUOTA_CACHE_DIR, PATH: '' },
    home: cacheDir(t), platform: 'linux', commandImpl: never, sessionImpl: never,
    egressPause: async () => { checked += 1; return { pauseReason: 'egressUnconfirmed', message: 'Paused' }; },
  });
  assert.equal(missing.status, 'missing_credentials');
  assert.equal(checked, 0);
});

test('Grok checks every xAI account route, preferring its own direct trace hosts', async t => {
  assert.deepEqual(EGRESS_GATED_PRODUCTS.grok, {
    urls: ['https://cli-chat-proxy.grok.com/', 'https://auth.x.ai/', 'https://api.x.ai/'],
    traceHosts: ['cli-chat-proxy.grok.com', 'api.x.ai'],
  });
  const HTTPS_PROXY = 'socks5://127.0.0.1:1080';
  for (const [env, expectedHost, reason] of [
    [{}, 'cli-chat-proxy.grok.com', 'egressRegionUnsupported'],
    [{ HTTPS_PROXY }, null, undefined],
    [{ HTTPS_PROXY, NO_PROXY: 'api.x.ai' }, 'api.x.ai', 'egressRegionUnsupported'],
    [{ HTTPS_PROXY, NO_PROXY: 'auth.x.ai,chatgpt.com' }, 'chatgpt.com', 'egressRegionUnsupported'],
    [{ ALL_PROXY: HTTPS_PROXY }, null, 'egressUnconfirmed'],
  ]) {
    const { trace, calls } = tracer('CN');
    const pause = await egressPauseFor('grok', {
      environment: { ...env, VIBE_USAGE_QUOTA_CACHE_DIR: cacheDir(t) }, trace, now: NOW, fingerprint: 'net',
    });
    assert.equal(pause?.pauseReason, reason);
    assert.deepEqual(calls, expectedHost ? [expectedHost] : []);
  }
});

test('Grok registry checks only an installed binary and a pause starts nothing', async t => {
  const home = cacheDir(t);
  const checks = [], spawns = [];
  const options = {
    home, environment: { HOME: home, PATH: home, VIBE_USAGE_QUOTA_CACHE_DIR: home }, now: NOW,
    spawnImpl: (...args) => { spawns.push(args); throw new Error('unexpected spawn'); },
    egressPause: async id => {
      checks.push(id);
      return { pauseReason: 'egressRegionUnsupported', region: 'HK', message: 'Paused in HK.' };
    },
  };
  const fetch = async () => (await fetchQuotaProducts(['grok'], options)).products[0];
  assert.equal((await fetch()).status, 'no_data');
  assert.deepEqual(checks, []);
  writeFileSync(join(home, process.platform === 'win32' ? 'grok.exe' : 'grok'), '', { mode: 0o700 });
  const paused = await fetch();
  assert.equal(paused.status, 'unsupported');
  assert.equal(paused.pauseReason, 'egressRegionUnsupported');
  assert.equal(paused.egressRegion, 'HK');
  assert.equal(paused.message, 'Paused in HK.');
  assert.deepEqual(checks, ['grok']);
  assert.deepEqual(spawns, []);
});

test('pauseReason is a closed vocabulary on unsupported and successful local reads', () => {
  const ok = quotaResult({ id: 'antigravity', status: 'unsupported', pauseReason: 'egressUnconfirmed', egressRegion: 'CN' });
  assert.equal(ok.pauseReason, 'egressUnconfirmed');
  assert.throws(() => quotaResult({ id: 'antigravity', status: 'unsupported', pauseReason: 'proxyChoicePending' }), /pauseReason/);
  assert.throws(() => quotaResult({ id: 'antigravity', status: 'no_data', pauseReason: 'egressUnconfirmed' }), /pauseReason/);
  const local = { id: 'grok', status: 'ok', source: 'local', pauseReason: 'egressRegionUnsupported', egressRegion: 'CN' };
  assert.equal(quotaResult(local).egressRegion, 'CN');
  assert.equal(quotaResult(local).pauseReason, local.pauseReason);
  for (const source of ['live', 'cache']) assert.throws(() => quotaResult({ ...local, source }), /pauseReason/);
  assert.throws(() => quotaResult({ ...local, status: 'retryable_error' }), /pauseReason/);
  assert.throws(() => quotaResult({ ...local, pauseReason: 'unknown' }), /pauseReason/);
  const odd = quotaResult({ id: 'antigravity', status: 'unsupported', pauseReason: 'egressRegionUnsupported', egressRegion: 'cn-x' });
  assert.equal(odd.egressRegion, undefined);
});
