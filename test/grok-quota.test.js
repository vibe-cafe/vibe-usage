import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { fetchGrokQuota, findGrokBinary } from '../src/quotas/providers/grok.js';
import { cleanupAllowanceMs } from '../src/quotas/providers/child-process.js';
import { fetchQuotaProducts } from '../src/quotas/registry.js';

const now = new Date('2026-11-25T12:00:00Z');
const eventTime = '2026-11-24T00:00:00.000Z';
const currentPeriod = {
  type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-11-23T00:00:00Z', end: '2026-11-30T00:00:00Z',
};
const meter = utilization => ({
  id: 'subscription-credits', label: '7d', utilization, resetsAt: '2026-11-30T00:00:00.000Z', windowSeconds: 604800,
});
function homeFor(t) {
  const home = mkdtempSync(join(tmpdir(), 'vbu-grok-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test('grok discovery honors home, PATH order, regular files, permissions and symlinks', {
  skip: process.platform === 'win32',
}, t => {
  const home = homeFor(t);
  const [installed, first, second, local] = ['custom/bin', 'one', 'two', '.local/bin'].map(dir => join(home, dir, 'grok'));
  for (const path of [installed, first, second, local]) mkdirSync(dirname(path), { recursive: true });
  const find = () => findGrokBinary({
    home, environment: { GROK_HOME: '~/custom', PATH: [dirname(first), dirname(second)].join(delimiter) },
  });
  assert.equal(find(), null);
  writeFileSync(local, '', { mode: 0o700 });
  assert.equal(find(), local);
  writeFileSync(second, '', { mode: 0o700 });
  mkdirSync(first); // An executable directory is not a program.
  assert.equal(find(), second);
  rmSync(first, { recursive: true });
  symlinkSync(second, first);
  writeFileSync(installed, '', { mode: 0o600 });
  assert.equal(find(), first);
  rmSync(installed);
  symlinkSync(local, installed);
  assert.equal(find(), installed);
});

test('Windows grok discovery uses Path case-insensitively and only considers grok.exe', t => {
  const home = homeFor(t);
  const installed = join(home, '.grok', 'bin');
  const first = join(home, 'first'), second = join(home, 'second'), local = join(home, '.local', 'bin');
  for (const dir of [installed, first, second, local]) mkdirSync(dir, { recursive: true });
  for (const name of ['grok.cmd', 'grok.bat', 'grok']) writeFileSync(join(installed, name), '');
  writeFileSync(join(first, 'grok.cmd'), '');
  writeFileSync(join(local, 'grok.exe'), '');
  const find = () => findGrokBinary({ home, platform: 'win32', environment: { Path: first + ';' + second } });
  assert.equal(find(), null);
  for (const dir of [second, first, installed]) {
    writeFileSync(join(dir, 'grok.exe'), '');
    assert.equal(find(), join(dir, 'grok.exe'));
  }
});

const fake = String.raw`
  const { appendFileSync, writeFileSync } = require('node:fs');
  const { spawn } = require('node:child_process');
  const trace = record => appendFileSync(process.env.TRACE, JSON.stringify(record) + '\n');
  const { SCENARIO, ANSWER } = process.env;
  const reply = (id, fields) => console.log(JSON.stringify({ jsonrpc: '2.0', id, ...fields }));
  trace({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid,
    envKeys: Object.keys(process.env), updater: process.env.GROK_DISABLE_AUTOUPDATER, gc: process.env.GROK_WORKTREE_AUTO_GC,
    proxy: process.env.HTTPS_PROXY, bypass: process.env.NO_PROXY });
  const lines = require('node:readline').createInterface({ input: process.stdin });
  lines.on('line', line => {
    const request = JSON.parse(line);
    trace(request);
    if (request.method === 'initialize') {
      if (SCENARIO === 'initialize-error') return reply(1, { error: { code: -32000, message: 'Authentication required' } });
      console.log('not JSON');
      reply(2, { error: { code: -32000, message: 'Authentication required' } }); // Not pending.
      return reply(1, { result: { protocolVersion: 1 } });
    }
    if (request.method !== '_x.ai/billing') process.exit(9);
    for (const method of ['mcp/servers_updated', 'models/update', 'settings/update', 'announcements/update']) {
      console.log(JSON.stringify({ jsonrpc: '2.0', method: '_x.ai/' + method, params: {} }));
    }
    if (SCENARIO === 'early-exit') process.exit(1);
    if (SCENARIO === 'garbage') {
      // An otherwise valid answer without its newline must not be used.
      return process.stdout.write('junk\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, ...JSON.parse(ANSWER) }),
        () => process.exit(0));
    }
    if (SCENARIO === 'timeout') {
      setInterval(() => {}, 1000);
      if (process.platform !== 'win32') {
        process.on('SIGTERM', () => {}); // Exercise escalation while the grandchild needs the group signal.
        trace({ grandchild: spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid });
      }
      return;
    }
    if (SCENARIO === 'over-cap') {
      // Neither stream exceeds the cap on its own.
      return process.stderr.write(Buffer.alloc(600000), () =>
        process.stdout.write('x'.repeat(500000) + '\n', () => reply(2, JSON.parse(ANSWER))));
    }
    if (process.env.LOG_EVENT) writeFileSync(process.env.LOG_PATH, process.env.LOG_EVENT + '\n');
    reply(2, JSON.parse(ANSWER));
  });
`;

function fixture(t) {
  const home = homeFor(t);
  const script = join(home, 'fake.cjs');
  writeFileSync(script, fake);
  const logPath = join(home, '.grok', 'logs', 'unified.jsonl');
  mkdirSync(dirname(logPath), { recursive: true });
  const trace = join(home, 'calls');
  const environment = {
    HOME: home, USERPROFILE: home, PATH: home, VIBE_USAGE_QUOTA_CACHE_DIR: home,
    TRACE: trace, LOG_PATH: logPath, ANSWER: JSON.stringify({ result: { config: { currentPeriod } } }),
    HTTPS_PROXY: 'socks5://proxy.invalid:1080', NO_PROXY: 'example.invalid',
    bigmodel_API_KEY: 'test', Z_Ai_Api_Key: 'test', Grok_Disable_Autoupdater: '0',
  };
  const options = {
    home, environment, now, grokBinary: join(home, 'grok'),
    spawnImpl: (binary, args, opts) => {
      assert.equal(binary, join(home, 'grok'));
      assert.ok(opts.windowsHide);
      assert.equal(opts.detached, process.platform !== 'win32');
      return spawn(process.execPath, [script, ...args], opts);
    },
    egressPause: async () => null,
  };
  const event = utilization => JSON.stringify({ ts: eventTime, msg: 'billing: fetched credits config',
    ctx: { config: { currentPeriod, creditUsagePercent: utilization }, subscriptionTier: 'Local plan' } });
  const fetch = async (extra = {}) => (await fetchQuotaProducts(['grok'], { ...options, ...extra })).products[0];
  return {
    options, environment, home, trace, fetch, event, writeLog: utilization => writeFileSync(logPath, event(utilization)),
    calls: () => readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
  };
}

test('a live read sends exactly two ACP requests, isolates the child and returns only quota fields', async t => {
  const f = fixture(t);
  f.environment.ANSWER = JSON.stringify({ result: { subscription_tier: 'Live plan',
    config: { currentPeriod, creditUsagePercent: 17, subscriptionTier: 'Other', prepaidBalance: { val: 123 } } } });
  const result = await f.fetch();
  assert.deepEqual(result, { id: 'grok', status: 'ok', source: 'live', meters: [meter(17)], planLabel: 'Live plan',
    fetchedAt: now.toISOString(), dataAsOf: now.toISOString() });
  const [child, ...requests] = f.calls();
  assert.deepEqual(child.argv, ['agent', '--no-leader', 'stdio']);
  assert.deepEqual(requests, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    } },
    { jsonrpc: '2.0', id: 2, method: '_x.ai/billing', params: {} },
  ]);
  assert.equal(child.updater, '1');
  assert.equal(child.gc, '0');
  assert.deepEqual(child.envKeys.filter(key => /^(bigmodel_api_key|z_ai_api_key|grok_disable_autoupdater)$/i.test(key)),
    ['GROK_DISABLE_AUTOUPDATER']);
  assert.equal(child.proxy, f.environment.HTTPS_PROXY);
  assert.equal(child.bypass, f.environment.NO_PROXY);
  assert.equal(f.environment.Grok_Disable_Autoupdater, '0');
  assert.match(basename(child.cwd), /^vibe-usage-grok-quota-/);
  assert.equal(realpathSync(dirname(child.cwd)), realpathSync(tmpdir()));
  assert.equal(existsSync(child.cwd), false);
  assert.equal(existsSync(join(f.home, 'quota-cache.json')), false);
});

test('an omitted live percentage means zero, and the new billing event supplies the missing tier', async t => {
  const f = fixture(t);
  f.environment.LOG_EVENT = f.event(54);
  const result = await f.fetch();
  assert.equal(result.source, 'live');
  assert.deepEqual(result.meters, [meter(0)]);
  assert.equal(result.planLabel, 'Local plan');
  assert.equal(result.dataAsOf, now.toISOString());
});

for (const [used, monthlyLimit] of [[1, 4], [{ val: 1 }, { val: 4 }]]) {
  test('legacy billing counters as ' + typeof used, async t => {
    const f = fixture(t);
    f.environment.ANSWER = JSON.stringify({ result: { used, monthlyLimit, billingPeriodStart: currentPeriod.start,
      billingPeriodEnd: currentPeriod.end, subscriptionTier: 'Legacy' } });
    const result = await f.fetch();
    assert.equal(result.source, 'live');
    assert.deepEqual(result.meters, [meter(25)]);
    assert.equal(result.planLabel, 'Legacy');
  });
}

for (const [name, error, status] of [
  ['signed out', { code: -32000, message: 'Authentication required to fetch billing data' }, 'unauthorized'],
  ['ACP signed-out detail', { code: -32000, message: 'Request failed', data: 'Authentication required' }, 'unauthorized'],
  ['API key', { code: -32000, message: 'Billing data requires auth with grok.com.' }, 'no_data'],
  ['ACP auth detail', { code: -32000, message: 'Authentication required',
    data: 'Billing data requires auth with grok.com. Run grok login to authenticate.' }, 'no_data'],
]) {
  test(name + ' ignores the previous login’s valid log', async t => {
    const f = fixture(t);
    f.writeLog(81);
    f.environment.ANSWER = JSON.stringify({ error });
    const result = await f.fetch();
    assert.equal(result.status, status);
    assert.equal(result.source, 'live');
    assert.deepEqual(result.meters, []);
    if (status === 'unauthorized') {
      assert.match(result.message, /grok login.*terminal/i);
      assert.equal(result.failureReason, 'credentialsMissing');
    } else {
      assert.equal(result.emptyReason, 'sessionWithoutPlanLimits');
      assert.equal(result.failureReason, undefined);
    }
  });
}

for (const [scenario, answer, failureReason = 'programNoAnswer'] of [
  ['service error', { error: { code: -32603, message: 'private' } }],
  ['unknown method', { error: { code: -32601, message: 'private' } }, 'programOutdated'],
  ['other sign-in error', { error: { code: -32000, message: 'private' } }],
  ['bad period', { result: { currentPeriod: { ...currentPeriod, start: 'invalid' } } }, 'unrecognizedResponse'],
  ['ended period', { result: { currentPeriod: { ...currentPeriod, end: now.toISOString() } } }, 'unrecognizedResponse'],
  ['future period', { result: { currentPeriod: { ...currentPeriod, start: '2026-11-26' } } }, 'unrecognizedResponse'],
  ['initialize-error'], ['early-exit'], ['garbage'], ['over-cap'], ['spawn failure'],
]) {
  test(scenario + ' returns the dated local reading', async t => {
    const f = fixture(t);
    f.writeLog(81);
    if (answer) f.environment.ANSWER = JSON.stringify(answer);
    f.environment.SCENARIO = scenario;
    const extra = scenario === 'spawn failure' ? { spawnImpl: () => { throw new Error('private'); } } : {};
    assert.deepEqual(await f.fetch(extra), { id: 'grok', status: 'ok', source: 'local', meters: [meter(81)],
      planLabel: 'Local plan', fetchedAt: now.toISOString(), dataAsOf: eventTime, failureReason });
    if (scenario === 'initialize-error') assert.deepEqual(f.calls().slice(1).map(call => call.method), ['initialize']);
  });
}

test('timeout includes stopping the process tree and removing the temporary cwd', async t => {
  const f = fixture(t);
  f.environment.SCENARIO = 'timeout';
  f.writeLog(81);
  const timeoutMs = cleanupAllowanceMs(process.platform) + 1500;
  const started = performance.now();
  const result = await f.fetch({ timeoutMs });
  assert.ok(performance.now() - started <= timeoutMs + 300);
  assert.equal(result.source, 'local');
  assert.deepEqual(result.meters, [meter(81)]);
  assert.equal(result.failureReason, 'timedOut');
  const [child, ...calls] = f.calls();
  assert.equal(existsSync(child.cwd), false);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  if (process.platform !== 'win32') {
    const pid = calls.find(call => call.grandchild)?.grandchild;
    assert.ok(pid);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
});

test('a pause returns the local 0% reading or the pause message, without spawning', async t => {
  const f = fixture(t);
  const pause = { pauseReason: 'egressRegionUnsupported', region: 'CN', message: 'Paused in CN.' };
  const options = { egressPause: async () => pause };
  const missing = await f.fetch(options);
  assert.equal(missing.status, 'unsupported');
  assert.equal(missing.message, pause.message);
  assert.equal(missing.pauseReason, pause.pauseReason);
  assert.equal(missing.egressRegion, 'CN');
  assert.equal(missing.failureReason, undefined);
  f.writeLog(undefined);
  const local = await f.fetch(options);
  assert.deepEqual(local, { id: 'grok', status: 'ok', source: 'local', planLabel: 'Local plan', meters: [meter(0)],
    fetchedAt: now.toISOString(), dataAsOf: eventTime, pauseReason: pause.pauseReason, egressRegion: 'CN' });
  const absent = await fetchGrokQuota({ ...f.options, grokBinary: null, egressGate: () => assert.fail('gate called') });
  assert.equal(absent.source, 'local');
  assert.deepEqual(absent.meters, [meter(0)]);
  assert.equal(absent.pauseReason, undefined);
  assert.equal(absent.failureReason, 'programNotFound');
  assert.equal(existsSync(f.trace), false);
});

test('the 2 MiB log tail bounds fallback reads and live tier lookup', async t => {
  const f = fixture(t);
  f.writeLog(43);
  appendFileSync(f.environment.LOG_PATH, '\n' + 'x'.repeat(2 * 1024 * 1024) + '\n');
  const local = await f.fetch({ grokBinary: null });
  assert.equal(local.status, 'no_data');
  assert.equal(local.emptyReason, 'noLocalRecord');
  assert.equal(local.failureReason, 'programNotFound');
  const live = await f.fetch();
  assert.equal(live.source, 'live');
  assert.deepEqual(live.meters, [meter(0)]);
  assert.equal(live.planLabel, undefined);
});
