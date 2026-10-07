import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { planKikiMigration, kikiStartTime } from '../src/kiki-migration.js';
import { bucketKey, bucketHash } from '../src/state.js';

const exec = promisify(execFile);
const T = '2026-10-05T12:30:00.000Z';
const oldTime = '2026-10-05T12:00:00.000Z';
const bucket = (source, bucketStart = oldTime, inputTokens = 13) => ({ source, model: 'gpt-6.1-sol', project: 'fixture', hostname: 'fixture-host', bucketStart,
  inputTokens, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, totalTokens: inputTokens });

test('cut requires an exact UTC half-hour, not an automatically chosen time', () => {
  assert.equal(kikiStartTime(undefined), null);
  assert.equal(kikiStartTime(T), Date.parse(T));
  assert.equal(kikiStartTime('2026-10-05T12:30:00Z'), Date.parse(T));
  for (const value of ['', '2026-10-05T12:31:00Z', '2026-10-05T12:30:01Z', '2026-02-30T12:30:00Z', '2026-10-05T12:30:00+00:00', 0]) {
    assert.throws(() => kikiStartTime(value), /UTC/);
  }
});

test('only first independent Kiki upload with matching legacy coordinates is held', () => {
  const kiki = bucket('kiki');
  const kimi = bucket('kimi-code');
  const legacy = { buckets: { [bucketKey(kimi)]: 'mixed-hash' }, sessions: {} };
  const pending = planKikiMigration([kiki, kimi, bucket('other')], [], legacy);
  assert.equal(pending.blocked, true);
  assert.deepEqual(pending.buckets.map(b => b.source), ['kimi-code', 'other']);
  assert.ok(pending.preserveBuckets.has(bucketKey(kimi)));
  const genuine = planKikiMigration([kiki, kimi], [], { buckets: { [bucketKey(kimi)]: bucketHash(kimi) }, sessions: {} });
  assert.equal(genuine.blocked, false);
  assert.equal(genuine.buckets.length, 2);
  assert.equal(genuine.preserveBuckets.size, 0);
  assert.equal(planKikiMigration([kiki], [], { buckets: { [bucketKey(bucket('kimi-code', T))]: 'unrelated' }, sessions: {} }).blocked, false);
  assert.equal(planKikiMigration([kiki], [], { buckets: { ...legacy.buckets, [bucketKey(kiki)]: 'independent' }, sessions: {} }).blocked, false);
});

test('cut freezes old shared keys, includes exact boundary and refuses an overlapping first cut', () => {
  const state = { buckets: { [bucketKey(bucket('kimi-code'))]: 'mixed' }, sessions: {} };
  const plan = planKikiMigration([bucket('kiki'), bucket('kiki', T), bucket('kimi-code')], [], state, T);
  assert.equal(plan.blocked, false);
  assert.deepEqual(plan.buckets.filter(b => b.source === 'kiki').map(b => b.bucketStart), [T]);
  assert.ok(plan.preserveBuckets.has(bucketKey(bucket('kimi-code'))));
  assert.equal(planKikiMigration([bucket('kiki')], [], state, oldTime).blocked, true);
  const oldSession = { source: 'kiki', sessionHash: 'copied-session', firstMessageAt: oldTime };
  const sessions = planKikiMigration([], [oldSession, { ...oldSession, sessionHash: 'new', firstMessageAt: T }],
    { buckets: {}, sessions: { 'kimi-code|copied-session': 'old-timing' } }, T);
  assert.deepEqual(sessions.sessions.map(s => s.sessionHash), ['new']);
  assert.ok(sessions.preserveSessions.has('kimi-code|copied-session'));
});

test('collector-shaped legacy row triggers the guard where the exact-key rule misses', () => {
  const kiki = bucket('kiki');
  // The kap-server collector (vibe-kimi-bucket-v1) uploaded this window as
  // kimi-code with project 'unknown' and hostname kiki-<stream_id>; neither can
  // equal this CLI's own session-project/machine-host coordinates, so the exact
  // key never matches and the guard used to be dead code.
  const collectorKey = bucketKey({ ...kiki, source: 'kimi-code', project: 'unknown', hostname: 'kiki-stream-9' });
  const plan = planKikiMigration([kiki], [], { buckets: { [collectorKey]: 'mixed-hash' }, sessions: {} });
  assert.equal(plan.blocked, true);
  assert.ok(plan.preserveBuckets.has(collectorKey));
  assert.equal(plan.withheld.buckets, 1);
  assert.equal(plan.withheld.earliest, kiki.bucketStart);

  // An unchanged genuine Kimi snapshot sharing that model+window is not a
  // signal, even when a collector-shaped row exists at the same coordinate.
  const kimi = bucket('kimi-code');
  const same = planKikiMigration([kiki, kimi], [], { buckets: { [collectorKey]: bucketHash(kimi) }, sessions: {} });
  assert.equal(same.blocked, false);
});

test('withheld reports the excluded Kiki history and its range, and is zero otherwise', () => {
  const state = { buckets: { [bucketKey(bucket('kimi-code'))]: 'mixed' }, sessions: {} };
  const preCut = planKikiMigration([bucket('kiki'), bucket('kiki', T), bucket('kimi-code')], [], state, T);
  assert.equal(preCut.withheld.buckets, 1);
  assert.equal(preCut.withheld.sessions, 0);
  assert.equal(preCut.withheld.totalTokens, 13);
  assert.equal(preCut.withheld.earliest, oldTime);
  assert.equal(preCut.withheld.latest, oldTime);

  const blocked = planKikiMigration([bucket('kiki', oldTime, 5), bucket('kiki', T, 7), bucket('kimi-code')], [], state);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.withheld.buckets, 2);
  assert.equal(blocked.withheld.totalTokens, 12);
  assert.equal(blocked.withheld.earliest, oldTime);
  assert.equal(blocked.withheld.latest, T);

  const none = planKikiMigration([bucket('kiki')], [], { buckets: {}, sessions: {} });
  assert.deepEqual(none.withheld, { buckets: 0, sessions: 0, totalTokens: 0, earliest: null, latest: null });
});

test('frozen counts report the kimi-code rows the guard holds this run', () => {
  const legacyKey = bucketKey(bucket('kimi-code'));
  const legacySession = 'kimi-code|copied-session';
  const state = { buckets: { [legacyKey]: 'mixed' }, sessions: { [legacySession]: 'old' } };
  const kikiSession = { source: 'kiki', sessionHash: 'copied-session', firstMessageAt: oldTime };

  const blocked = planKikiMigration([bucket('kiki'), bucket('kimi-code')], [kikiSession], state);
  assert.equal(blocked.frozenBuckets, 1);
  assert.equal(blocked.frozenSessions, 1);

  const preCut = planKikiMigration([bucket('kiki'), bucket('kimi-code')], [kikiSession], state, T);
  assert.equal(preCut.frozenBuckets, 1);
  assert.equal(preCut.frozenSessions, 1);

  const none = planKikiMigration([bucket('kiki')], [], { buckets: {}, sessions: {} });
  assert.equal(none.frozenBuckets, 0);
  assert.equal(none.frozenSessions, 0);
});

test('real gzip sync preserves mixed history, retries post-cut Kiki, and leaves Kimi independent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-kiki-cut-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const home = join(root, 'home');
  for (const dir of [configDir, stateDir, home]) mkdirSync(dir, { recursive: true });
  function wire(tool, before, after) {
    const toolHome = join(root, tool);
    const sessionDir = join(toolHome, 'sessions', 'wd_fixture_abcd', 'session_fixture');
    const agentDir = join(sessionDir, 'agents', 'main');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(toolHome, 'session_index.jsonl'), JSON.stringify({ sessionDir, workDir: join(root, 'fixture') }) + '\n');
    writeFileSync(join(agentDir, 'wire.jsonl'), [
      { type: 'usage.record', time: Date.parse(T) - 1, model: 'gpt-6.1-sol', usageScope: 'turn', usage: { inputOther: before, inputCacheRead: 0, inputCacheCreation: 0, output: 0 } },
      { type: 'usage.record', time: Date.parse(T), model: 'gpt-6.1-sol', usageScope: 'session', usage: { inputOther: after, inputCacheRead: 0, inputCacheCreation: 0, output: 0 } },
    ].map(JSON.stringify).join('\n') + '\n');
    return toolHome;
  }
  const kikiHome = wire('kiki', 13, 17);
  const kimiHome = wire('kimi', 7, 9);
  const old = bucket('kimi-code', oldTime, 20); // compatibility Kiki13 + actual Kimi7
  const oldHash = bucketHash(old);
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ buckets: { [bucketKey(old)]: oldHash }, sessions: {} }));
  const received = [];
  let failKiki = false;
  const server = createServer((req, res) => {
    if (req.url === '/api/usage/settings') { res.end(JSON.stringify({ uploadProject: true })); return; }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      assert.equal(req.url, '/api/usage/ingest');
      assert.equal(req.headers['content-encoding'], 'gzip');
      const payload = JSON.parse(gunzipSync(Buffer.concat(chunks)));
      received.push(payload);
      if (failKiki && payload.buckets.some(b => b.source === 'kiki')) { res.writeHead(500).end('{}'); return; }
      res.end(JSON.stringify({ ingested: payload.buckets.length, sessions: payload.sessions?.length ?? 0 }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { apiKey: 'vbu_synthetic_fixture', apiUrl: `http://127.0.0.1:${server.address().port}`, hostname: 'fixture-host' };
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    VIBE_USAGE_DEV: '0', VIBE_USAGE_CONFIG_DIR: configDir, VIBE_USAGE_STATE_DIR: stateDir,
    VIBE_USAGE_KIKI_DIR: kikiHome, VIBE_USAGE_KIMI_CODE_DIR: kimiHome, VIBE_USAGE_KIMI_DIR: join(root, 'legacy') };
  const command = `
    import { parsers } from './src/parsers/index.js';
    for (const source of Object.keys(parsers)) if (!['kiki', 'kimi-code'].includes(source)) delete parsers[source];
    const { runSync } = await import('./src/sync.js');
    await runSync({ quiet: true, throws: true });
  `;
  const sync = () => exec(process.execPath, ['--input-type=module', '-e', command], { cwd: process.cwd(), env });
  try {
    writeFileSync(join(configDir, 'config.json'), JSON.stringify(config));
    const blocked = await sync();
    assert.match(blocked.stderr, /暂停 Kiki/);
    assert.deepEqual(received.flatMap(p => p.buckets).map(b => [b.source, b.bucketStart, b.inputTokens]), [['kimi-code', T, 9]]);
    assert.equal(JSON.parse(readFileSync(join(stateDir, 'state.json'))).buckets[bucketKey(old)], oldHash);
    await exec(process.execPath, ['bin/vibe-usage.js', 'config', 'set', 'kikiStartAt', T], { cwd: process.cwd(), env });
    await assert.rejects(exec(process.execPath, ['bin/vibe-usage.js', 'config', 'set', 'kikiStartAt', '2026-10-05T12:31:00Z'], { cwd: process.cwd(), env }), /UTC/);
    failKiki = true;
    await assert.rejects(sync());
    let state = JSON.parse(readFileSync(join(stateDir, 'state.json')));
    assert.ok(!Object.keys(state.buckets).some(key => key.startsWith('kiki|')));
    failKiki = false;
    await sync();
    await assert.rejects(exec(process.execPath, ['bin/vibe-usage.js', 'config', 'set', 'kikiStartAt', oldTime], { cwd: process.cwd(), env }), /切点不能直接更改/);
    const count = received.length;
    await sync();
    assert.equal(received.length, count); // restart + unchanged same-key snapshot: no double collection
    const kikiPayloads = received.flatMap(p => p.buckets).filter(b => b.source === 'kiki');
    // Existing ingest() makes three attempts on 5xx, then the next process
    // retries the same absolute snapshot successfully; no cumulative addition.
    assert.deepEqual(kikiPayloads.map(b => [b.bucketStart, b.inputTokens]), Array.from({ length: 4 }, () => [T, 17]));
    state = JSON.parse(readFileSync(join(stateDir, 'state.json')));
    assert.equal(state.buckets[bucketKey(old)], oldHash);
    assert.ok(state.buckets[bucketKey(bucket('kiki', T, 17))]);
    assert.ok(!received.flatMap(p => p.buckets).some(b => b.bucketStart === oldTime));
    assert.ok(received.flatMap(p => p.buckets).every(b => b.source === 'kiki' || b.source === 'kimi-code'));
    // A genuinely fresh installation sends complete independent snapshots,
    // including coincident model/project/time coordinates, not a merged source.
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ ...config, apiKey: 'vbu_fresh_fixture' }));
    const freshIndex = received.length;
    await exec(process.execPath, ['--input-type=module', '-e', command], { cwd: process.cwd(),
      env: { ...env, VIBE_USAGE_STATE_DIR: join(root, 'fresh-state') } });
    assert.deepEqual(received.slice(freshIndex).flatMap(p => p.buckets).map(b => [b.source, b.bucketStart, b.inputTokens]),
      [['kiki', oldTime, 13], ['kiki', T, 17], ['kimi-code', oldTime, 7], ['kimi-code', T, 9]]);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unreadable Kiki root skips with a warning and preserves prior kiki state', { skip: process.platform === 'win32' && 'POSIX chmod fixture: Windows needs an ACL denial test' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-kiki-unreadable-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const home = join(root, 'home');
  for (const dir of [configDir, stateDir, home]) mkdirSync(dir, { recursive: true });
  const kikiHome = join(root, 'kiki');
  const kikiSessions = join(kikiHome, 'sessions');
  mkdirSync(kikiSessions, { recursive: true });
  const kimiHome = join(root, 'kimi');
  mkdirSync(join(kimiHome, 'sessions'), { recursive: true });
  // Prior Kiki upload state that a read failure must not prune (the parser
  // would otherwise report an empty success and sync would evict every key).
  const priorKey = bucketKey(bucket('kiki', oldTime, 13));
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ buckets: { [priorKey]: 'prior-hash' }, sessions: {} }));
  const server = createServer((req, res) => {
    if (req.url === '/api/usage/settings') { res.end(JSON.stringify({ uploadProject: true })); return; }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { res.end(JSON.stringify({ ingested: 0, sessions: 0 })); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { apiKey: 'vbu_synthetic_fixture', apiUrl: `http://127.0.0.1:${server.address().port}`, hostname: 'fixture-host' };
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    VIBE_USAGE_DEV: '0', VIBE_USAGE_CONFIG_DIR: configDir, VIBE_USAGE_STATE_DIR: stateDir,
    VIBE_USAGE_KIKI_DIR: kikiHome, VIBE_USAGE_KIMI_CODE_DIR: kimiHome, VIBE_USAGE_KIMI_DIR: join(root, 'legacy') };
  const command = `
    import { parsers } from './src/parsers/index.js';
    for (const source of Object.keys(parsers)) if (!['kiki', 'kimi-code'].includes(source)) delete parsers[source];
    const { runSync } = await import('./src/sync.js');
    await runSync({ quiet: true, throws: true });
  `;
  try {
    writeFileSync(join(configDir, 'config.json'), JSON.stringify(config));
    chmodSync(kikiSessions, 0o000);
    const result = await exec(process.execPath, ['--input-type=module', '-e', command], { cwd: process.cwd(), env });
    assert.match(result.stderr, /kiki: 无法读取/);
    const state = JSON.parse(readFileSync(join(stateDir, 'state.json')));
    assert.equal(state.buckets[priorKey], 'prior-hash');
  } finally {
    chmodSync(kikiSessions, 0o755);
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('clearing kikiStartAt re-admits withheld pre-cut history and a different cut stays refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-kiki-clear-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const home = join(root, 'home');
  for (const dir of [configDir, stateDir, home]) mkdirSync(dir, { recursive: true });
  function wire(before, after) {
    const toolHome = join(root, 'kiki');
    const sessionDir = join(toolHome, 'sessions', 'wd_fixture_abcd', 'session_fixture');
    const agentDir = join(sessionDir, 'agents', 'main');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(toolHome, 'session_index.jsonl'), JSON.stringify({ sessionDir, workDir: join(root, 'fixture') }) + '\n');
    writeFileSync(join(agentDir, 'wire.jsonl'), [
      { type: 'usage.record', time: Date.parse(T) - 1, model: 'gpt-6.1-sol', usageScope: 'turn', usage: { inputOther: before, inputCacheRead: 0, inputCacheCreation: 0, output: 0 } },
      { type: 'usage.record', time: Date.parse(T), model: 'gpt-6.1-sol', usageScope: 'session', usage: { inputOther: after, inputCacheRead: 0, inputCacheCreation: 0, output: 0 } },
    ].map(JSON.stringify).join('\n') + '\n');
    return toolHome;
  }
  const kikiHome = wire(13, 17);
  const kimiHome = join(root, 'kimi');
  mkdirSync(join(kimiHome, 'sessions'), { recursive: true });
  const received = [];
  const server = createServer((req, res) => {
    if (req.url === '/api/usage/settings') { res.end(JSON.stringify({ uploadProject: true })); return; }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const payload = JSON.parse(gunzipSync(Buffer.concat(chunks)));
      received.push(payload);
      res.end(JSON.stringify({ ingested: payload.buckets.length, sessions: payload.sessions?.length ?? 0 }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { apiKey: 'vbu_synthetic_fixture', apiUrl: `http://127.0.0.1:${server.address().port}`, hostname: 'fixture-host' };
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    VIBE_USAGE_DEV: '0', VIBE_USAGE_CONFIG_DIR: configDir, VIBE_USAGE_STATE_DIR: stateDir,
    VIBE_USAGE_KIKI_DIR: kikiHome, VIBE_USAGE_KIMI_CODE_DIR: kimiHome, VIBE_USAGE_KIMI_DIR: join(root, 'legacy') };
  const command = `
    import { parsers } from './src/parsers/index.js';
    for (const source of Object.keys(parsers)) if (!['kiki', 'kimi-code'].includes(source)) delete parsers[source];
    const { runSync } = await import('./src/sync.js');
    await runSync({ quiet: true, throws: true });
  `;
  const sync = () => exec(process.execPath, ['--input-type=module', '-e', command], { cwd: process.cwd(), env });
  const kikiBuckets = () => received.flatMap(p => p.buckets).filter(b => b.source === 'kiki').map(b => [b.bucketStart, b.inputTokens]);
  try {
    writeFileSync(join(configDir, 'config.json'), JSON.stringify(config));
    await exec(process.execPath, ['bin/vibe-usage.js', 'config', 'set', 'kikiStartAt', T], { cwd: process.cwd(), env });
    const first = await sync();
    // The cut withholds the pre-cut bucket and says so.
    assert.match(first.stderr, /未上传/);
    assert.deepEqual(kikiBuckets(), [[T, 17]]);
    // Clearing the cut re-admits the withheld pre-cut history under kiki.
    await exec(process.execPath, ['bin/vibe-usage.js', 'config', 'set', 'kikiStartAt', 'none'], { cwd: process.cwd(), env });
    const cleared = JSON.parse(readFileSync(join(configDir, 'config.json')));
    assert.ok(!('kikiStartAt' in cleared));
    const shown = await exec(process.execPath, ['bin/vibe-usage.js', 'config', 'show'], { cwd: process.cwd(), env });
    assert.ok(!shown.stdout.includes('none'));
    await sync();
    assert.ok(kikiBuckets().some(([start, tokens]) => start === oldTime && tokens === 13));
    // Independent uploads recorded: a different cut is still refused.
    await assert.rejects(exec(process.execPath, ['bin/vibe-usage.js', 'config', 'set', 'kikiStartAt', T], { cwd: process.cwd(), env }), /切点不能直接更改/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
