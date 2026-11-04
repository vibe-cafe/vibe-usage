import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { planMagpieMigration } from '../src/magpie-migration.js';
import { bucketKey, pruneState } from '../src/state.js';

const T = '2026-11-01T12:00:00.000Z';
const NEXT = '2026-11-01T12:30:00.000Z';
const bucket = (overrides = {}) => ({
  source: 'omp', model: 'gpt-6', project: 'fixture', hostname: 'fixture-host', bucketStart: T,
  inputTokens: 10, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0,
  cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, totalTokens: 10, ...overrides,
});
const infoMap = (...entries) => new Map(entries.map(([source, resolved = 1, unresolved = 0]) => [
  source, { magpie: { resolved, unresolved } },
]));
const stateOf = (...buckets) => ({ buckets: Object.fromEntries(buckets.map(b => [bucketKey(b), 'uploaded-hash'])), sessions: {} });

test('resolving aliases freezes the whole historical coordinate and preserves every uploaded model there', () => {
  const group = bucket({ model: 'group/pi' });
  const oldReal = bucket({ model: 'claude-opus-4-6' });
  const oldAbsent = bucket({ model: 'gpt-5' });
  const state = stateOf(group, oldReal, oldAbsent);
  const current = [bucket(), group, oldReal, bucket({ bucketStart: NEXT })];
  const plan = planMagpieMigration(current, state, infoMap(['omp', 1, 0]));
  assert.deepEqual(plan.buckets, [current[3]]);
  assert.deepEqual([...plan.preserveBuckets].sort(), [bucketKey(group), bucketKey(oldReal), bucketKey(oldAbsent)].sort());
  assert.deepEqual(plan.withheld, [{ source: 'omp', windows: 1, buckets: 3, totalTokens: 30, earliest: T, latest: T }]);
  pruneState(state, new Set([...plan.preserveBuckets, bucketKey(current[3])]), new Set(), new Set(['omp']));
  assert.equal(Object.keys(state.buckets).length, 3);
  assert.equal(state.buckets[bucketKey(oldAbsent)], 'uploaded-hash');
});

test('the same half-hour stays uploadable for different source, host, or project and for a new window', () => {
  const old = bucket({ model: 'group/pi' });
  const different = [
    bucket({ source: 'pi-coding-agent' }), bucket({ source: 'craft-agent' }),
    bucket({ hostname: 'other-host' }), bucket({ project: 'other-project' }),
    bucket({ bucketStart: NEXT }),
  ];
  const plan = planMagpieMigration([bucket(), ...different], stateOf(old), infoMap(['omp', 1, 0], ['pi-coding-agent', 1, 0]));
  assert.deepEqual(plan.buckets, different);
  assert.equal(plan.preserveBuckets.size, 1);
});

test('only currently resolved Pi and OMP sources freeze legacy group windows', () => {
  const sources = ['omp', 'pi-coding-agent', 'craft-agent', 'cola'];
  const legacy = sources.map(source => bucket({ source, model: 'group/pi' }));
  const current = sources.map(source => bucket({ source }));
  const unresolved = planMagpieMigration(current, stateOf(...legacy), infoMap(...sources.map(s => [s, 0, 3])));
  assert.deepEqual(unresolved.buckets, current);
  assert.deepEqual(unresolved.withheld, []);
  assert.equal(unresolved.preserveBuckets.size, 0);
  const resolved = planMagpieMigration(current, stateOf(...legacy), infoMap(...sources.map(s => [s, 1, 0])));
  assert.deepEqual(resolved.buckets, current.slice(2));
  assert.deepEqual(resolved.withheld.map(w => w.source), ['omp', 'pi-coding-agent']);
  const noInfo = planMagpieMigration(current, stateOf(...legacy), new Map());
  assert.deepEqual(noInfo.buckets, current);
});

test('unresolved group fallback cannot duplicate models already uploaded in that coordinate', () => {
  const uploaded = bucket();
  const oldOther = bucket({ model: 'claude-opus-4-6' });
  const fallback = bucket({ model: 'group/pi' });
  const fresh = bucket({ model: 'group/pi', bucketStart: NEXT });
  const plan = planMagpieMigration([fallback, oldOther, fresh], stateOf(uploaded, oldOther), infoMap(['omp', 0, 2]));
  assert.deepEqual(plan.buckets, [fresh]);
  assert.deepEqual([...plan.preserveBuckets].sort(), [bucketKey(uploaded), bucketKey(oldOther)].sort());
  assert.deepEqual(plan.withheld, [{ source: 'omp', windows: 1, buckets: 2, totalTokens: 20, earliest: T, latest: T }]);
  const unchangedAlias = planMagpieMigration([fallback], stateOf(fallback), infoMap(['omp', 0, 1]));
  assert.deepEqual(unchangedAlias.buckets, [fallback]);
  assert.deepEqual(unchangedAlias.withheld, []);
});

test('reports each source separately and retains vanished historical windows without inventing token counts', () => {
  const first = bucket({ model: 'group/fast' });
  const second = bucket({ model: 'group/pi', bucketStart: NEXT });
  const pi = bucket({ source: 'pi-coding-agent', model: 'group/pi' });
  const plan = planMagpieMigration([bucket(), bucket({ source: 'pi-coding-agent', totalTokens: 7 })],
    stateOf(first, second, pi), infoMap(['omp', 1, 0], ['pi-coding-agent', 1, 0]));
  assert.deepEqual(plan.buckets, []);
  assert.deepEqual(plan.withheld, [
    { source: 'omp', windows: 2, buckets: 1, totalTokens: 10, earliest: T, latest: NEXT },
    { source: 'pi-coding-agent', windows: 1, buckets: 1, totalTokens: 7, earliest: T, latest: T },
  ]);
  assert.equal(plan.preserveBuckets.size, 3);
});

test('a new upload target has no legacy windows and planner leaves its inputs untouched', () => {
  const current = [bucket(), bucket({ model: 'group/pi', bucketStart: NEXT })];
  const state = stateOf();
  const original = structuredClone({ current, state });
  const plan = planMagpieMigration(current, state, infoMap(['omp', 1, 1]));
  assert.deepEqual(plan.buckets, current);
  assert.deepEqual(plan.withheld, []);
  assert.equal(plan.preserveBuckets.size, 0);
  assert.deepEqual({ current, state }, original);
});

test('early empty run uses state parserMeta fallback and preserves legacy group keys against pruning', () => {
  const group = bucket({ model: 'group/pi' });
  const otherToolKey = bucketKey(bucket({ source: 'craft-agent' }));
  const state = {
    buckets: { [bucketKey(group)]: 'uploaded-hash', [otherToolKey]: 'craft-hash' },
    sessions: {},
    parserMeta: { omp: { magpie: { resolved: 3, unresolved: 0 } } },
  };
  const plan = planMagpieMigration([], state, new Map());
  assert.deepEqual([...plan.preserveBuckets], [bucketKey(group)]);
  assert.deepEqual(plan.withheld, [{ source: 'omp', windows: 1, buckets: 0, totalTokens: 0, earliest: T, latest: T }]);
  pruneState(state, plan.preserveBuckets, new Set(), new Set(['omp', 'craft-agent']));
  assert.equal(state.buckets[bucketKey(group)], 'uploaded-hash');
  assert.equal(state.buckets[otherToolKey], undefined);
});

test('vanished sessions retain uploaded real-model keys so a restored session cannot upload a group duplicate', () => {
  for (const [resolved, unresolved] of [[0, 1], [1, 0]]) {
    const real = bucket();
    const fallback = bucket({ model: 'group/pi' });
    const state = stateOf(real);
    state.parserMeta = { omp: { magpie: { resolved, unresolved } } };
    const vanished = planMagpieMigration([], state, new Map());
    pruneState(state, vanished.preserveBuckets, new Set(), new Set(['omp']));
    assert.equal(state.buckets[bucketKey(real)], 'uploaded-hash');
    const restored = planMagpieMigration([fallback], state, infoMap(['omp', 0, 1]));
    assert.deepEqual(restored.buckets, []);
    assert.equal(restored.preserveBuckets.has(bucketKey(real)), true);
  }
});

test('partially vanished alias sessions retain cloud ownership while sibling models survive', () => {
  const alias = bucket({ model: 'group/pi' });
  const sibling = bucket({ model: 'ordinary-model' });
  const state = stateOf(alias, sibling);
  const partial = planMagpieMigration([sibling], state, infoMap(['omp', 0, 1]));
  pruneState(state, new Set([...partial.preserveBuckets, bucketKey(sibling)]), new Set(), new Set(['omp']));
  assert.equal(state.buckets[bucketKey(alias)], 'uploaded-hash');
  const restored = planMagpieMigration([bucket(), sibling], state, infoMap(['omp', 1, 0]));
  assert.deepEqual(restored.buckets, []);
  assert.equal(restored.preserveBuckets.has(bucketKey(alias)), true);
});

test('sync reports frozen windows in quiet mode, uploads new windows and sessions, and preserves state across multiple runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-magpie-migration-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const home = join(root, 'home');
  for (const dir of [configDir, stateDir, home]) mkdirSync(dir, { recursive: true });
  const legacyGroup = bucket({ model: 'group/pi', project: 'unknown' });
  const legacyReal = bucket({ source: 'pi-coding-agent', project: 'unknown' });
  const legacyKimi = bucket({ source: 'kimi-code', project: 'unknown' });
  const state = stateOf(legacyGroup, legacyReal, legacyKimi);
  const received = [];
  const server = createServer((req, res) => {
    if (req.url === '/api/usage/settings') { res.end(JSON.stringify({ uploadProject: false })); return; }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const payload = JSON.parse(gunzipSync(Buffer.concat(chunks)));
      received.push(payload);
      res.end(JSON.stringify({ ingested: payload.buckets.length, sessions: payload.sessions?.length ?? 0 }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    VIBE_USAGE_DEV: '0', VIBE_USAGE_CONFIG_DIR: configDir, VIBE_USAGE_STATE_DIR: stateDir };

  const fixture = {
    omp: { buckets: [bucket(), bucket({ model: 'group/pi' }), bucket({ bucketStart: NEXT })],
      sessions: [{ source: 'omp', project: 'fixture', sessionHash: 'fixture-session',
        firstMessageAt: T, lastMessageAt: NEXT, durationSeconds: 1800, activeSeconds: 60,
        messageCount: 2, userMessageCount: 1, userPromptHours: [12] }], info: { magpie: { resolved: 1, unresolved: 0 } } },
    'pi-coding-agent': { buckets: [bucket({ source: 'pi-coding-agent', model: 'group/pi' }),
      bucket({ source: 'pi-coding-agent', model: 'group/pi', bucketStart: NEXT })],
    sessions: [], info: { magpie: { resolved: 0, unresolved: 2 } } },
    kiki: { buckets: [bucket({ source: 'kiki' })], sessions: [] },
  };
  const command = quiet => `
    import { parsers } from './src/parsers/index.js';
    for (const source of Object.keys(parsers)) delete parsers[source];
    for (const [source, result] of Object.entries(${JSON.stringify(fixture)})) parsers[source] = async () => result;
    const { runSync } = await import('./src/sync.js');
    await runSync({ quiet: ${quiet}, throws: true });
  `;
  const exec = promisify(execFile);
  try {
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      apiKey: 'vbu_synthetic_magpie', apiUrl: `http://127.0.0.1:${server.address().port}`, hostname: 'fixture-host',
    }));
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify(state));

    // First sync: quiet mode
    const first = await exec(process.execPath, ['--input-type=module', '-e', command(true)], { cwd: process.cwd(), env });
    assert.match(first.stderr, /omp:.*Magpie.*保留/);
    assert.match(first.stderr, /pi-coding-agent:.*Magpie.*保留/);
    assert.match(first.stderr, /新窗口照常/);
    assert.deepEqual(received.flatMap(p => p.buckets).map(b => [b.source, b.model, b.project, b.bucketStart]), [
      ['omp', 'gpt-6', 'unknown', NEXT], ['pi-coding-agent', 'group/pi', 'unknown', NEXT],
    ]);
    assert.equal(received.flatMap(p => p.sessions ?? []).length, 1);
    const savedAfterFirst = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
    for (const key of Object.keys(state.buckets)) {
      assert.equal(savedAfterFirst.buckets[key], 'uploaded-hash');
    }

    // Second sync: non-quiet mode, verify consecutive sync preserves old state without re-uploading
    const second = await exec(process.execPath, ['--input-type=module', '-e', command(false)], { cwd: process.cwd(), env });
    assert.match(second.stderr, /Magpie.*保留/);
    assert.doesNotMatch(second.stdout, /无新增数据/);
    assert.equal(received.length, 1);
    const savedAfterSecond = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
    for (const key of Object.keys(state.buckets)) {
      assert.equal(savedAfterSecond.buckets[key], 'uploaded-hash');
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
