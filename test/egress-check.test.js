import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  egressPauseFor, fetchTraceRegion, networkFingerprint, routeFor, traceRegion,
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

test('routeFor follows the environment proxy and its bypass list', () => {
  assert.equal(routeFor('https://chatgpt.com/', {}), 'direct');
  assert.equal(routeFor('https://chatgpt.com/', { HTTPS_PROXY: 'http://127.0.0.1:7890' }), 'proxy');
  assert.equal(routeFor('https://chatgpt.com/', { ALL_PROXY: 'socks5h://127.0.0.1:7891' }), 'proxy');
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
  for (const id of ['cursor', 'kimi-code', 'zcode', 'opencode-go', 'grok']) {
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
});

test('quota fetch reports a pause as unsupported with its reason and starts nothing', async t => {
  const environment = { VIBE_USAGE_QUOTA_CACHE_DIR: cacheDir(t), ANTIGRAVITY_CLI_PATH: process.execPath };
  const started = [];
  const never = async () => { started.push('agy'); throw new Error('must not start'); };
  const { products: [region] } = await fetchQuotaProducts(['antigravity'], {
    environment, platform: 'linux', commandImpl: never, sessionImpl: never,
    egressPause: async id => (id === 'antigravity'
      ? { pauseReason: 'egressRegionUnsupported', region: 'CN', message: 'Paused: CN' } : null),
  });
  assert.equal(region.status, 'unsupported');
  assert.equal(region.pauseReason, 'egressRegionUnsupported');
  assert.equal(region.egressRegion, 'CN');
  assert.deepEqual(region.meters, []);

  // The built-in gate, through the environment the apps pass: nothing is sent.
  const { products: [manual] } = await fetchQuotaProducts(['antigravity'], {
    environment: { ...environment, VIBE_USAGE_REQUIRE_PROXY: '1' }, platform: 'linux',
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

test('pauseReason is a closed vocabulary and only travels with unsupported', () => {
  const ok = quotaResult({ id: 'antigravity', status: 'unsupported', pauseReason: 'egressUnconfirmed', egressRegion: 'CN' });
  assert.equal(ok.pauseReason, 'egressUnconfirmed');
  assert.throws(() => quotaResult({ id: 'antigravity', status: 'unsupported', pauseReason: 'proxyChoicePending' }), /pauseReason/);
  assert.throws(() => quotaResult({ id: 'antigravity', status: 'no_data', pauseReason: 'egressUnconfirmed' }), /pauseReason/);
  const odd = quotaResult({ id: 'antigravity', status: 'unsupported', pauseReason: 'egressRegionUnsupported', egressRegion: 'cn-x' });
  assert.equal(odd.egressRegion, undefined);
});
