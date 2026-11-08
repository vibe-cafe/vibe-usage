import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

const home = mkdtempSync(join(tmpdir(), 'vibe-magpie-migration-'));
const oldEnv = { ...process.env };
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'VIBE_USAGE_CONFIG_DIR', 'VIBE_USAGE_STATE_DIR', 'VIBE_USAGE_CACHE_DIR']) process.env[key] = home;
process.env.VIBE_USAGE_DEV = '0';
test.after(() => {
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
  Object.assign(process.env, oldEnv);
  rmSync(home, { recursive: true, force: true });
});
const { chooseMagpieStartAt, magpieStartTime, planMagpieMigration, MAGPIE_SOURCES } = await import('../src/magpie-migration.js');
const { bucketKey, pruneState, saveState, loadState } = await import('../src/state.js');
const { loadConfig, saveConfig } = await import('../src/config.js');
const { runReset } = await import('../src/reset.js');
const exec = promisify(execFile);
const T = '2026-11-05T09:00:00.000Z';
const NEXT = '2026-11-05T09:30:00.000Z';
const bucket = (extra = {}) => ({ source: 'omp', project: 'fixture', hostname: 'fixture-host', bucketStart: T,
  model: 'group/lab', inputTokens: 100, outputTokens: 20, cachedInputTokens: 30,
  cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, reasoningOutputTokens: 0, totalTokens: 120, ...extra });
const stateOf = (...buckets) => ({ buckets: Object.fromEntries(buckets.map(b => [bucketKey(b), 'saved-hash'])), sessions: {} });

test('cut selection: latest supported window, none, daemon-only activation and identity rebound', () => {
  const state = stateOf(bucket(), bucket({ source: 'unrelated', bucketStart: NEXT }));
  assert.equal(chooseMagpieStartAt(state, { daemonInstalled: false, surface: 'cli' }), NEXT);
  assert.equal(chooseMagpieStartAt(stateOf(), { daemonInstalled: false, surface: 'cli' }), 'none');
  for (const surface of ['cli', 'mac-app', 'windows-app']) {
    assert.equal(chooseMagpieStartAt(state, { daemonInstalled: true, surface }), undefined);
  }
  assert.equal(chooseMagpieStartAt(state, { daemonInstalled: true, surface: 'daemon' }), NEXT);
  const now = Date.parse('2026-11-06T12:32:00Z');
  assert.equal(chooseMagpieStartAt({ ...stateOf(), identityChanged: true }, { daemonInstalled: false, surface: 'cli', now }), '2026-11-06T13:00:00.000Z');
});

test('UTC half-hour validation rejects local times, invalid dates and fractional boundaries', () => {
  assert.equal(magpieStartTime(undefined), null);
  assert.equal(magpieStartTime('none'), -Infinity);
  assert.equal(magpieStartTime(T), Date.parse(T));
  for (const value of ['2026-11-05T09:15:00Z', '2026-11-05T09:30:01Z', '2026-11-05T09:30:00.001Z',
    '2026-11-05T09:30:00+00:00', '2026-02-30T09:30:00Z', '', null]) assert.throws(() => magpieStartTime(value));
});

test('flip guard one preserves every old row when a Magpie row disappears from a still-live window', () => {
  const old = bucket({ model: 'magpie/deepseek/deepseek-flash' });
  const direct = bucket({ model: 'deepseek/deepseek-flash' });
  const state = stateOf(old, direct);
  const unchanged = bucket({ bucketStart: NEXT });
  for (const current of [[bucket(), direct, unchanged], [direct, unchanged]]) {
    const plan = planMagpieMigration(current, state);
    assert.deepEqual(plan.buckets, current.filter(b => b.bucketStart === NEXT));
    assert.equal(plan.preserveBuckets.size, 2);
    const copy = structuredClone(state);
    pruneState(copy, plan.preserveBuckets, new Set(), new Set(['omp']));
    assert.deepEqual(copy, state);
  }
});

test('vanished windows and old project/hostname coordinates follow ordinary source-scoped pruning', () => {
  const old = bucket({ model: 'magpie/deepseek/deepseek-flash' });
  const state = stateOf(old);
  for (const current of [[], [bucket({ project: 'unknown' })], [bucket({ hostname: 'new-host' })]]) {
    const plan = planMagpieMigration(current, state);
    assert.deepEqual(plan.buckets, current);
    assert.equal(plan.withheld.length, 0);
    assert.equal(plan.preserveBuckets.size, 0);
    const copy = structuredClone(state);
    pruneState(copy, plan.preserveBuckets, new Set(), new Set());
    assert.deepEqual(copy, state, 'failed parsers remain protected by okSources');
    pruneState(copy, plan.preserveBuckets, new Set(), new Set(['omp']));
    assert.deepEqual(copy.buckets, {});
  }
});

test('flip guard two only freezes a new Magpie row when an old row in that exact window disappears', () => {
  const old = bucket();
  const renamed = bucket({ model: 'magpie/deepseek/deepseek-flash' });
  const others = [bucket({ source: 'pi-coding-agent' }), bucket({ project: 'other' }),
    bucket({ hostname: 'other' }), bucket({ bucketStart: NEXT })];
  const blocked = planMagpieMigration([renamed, ...others], stateOf(old));
  assert.deepEqual(blocked.buckets, others);
  assert.equal(blocked.preserveBuckets.has(bucketKey(old)), true);
  // An ordinary direct model and a renamed group can coexist. As long as no
  // old key disappeared, increasing either row is safe and remains live.
  const live = planMagpieMigration([old, renamed], stateOf(old));
  assert.equal(live.buckets.length, 2);
  assert.equal(live.withheld.length, 0);
  const noMagpie = planMagpieMigration([bucket({ model: 'ordinary' })], stateOf(old));
  assert.equal(noMagpie.withheld.length, 0);
});

test('pending and failed reads hold entire affected windows, retain hashes and allow pre-cut/other-tool data', () => {
  const current = [...MAGPIE_SOURCES].flatMap(source => [bucket({ source }), bucket({ source, bucketStart: NEXT })]);
  current.push(bucket({ source: 'grok', bucketStart: NEXT }));
  const state = stateOf(...current);
  const failed = planMagpieMigration(current, state, { startAt: NEXT, failed: true });
  assert.equal(failed.preserveBuckets.size, 5);
  assert.equal(failed.buckets.length, 6);
  assert.ok(failed.buckets.every(b => b.source === 'grok' || b.bucketStart === T));
  const failedEmpty = planMagpieMigration([], state, { startAt: NEXT, failed: true });
  assert.equal(failedEmpty.preserveBuckets.size, 5, 'ledger read failures still hold vanished post-cut windows');
  const pending = planMagpieMigration([bucket(), bucket({ model: 'direct' }), bucket({ bucketStart: NEXT })], state,
    { startAt: 'none', pending: [bucket()] });
  assert.deepEqual(pending.buckets, [bucket({ bucketStart: NEXT })]);
  assert.equal(pending.preserveBuckets.size, 1);
  const notEnabled = planMagpieMigration(current, state, { failed: true });
  assert.deepEqual(notEnabled.buckets, current);
});

function fixture(t) {
  const root = mkdtempSync(join(home, 'child-'));
  const env = {
    PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
    XDG_CONFIG_HOME: join(root, 'xdg'), XDG_DATA_HOME: join(root, 'data'),
    VIBE_USAGE_CONFIG_DIR: root, VIBE_USAGE_STATE_DIR: root, VIBE_USAGE_CACHE_DIR: join(root, 'cache'),
    CODEX_HOME: join(root, 'codex'), VIBE_USAGE_CLAUDE_DIRS: join(root, 'claude'),
    VIBE_USAGE_CLAUDE_DESKTOP_DIRS: join(root, 'absent'), VIBE_USAGE_CINDY_DIRS: join(root, 'absent'),
    VIBE_USAGE_PI_SESSION_DIRS: join(root, 'pi'), VIBE_USAGE_OMP_SESSION_DIRS: join(root, 'omp'),
    VIBE_USAGE_OPENCODE_DIRS: join(root, 'opencode'), VIBE_USAGE_DEV: '0',
    VIBE_USAGE_MAGPIE_TEST_FILE: join(root, 'ledger.jsonl'),
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, env,
    run: code => exec(process.execPath, ['--input-type=module', '-e', code], { env, cwd: process.cwd() }),
    cli: args => exec(process.execPath, ['bin/vibe-usage.js', ...args], { env, cwd: process.cwd() }),
    write(name, value) { writeFileSync(join(root, name), JSON.stringify(value)); },
    read(name) { return JSON.parse(readFileSync(join(root, name))); },
  };
}
async function server(t, f) {
  const received = [];
  const http = createServer((req, res) => {
    if (req.url === '/api/usage/settings') { res.end(JSON.stringify({ uploadProject: false })); return; }
    if (req.url === '/api/usage/account') { res.end('{}'); return; }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (body.length) {
        const payload = JSON.parse(req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body);
        received.push(payload);
        res.end(JSON.stringify({ ingested: payload.buckets?.length || 0, sessions: payload.sessions?.length || 0 }));
      } else res.end('{}');
    });
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  const apiUrl = `http://127.0.0.1:${http.address().port}`;
  f.env.VIBE_USAGE_API_URL = apiUrl;
  return { apiUrl, received };
}
const restrict = sources => `
  const { parsers } = await import('./src/parsers/index.js');
  for (const key of Object.keys(parsers)) if (!${JSON.stringify(sources)}.includes(key)) delete parsers[key];
`;
function seedOmp(f, timestamp = '2026-11-05T09:10:00Z') {
  const path = join(f.env.VIBE_USAGE_OMP_SESSION_DIRS, 'session.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [
    { type: 'session', id: 'fixture', timestamp, cwd: '/Users/example/private-project' },
    { type: 'message', id: 'reply', timestamp, message: { role: 'assistant', provider: 'magpie', model: 'group/lab',
      responseId: 'reply', usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0 } } },
  ].map(JSON.stringify).join('\n') + '\n');
}
function seedLedger(f, timestamp = '2026-11-05T09:10:00Z') {
  writeFileSync(f.env.VIBE_USAGE_MAGPIE_TEST_FILE, JSON.stringify({ t: timestamp, agent: 'omp', provider: 'deepseek',
    model: 'deepseek-flash', response_id: 'reply', status: 200, in: 100, out: 20, cache_read: 30, cache_write: 0 }) + '\n');
}

test('config persists none, canonicalizes time, refuses moving an established cut and leaves Kiki behavior intact', async t => {
  const f = fixture(t);
  await f.cli(['config', 'set', 'magpieStartAt', '2026-11-05T09:00:00Z']);
  assert.equal(f.read('config.json').magpieStartAt, T);
  await f.cli(['config', 'set', 'magpieStartAt', T]);
  await assert.rejects(f.cli(['config', 'set', 'magpieStartAt', NEXT]), /切点不能直接更改/);
  await assert.rejects(f.cli(['config', 'set', 'magpieStartAt', '2026-11-05T09:10:00Z']), /UTC 半小时/);
  const none = await f.cli(['config', 'set', 'magpieStartAt', 'none']);
  assert.equal(f.read('config.json').magpieStartAt, 'none');
  assert.match(none.stderr, /从未按原名上传/);
  await assert.rejects(f.cli(['config', 'set', 'magpieStartAt', NEXT]), /切点不能直接更改/);
  await f.cli(['config', 'set', 'kikiStartAt', 'none']);
  assert.equal('kikiStartAt' in f.read('config.json'), false);
});

test('quiet sync guards live windows after privacy mapping and prunes entirely vanished windows', async t => {
  const f = fixture(t);
  const { apiUrl, received } = await server(t, f);
  f.write('config.json', { apiKey: 'vbu_fixture', apiUrl, hostname: 'fixture-host', magpieStartAt: 'none' });
  seedOmp(f); seedLedger(f);
  const command = restrict(['omp']) + `const { runSync } = await import('./src/sync.js'); await runSync({ quiet: true, surface: 'daemon', throws: true });`;
  await f.run(command);
  const uploaded = received.flatMap(p => p.buckets);
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].model, 'magpie/deepseek/deepseek-flash');
  assert.equal(uploaded[0].project, 'unknown');
  assert.deepEqual(Object.keys(uploaded[0]).sort(), Object.keys(bucket()).sort());
  const state = f.read('state.json');
  await f.run(command);
  assert.equal(received.length, 1);
  rmSync(f.env.VIBE_USAGE_MAGPIE_TEST_FILE);
  const lost = await f.run(command);
  assert.match(lost.stderr, /模型归属发生翻转.*暂停上传 1 个窗口/);
  assert.equal(received.length, 1);
  assert.deepEqual(f.read('state.json'), state);
  // The ledger exists, but its only response no longer matches this call.
  seedLedger(f, '2026-11-05T09:10:00Z');
  const ledger = JSON.parse(readFileSync(f.env.VIBE_USAGE_MAGPIE_TEST_FILE));
  ledger.response_id = 'other-reply';
  writeFileSync(f.env.VIBE_USAGE_MAGPIE_TEST_FILE, JSON.stringify(ledger) + '\n');
  const live = await f.run(command);
  assert.match(live.stderr, /模型归属发生翻转.*暂停上传 1 个窗口/);
  assert.deepEqual(f.read('state.json').buckets, state.buckets);
  rmSync(f.env.VIBE_USAGE_OMP_SESSION_DIRS, { recursive: true });
  const vanished = await f.run(command);
  assert.doesNotMatch(vanished.stderr, /暂停上传/);
  assert.deepEqual(f.read('state.json').buckets, {});
  assert.deepEqual(f.read('state.json').sessions, {}, 'ordinary session pruning is unchanged');
});

test('sync automatically chooses none on first use and current half-hour end after a Key rebound', async t => {
  const f = fixture(t);
  const { apiUrl } = await server(t, f);
  f.write('config.json', { apiKey: 'vbu_fixture_new', apiUrl, hostname: 'fixture-host' });
  seedOmp(f); seedLedger(f);
  const command = restrict(['omp']) + `const { runSync } = await import('./src/sync.js'); await runSync({ quiet: true, surface: 'daemon', throws: true });`;
  const first = await f.run(command);
  assert.match(first.stderr, /已确定切点 none/);
  assert.equal(f.read('config.json').magpieStartAt, 'none');
  const config = f.read('config.json'); delete config.magpieStartAt; config.apiKey = 'vbu_fixture_rotated';
  f.write('config.json', config);
  const before = Date.now();
  const changed = await f.run(command);
  assert.match(changed.stderr, /已确定切点/);
  const cut = Date.parse(f.read('config.json').magpieStartAt);
  assert.ok(cut > before && cut <= Date.now() + 1_800_000);
});

test('an installed daemon leaves manual sync unrenamed until a daemon run sets the cut', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t);
  const { apiUrl, received } = await server(t, f);
  const plist = join(f.root, 'Library', 'LaunchAgents', 'ai.vibecafe.vibe-usage.plist');
  mkdirSync(dirname(plist), { recursive: true }); writeFileSync(plist, 'synthetic service presence');
  f.write('config.json', { apiKey: 'vbu_fixture', apiUrl, hostname: 'fixture-host' });
  seedOmp(f); seedLedger(f);
  const command = surface => restrict(['omp']) + `const { runSync } = await import('./src/sync.js'); await runSync({ quiet: true, surface: '${surface}', throws: true });`;
  await f.run(command('cli'));
  assert.equal(f.read('config.json').magpieStartAt, undefined);
  assert.equal(received[0].buckets[0].model, 'group/lab');
  await f.run(command('daemon'));
  assert.equal(f.read('config.json').magpieStartAt, NEXT);
  assert.equal(received.length, 1);
});

test('init preserves a dated or none cut while rebuilding config', async t => {
  const f = fixture(t);
  const { apiUrl } = await server(t, f);
  for (const magpieStartAt of [T, 'none']) {
    f.write('config.json', { magpieStartAt, extraRoots: { codex: [] } });
    await f.run(restrict([]) + `const { runInit } = await import('./src/init.js'); await runInit({ apiKey: 'vbu_fixture_init', noDaemon: true });`);
    assert.equal(f.read('config.json').magpieStartAt, magpieStartAt);
    assert.equal(f.read('config.json').apiUrl, apiUrl);
  }
});

test('reset deletes remotely before clearing state/cut and resyncing; cancellation/failure keeps both', async () => {
  for (const args of [[], ['--local']]) {
    saveConfig({ apiKey: 'vbu_fixture', hostname: 'fixture-host', magpieStartAt: T, kikiStartAt: NEXT });
    saveState(stateOf(bucket()));
    const order = [];
    await runReset(args, {
      prompt: async () => 'y',
      deleteAllData: async () => {
        order.push('delete');
        assert.equal(loadConfig().magpieStartAt, T);
        assert.equal(Object.keys(loadState().buckets).length, 1);
        return { deleted: 1 };
      },
      runSync: async () => {
        order.push('sync');
        assert.equal(loadConfig().magpieStartAt, undefined);
        assert.equal(loadConfig().kikiStartAt, NEXT);
        assert.deepEqual(loadState(), stateOf());
      },
    });
    assert.deepEqual(order, ['delete', 'sync']);
  }
  saveConfig({ apiKey: 'vbu_fixture', magpieStartAt: T }); saveState(stateOf(bucket()));
  await runReset([], { prompt: async () => 'n' });
  assert.equal(loadConfig().magpieStartAt, T);
  const exit = process.exit;
  process.exit = () => { throw new Error('exit'); };
  try {
    await assert.rejects(runReset([], { prompt: async () => 'y', deleteAllData: async () => { throw new Error('fixture failure'); } }), /exit/);
  } finally { process.exit = exit; }
  assert.equal(loadConfig().magpieStartAt, T);
  assert.equal(Object.keys(loadState().buckets).length, 1);
});

test('quiet sync reports recent unmatched windows and ledger failures without uploading those buckets', async t => {
  const f = fixture(t);
  const { apiUrl, received } = await server(t, f);
  f.write('config.json', { apiKey: 'vbu_fixture', apiUrl, hostname: 'fixture-host', magpieStartAt: 'none' });
  seedOmp(f, new Date().toISOString());
  const command = restrict(['omp']) + `const { runSync } = await import('./src/sync.js'); await runSync({ quiet: true, surface: 'daemon', throws: true });`;
  const pending = await f.run(command);
  assert.match(pending.stderr, /最近 10 分钟.*等待下次同步/);
  assert.equal(received.flatMap(p => p.buckets).length, 0);
  mkdirSync(f.env.VIBE_USAGE_MAGPIE_TEST_FILE);
  const failed = await f.run(command);
  assert.match(failed.stderr, /本机账本读取失败.*读取权限/);
  assert.equal(received.flatMap(p => p.buckets).length, 0);
});

test('quiet daemon sync summarizes withheld windows once per reason on stderr', async t => {
  const f = fixture(t);
  const { apiUrl, received } = await server(t, f);
  f.write('config.json', { apiKey: 'vbu_fixture', apiUrl, hostname: 'fixture-host', magpieStartAt: 'none' });
  const old = ['omp', 'pi-coding-agent'].flatMap(source => [T, NEXT].map(bucketStart =>
    bucket({ source, bucketStart, project: 'unknown', model: 'magpie/deepseek/deepseek-flash' })));
  const waiting = bucket({ project: 'unknown', bucketStart: '2026-11-05T10:00:00.000Z' });
  const current = [...old.map(b => ({ ...b, model: 'group/lab' })), waiting];
  f.write('state.json', stateOf(...old));
  const result = await f.run(restrict(['omp', 'pi-coding-agent']) + `
    const current = ${JSON.stringify(current)};
    for (const source of Object.keys(parsers)) parsers[source] = async ({ magpie }) => {
      if (source === 'omp') magpie.pending.push(${JSON.stringify(waiting)});
      return { buckets: current.filter(b => b.source === source), sessions: [] };
    };
    const { runSync } = await import('./src/sync.js');
    await runSync({ quiet: true, surface: 'daemon', throws: true });
  `);
  const lines = result.stderr.split('\n').filter(line => line.includes('Magpie:'));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /模型归属发生翻转.*暂停上传 4 个窗口.*omp、pi-coding-agent.*2026-11-05T09:00:00.000Z 至 2026-11-05T09:30:00.000Z.*请恢复本机账本/);
  assert.match(lines[1], /最近 10 分钟.*暂停上传 1 个窗口.*工具 omp.*2026-11-05T10:00:00.000Z 至 2026-11-05T10:00:00.000Z.*等待下次同步/);
  assert.doesNotMatch(result.stdout, /Magpie|暂停上传/);
  assert.equal(received.length, 0);
  assert.deepEqual(f.read('state.json').buckets, stateOf(...old).buckets);
});

test('a deferred Cursor pass neither re-runs nor re-reports the Magpie window guards', async t => {
  const f = fixture(t);
  const { apiUrl, received } = await server(t, f);
  f.env.VIBE_USAGE_DEFERRED_GRACE_MS = '0';
  f.write('config.json', { apiKey: 'vbu_fixture', apiUrl, hostname: 'fixture-host', magpieStartAt: 'none' });
  const old = bucket({ project: 'unknown', model: 'magpie/deepseek/deepseek-flash' });
  const waiting = bucket({ project: 'unknown', bucketStart: NEXT });
  const cursor = bucket({ source: 'cursor', project: 'unknown', model: 'auto', bucketStart: NEXT });
  f.write('state.json', stateOf(old));
  const result = await f.run(restrict(['omp', 'cursor']) + `
    parsers.omp = async ({ magpie }) => {
      magpie.pending.push(${JSON.stringify(waiting)});
      return { buckets: [${JSON.stringify({ ...old, model: 'group/lab' })}, ${JSON.stringify(waiting)}], sessions: [] };
    };
    parsers.cursor = async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      return { buckets: [${JSON.stringify(cursor)}], sessions: [] };
    };
    const { runSync } = await import('./src/sync.js');
    await runSync({ quiet: true, surface: 'daemon', throws: true });
  `);
  const lines = result.stderr.split('\n').filter(line => line.includes('Magpie:'));
  assert.equal(lines.length, 2, 'one summary per reason, from the first pass only');
  assert.match(lines[0], /模型归属发生翻转.*暂停上传 1 个窗口.*工具 omp/);
  assert.match(lines[1], /最近 10 分钟.*暂停上传 1 个窗口.*工具 omp/);
  const uploaded = received.flatMap(p => p.buckets);
  assert.deepEqual(uploaded.map(b => b.source), ['cursor'], 'the second pass still uploads Cursor');
  const state = f.read('state.json').buckets;
  assert.ok(bucketKey(old) in state, 'the held Magpie hash survives both passes');
  assert.ok(bucketKey({ ...cursor, hostname: 'fixture-host' }) in state);
});

test('no Magpie installation leaves config and ordinary parser output unchanged', async t => {
  const f = fixture(t);
  const { apiUrl, received } = await server(t, f);
  f.write('config.json', { apiKey: 'vbu_fixture', apiUrl, hostname: 'fixture-host' });
  const expected = bucket({ model: 'ordinary', project: 'unknown' });
  const result = await f.run(restrict(['omp']) + `
    parsers.omp = async () => ({ buckets: [${JSON.stringify(expected)}], sessions: [] });
    const { runSync } = await import('./src/sync.js'); await runSync({ throws: true });
  `);
  assert.deepEqual(received[0].buckets, [expected]);
  assert.equal('magpieStartAt' in f.read('config.json'), false);
  assert.doesNotMatch(result.stderr, /Magpie/);
  assert.equal(existsSync(f.env.VIBE_USAGE_MAGPIE_TEST_FILE), false);
});
