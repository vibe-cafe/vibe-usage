import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from '../src/parsers/codex.js';
import {
  CODEX_ULTRAFAST_ALL_HISTORY,
  codexUltrafastModel,
  codexUltrafastStartMs,
  proposeCodexUltrafastStart,
  resolveCodexUltrafastCut,
} from '../src/codex-ultrafast.js';
import { chooseMagpieStartAt } from '../src/magpie-migration.js';
import {
  MODEL, ULTRAFAST_TIER_VALUE, W1000, W1030, W1100, at,
  mixedSession, sessionMeta, threadSettingsApplied, tokenCount, turnContext, usage,
} from './fixtures/codex-ultrafast/rollout.js';

const previousCindyDirs = process.env.VIBE_USAGE_CINDY_DIRS;
process.env.VIBE_USAGE_CINDY_DIRS = join(tmpdir(), 'vibe-usage-cindy-disabled');
test.after(() => {
  if (previousCindyDirs === undefined) delete process.env.VIBE_USAGE_CINDY_DIRS;
  else process.env.VIBE_USAGE_CINDY_DIRS = previousCindyDirs;
});

const UF = `${MODEL}-ultrafast`;
const tokens = b => b.inputTokens + b.outputTokens + b.cachedInputTokens + b.reasoningOutputTokens;
/** `{ '<model>@<HH:MM>': tokens }` -- every bucket key of a result, order-free. */
const byKey = result => Object.fromEntries(
  result.buckets.map(b => [`${b.model}@${b.bucketStart.slice(11, 16)}`, tokens(b)]).sort(),
);
/** Everything that is uploaded, order-free, for exact equality between parse paths. */
const uploaded = result => ({
  buckets: [...result.buckets].sort((a, b) => `${a.model}|${a.bucketStart}`.localeCompare(`${b.model}|${b.bucketStart}`)),
  sessions: [...result.sessions].sort((a, b) => a.sessionHash.localeCompare(b.sessionHash)),
});

function createFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codex-ultrafast-'));
  const dir = join(root, 'sessions', '2026', '11', '10');
  mkdirSync(dir, { recursive: true });
  for (const [name, records] of Object.entries(files)) {
    writeFileSync(join(dir, name), records.map(JSON.stringify).join('\n') + '\n');
  }
  return { root, dir, cacheDir: join(root, 'cache') };
}

async function withFixture(files, fn) {
  const fixture = createFixture(files);
  const keys = ['CODEX_HOME', 'VIBE_USAGE_CACHE_DIR', 'VIBE_USAGE_CODEX_CACHE'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.CODEX_HOME = fixture.root;
  process.env.VIBE_USAGE_CACHE_DIR = fixture.cacheDir;
  delete process.env.VIBE_USAGE_CODEX_CACHE;
  try {
    return await fn(fixture);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
}
const parseAt = startAt => parse({ codexUltrafastStartAt: startAt });
async function parseUncached(startAt) {
  process.env.VIBE_USAGE_CODEX_CACHE = '0';
  try { return await parseAt(startAt); } finally { delete process.env.VIBE_USAGE_CODEX_CACHE; }
}

// ------------------------------------------------------------------ helpers ---
test('cut parsing: null means no cut, the epoch is all history, anything else must be a UTC instant', () => {
  assert.equal(codexUltrafastStartMs(undefined), null);
  assert.equal(codexUltrafastStartMs(null), null);
  assert.equal(codexUltrafastStartMs(CODEX_ULTRAFAST_ALL_HISTORY), 0);
  assert.equal(codexUltrafastStartMs(W1030), Date.parse(W1030));
  assert.equal(codexUltrafastStartMs('2026-11-10T10:45:00Z'), Date.parse('2026-11-10T10:45:00Z'));
  for (const value of ['none', '', '2026-11-10T10:30:00', '2026-11-10T18:30:00+08:00', 0, {}]) {
    assert.throws(() => codexUltrafastStartMs(value), /起点/);
  }
});

test('naming: the suffix applies from the cut on, never without a cut', () => {
  const cut = Date.parse(W1030);
  assert.equal(codexUltrafastModel(MODEL, W1000, cut), MODEL);
  assert.equal(codexUltrafastModel(MODEL, W1030, cut), UF);
  assert.equal(codexUltrafastModel(MODEL, W1100, cut), UF);
  assert.equal(codexUltrafastModel(MODEL, W1100, null), MODEL);
  assert.equal(codexUltrafastModel(MODEL, '2025-01-01T00:00:00.000Z', 0), UF);
});

test('cut proposal: the five cases, same rule as the Magpie cut but for Codex windows only', () => {
  const key = (source, bucketStart) => `${source}|${MODEL}|fixture|fixture-host|${bucketStart}`;
  const state = { buckets: { [key('codex', W1000)]: 'h', [key('claude-code', W1100)]: 'h' }, sessions: {} };
  const empty = { buckets: { [key('claude-code', W1100)]: 'h' }, sessions: {} };
  // 1. no background service: any sync may propose
  assert.equal(proposeCodexUltrafastStart(state, { daemonInstalled: false, surface: 'cli' }), W1030);
  // 2. service installed, this is not it: no proposal
  for (const surface of ['cli', 'mac-app', 'windows-app']) {
    assert.equal(proposeCodexUltrafastStart(state, { daemonInstalled: true, surface }), undefined);
  }
  // 3. the service itself
  assert.equal(proposeCodexUltrafastStart(state, { daemonInstalled: true, surface: 'daemon' }), W1030);
  // 4. the upload identity just changed: the end of the current half hour
  const now = Date.parse('2026-11-12T12:32:00Z');
  assert.equal(
    proposeCodexUltrafastStart({ buckets: {}, sessions: {}, identityChanged: true }, { daemonInstalled: false, surface: 'cli', now }),
    '2026-11-12T13:00:00.000Z',
  );
  // 5. nothing uploaded for Codex: all local history
  assert.equal(proposeCodexUltrafastStart(empty, { daemonInstalled: false, surface: 'cli' }), CODEX_ULTRAFAST_ALL_HISTORY);
  // The Magpie rule itself is untouched by sharing the helper.
  assert.equal(chooseMagpieStartAt(state, { daemonInstalled: false, surface: 'cli' }), '2026-11-10T11:30:00.000Z');
  assert.equal(chooseMagpieStartAt({ buckets: {}, sessions: {} }, { daemonInstalled: false, surface: 'cli' }), 'none');
});

test('cut resolution: hold without an answer, read a registered cut, register only when eligible', async () => {
  const neverRegister = { propose: () => { throw new Error('must not propose'); }, register: () => { throw new Error('must not register'); } };
  // No confirmed settings (cached fallback) or a server that does not report the cut: hold.
  assert.deepEqual(await resolveCodexUltrafastCut({ settings: null, ...neverRegister }), { hold: true });
  assert.deepEqual(await resolveCodexUltrafastCut({ settings: { uploadProject: true }, ...neverRegister }), { hold: true });
  assert.deepEqual(await resolveCodexUltrafastCut({ settings: { codexUltrafast: {} }, ...neverRegister }), { hold: true });
  assert.deepEqual(await resolveCodexUltrafastCut({ settings: { codexUltrafast: { startAt: 'soon' } }, ...neverRegister }), { hold: true });
  // A registered cut is used as-is; nothing is proposed.
  assert.deepEqual(await resolveCodexUltrafastCut({ settings: { codexUltrafast: { startAt: W1030 } }, ...neverRegister }), { startAt: W1030 });

  const none = { codexUltrafast: { startAt: null } };
  // Not eligible: merged format, no request.
  assert.deepEqual(await resolveCodexUltrafastCut({ settings: none, propose: () => undefined, register: neverRegister.register }), { startAt: null });
  // Eligible: the server's answer wins over the proposal.
  const proposals = [];
  assert.deepEqual(await resolveCodexUltrafastCut({
    settings: none,
    propose: () => W1030,
    register: async (proposed) => { proposals.push(proposed); return { startAt: W1100, created: true }; },
  }), { startAt: W1100, registered: true });
  assert.deepEqual(proposals, [W1030]);
  // A failed registration leaves this run without a cut; a nonsense answer holds.
  assert.deepEqual(await resolveCodexUltrafastCut({ settings: none, propose: () => W1030, register: async () => { throw new Error('offline'); } }), { startAt: null });
  assert.deepEqual(await resolveCodexUltrafastCut({ settings: none, propose: () => W1030, register: async () => ({}) }), { startAt: null });
  assert.deepEqual(await resolveCodexUltrafastCut({ settings: none, propose: () => W1030, register: async () => ({ startAt: 'soon' }) }), { hold: true });
});

// ------------------------------------------------------------------- naming ---
test('before the cut one merged bucket, from the cut on standard and Ultrafast are two buckets', async () => {
  await withFixture({ 'rollout-mixed.jsonl': mixedSession() }, async () => {
    // No cut: exactly what every earlier release uploads.
    for (const startAt of [undefined, null]) {
      assert.deepEqual(byKey(await parseAt(startAt)), { [`${MODEL}@10:00`]: 55, [`${MODEL}@10:30`]: 100 });
    }
    // Cut at 10:30: the 10:29 Ultrafast call still grows the merged 10:00 bucket.
    assert.deepEqual(byKey(await parseAt(W1030)), { [`${MODEL}@10:00`]: 55, [`${MODEL}@10:30`]: 60, [`${UF}@10:30`]: 40 });
    // Cut after everything: nothing is split.
    assert.deepEqual(byKey(await parseAt(W1100)), { [`${MODEL}@10:00`]: 55, [`${MODEL}@10:30`]: 100 });
    // All history.
    assert.deepEqual(byKey(await parseAt(CODEX_ULTRAFAST_ALL_HISTORY)), {
      [`${MODEL}@10:00`]: 50, [`${UF}@10:00`]: 5, [`${MODEL}@10:30`]: 60, [`${UF}@10:30`]: 40,
    });
    // The split never changes the total or the session.
    const merged = await parseAt(null);
    const split = await parseAt(CODEX_ULTRAFAST_ALL_HISTORY);
    assert.equal(split.buckets.reduce((sum, b) => sum + tokens(b), 0), 155);
    assert.deepEqual(split.sessions, merged.sessions);
  });
});

test('pure standard and pure Ultrafast windows', async () => {
  await withFixture({
    'rollout-pure.jsonl': [
      sessionMeta(at('10:05'), 'pure'),
      turnContext(at('10:05'), { model: MODEL, serviceTier: 'default' }),
      tokenCount(at('10:06'), usage(100), 100),
      turnContext(at('10:35'), { model: MODEL, serviceTier: ULTRAFAST_TIER_VALUE }),
      tokenCount(at('10:36'), usage(70, 30), 200),
    ],
  }, async () => {
    assert.deepEqual(byKey(await parseAt(null)), { [`${MODEL}@10:00`]: 100, [`${MODEL}@10:30`]: 100 });
    assert.deepEqual(byKey(await parseAt(W1000)), { [`${MODEL}@10:00`]: 100, [`${UF}@10:30`]: 100 });
  });
});

test('fast, priority, flex and batch are byte-for-byte what they were, with or without a cut', async () => {
  const records = [sessionMeta(at('10:01'), 'tiers')];
  let total = 0;
  const call = (minute, model, serviceTier) => {
    records.push(turnContext(at(`10:${minute}`), { model, serviceTier }), tokenCount(at(`10:${minute}`, '30'), usage(10, 2, { cached: 4, reasoning: 1 }), total += 12));
  };
  call('02', MODEL, 'fast'); call('03', MODEL, 'priority'); call('04', MODEL, 'flex'); call('05', MODEL, 'batch');
  call('06', MODEL, 'Fast'); call('07', MODEL, 'scale'); call('08', MODEL, null); call('09', MODEL, undefined);
  // Before the 2026-08-31 fixed start a tier is never appended.
  const old = [
    sessionMeta('2026-08-30T09:01:00.000Z', 'old-tiers'),
    turnContext('2026-08-30T09:02:00.000Z', { model: MODEL, serviceTier: 'fast' }),
    tokenCount('2026-08-30T09:02:30.000Z', usage(10), 10),
  ];
  await withFixture({ 'rollout-tiers.jsonl': records, 'rollout-old.jsonl': old }, async () => {
    const baseline = await parseAt(null);
    assert.deepEqual(byKey(baseline), {
      [`${MODEL}-fast@10:00`]: 24,
      [`${MODEL}-priority@10:00`]: 12,
      [`${MODEL}-flex@10:00`]: 12,
      [`${MODEL}-batch@10:00`]: 12,
      // 'scale' is not a tier we price, null clears the tier, an absent field
      // keeps the tier in force (none here).
      [`${MODEL}@10:00`]: 36,
      // 2026-08-30, before the fixed start: `fast` is not appended.
      [`${MODEL}@09:00`]: 10,
    });
    const fast = baseline.buckets.find(b => b.model === `${MODEL}-fast`);
    assert.deepEqual(
      [fast.inputTokens, fast.outputTokens, fast.cachedInputTokens, fast.reasoningOutputTokens],
      [12, 2, 8, 2],
    );
    for (const startAt of [CODEX_ULTRAFAST_ALL_HISTORY, W1000, W1100]) {
      assert.deepEqual(await parseAt(startAt).then(uploaded), uploaded(baseline), startAt);
    }
  });
});

test('tier and model switches inside a session, both record shapes, and the unknown model', async () => {
  await withFixture({
    'rollout-switch.jsonl': [
      sessionMeta(at('10:31'), 'switch'),
      // thread_settings_applied carries the tier too
      threadSettingsApplied(at('10:31'), { model: MODEL, serviceTier: ULTRAFAST_TIER_VALUE }),
      tokenCount(at('10:32'), usage(10), 10),
      // a turn without the field keeps the tier in force
      turnContext(at('10:33'), { model: MODEL }),
      tokenCount(at('10:34'), usage(20), 30),
      // another model, still Ultrafast: not limited to a model list
      turnContext(at('10:35'), { model: 'gpt-6.2-astra', serviceTier: 'ULTRAFAST' }),
      tokenCount(at('10:36'), usage(30), 60),
      // back to standard, then fast
      turnContext(at('10:37'), { model: 'gpt-6.2-astra', serviceTier: 'default' }),
      tokenCount(at('10:38'), usage(40), 100),
      turnContext(at('10:39'), { model: 'gpt-6.2-astra', serviceTier: 'fast' }),
      tokenCount(at('10:40'), usage(50), 150),
    ],
    'rollout-unknown.jsonl': [
      sessionMeta(at('10:31'), 'unknown-model'),
      turnContext(at('10:31'), { serviceTier: ULTRAFAST_TIER_VALUE }),
      tokenCount(at('10:32'), usage(7), 7),
    ],
  }, async () => {
    assert.deepEqual(byKey(await parseAt(W1030)), {
      [`${UF}@10:30`]: 30,
      'gpt-6.2-astra-ultrafast@10:30': 30,
      'gpt-6.2-astra@10:30': 40,
      'gpt-6.2-astra-fast@10:30': 50,
      'unknown@10:30': 7,
    });
    assert.deepEqual(byKey(await parseAt(null)), {
      [`${MODEL}@10:30`]: 30,
      'gpt-6.2-astra@10:30': 70,
      'gpt-6.2-astra-fast@10:30': 50,
      'unknown@10:30': 7,
    });
  });
});

test('a session routed through Magpie keeps its plain model name (not handled in this change)', async () => {
  await withFixture({
    'rollout-magpie.jsonl': [
      sessionMeta(at('10:31'), 'via-magpie', { model_provider: 'magpie' }),
      turnContext(at('10:31'), { model: MODEL, serviceTier: ULTRAFAST_TIER_VALUE }),
      tokenCount(at('10:32'), usage(40), 40),
    ],
  }, async () => {
    for (const startAt of [null, CODEX_ULTRAFAST_ALL_HISTORY]) {
      assert.deepEqual(byKey(await parseAt(startAt)), { [`${MODEL}@10:30`]: 40 });
    }
  });
});

// -------------------------------------------------------------------- cache ---
test('cold, warm, appended and uncached reads give the same result for every cut', async () => {
  const records = mixedSession();
  await withFixture({ 'rollout-mixed.jsonl': records.slice(0, 5) }, async (fixture) => {
    const file = join(fixture.dir, 'rollout-mixed.jsonl');
    const cuts = [null, W1030, CODEX_ULTRAFAST_ALL_HISTORY];
    const cold = await parseAt(null);
    assert.equal(cold.cache.resultHits, 0);
    for (const startAt of cuts) {
      const warm = await parseAt(startAt);
      // One summary serves every cut: the cut is applied after the cache.
      assert.equal(warm.cache.filesRead, 0, String(startAt));
      assert.equal(warm.cache.resultHits, 1, String(startAt));
      assert.deepEqual(uploaded(warm), uploaded(await parseUncached(startAt)), String(startAt));
    }

    // Append the 10:30 window, two turns at a time: the tail carries the tier
    // across reads, including an Ultrafast turn whose tokens arrive later.
    appendFileSync(file, records.slice(5, 8).map(JSON.stringify).join('\n') + '\n');
    const first = await parseAt(W1030);
    assert.equal(first.cache.tailHits, 1);
    assert.deepEqual(byKey(first), { [`${MODEL}@10:00`]: 55, [`${MODEL}@10:30`]: 60 });
    appendFileSync(file, records.slice(8).map(JSON.stringify).join('\n') + '\n');
    for (const startAt of cuts) {
      const appended = await parseAt(startAt);
      assert.deepEqual(uploaded(appended), uploaded(await parseUncached(startAt)), String(startAt));
    }
    assert.deepEqual(byKey(await parseAt(W1030)), { [`${MODEL}@10:00`]: 55, [`${MODEL}@10:30`]: 60, [`${UF}@10:30`]: 40 });
  });
});

test('continuation segments of one session and an archive move keep the same keys', async () => {
  const records = mixedSession('segmented');
  const header = records[0];
  await withFixture({
    'rollout-a.jsonl': records.slice(0, 5),
    // The second file repeats the header, then continues with its own turns.
    'rollout-b.jsonl': [header, ...records.slice(5)],
  }, async (fixture) => {
    const expected = { [`${MODEL}@10:00`]: 55, [`${MODEL}@10:30`]: 60, [`${UF}@10:30`]: 40 };
    const cold = await parseAt(W1030);
    assert.deepEqual(byKey(cold), expected);
    assert.equal(cold.sessions.length, 1);
    const warm = await parseAt(W1030);
    assert.equal(warm.cache.filesRead, 0);
    assert.deepEqual(uploaded(warm), uploaded(cold));
    assert.deepEqual(uploaded(await parseUncached(W1030)), uploaded(cold));
    assert.deepEqual(byKey(await parseAt(null)), { [`${MODEL}@10:00`]: 55, [`${MODEL}@10:30`]: 100 });

    // Codex archives a finished session by moving its file.
    const archived = join(fixture.root, 'archived_sessions');
    mkdirSync(archived, { recursive: true });
    renameSync(join(fixture.dir, 'rollout-b.jsonl'), join(archived, 'rollout-b.jsonl'));
    assert.deepEqual(uploaded(await parseAt(W1030)), uploaded(cold));
  });
});

// -------------------------------------------------- entries from algorithm 6 ---
// Turn the cache into what 0.14.12 (algorithm 6) left behind: Ultrafast usage
// folded into the plain model's buckets, the tier remembered as "no tier", and
// the files one level up, in the per-home directory versions before 7 used.
function foldUltrafast(owner) {
  const merged = new Map();
  for (const bucket of [...(owner.buckets || []), ...(owner.ultrafastBuckets || [])]) {
    const key = `${bucket.model}|${bucket.project}|${bucket.bucketStart}`;
    const sum = merged.get(key);
    if (!sum) { merged.set(key, { ...bucket }); continue; }
    for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'totalTokens']) {
      sum[field] = (sum[field] || 0) + (bucket[field] || 0);
    }
  }
  owner.buckets = [...merged.values()];
  delete owner.ultrafastBuckets;
}
function asAlgorithm6(data) {
  data.algorithmVersion = 6;
  if (data.result) foldUltrafast(data.result);
  if (data.tail) {
    foldUltrafast(data.tail);
    if (data.tail.serviceTier === 'ultrafast') data.tail.serviceTier = null;
  }
  return `${JSON.stringify(data)}\n`;
}
function downgradeCacheToAlgorithm6(cacheDir) {
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { visit(path); continue; }
      if (!entry.name.endsWith('.json') || basename(dir) !== 'v7') continue;
      writeFileSync(join(dirname(dir), entry.name), asAlgorithm6(JSON.parse(readFileSync(path, 'utf8'))));
      rmSync(path);
    }
  };
  visit(cacheDir);
}
/** `{ relative path: content }` of every cache file an older version owns. */
function olderCacheFiles(cacheDir) {
  const files = {};
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'v7') visit(path); continue; }
      files[path.slice(cacheDir.length)] = readFileSync(path, 'utf8');
    }
  };
  visit(cacheDir);
  return files;
}

test('algorithm-6 summaries are used as they are while the machine has no cut, and are not rewritten', async () => {
  await withFixture({ 'rollout-mixed.jsonl': mixedSession(), 'rollout-other.jsonl': mixedSession('other') }, async (fixture) => {
    const cold = await parseAt(null);
    downgradeCacheToAlgorithm6(fixture.cacheDir);
    const older = olderCacheFiles(fixture.cacheDir);
    assert.equal(Object.keys(older).length, 4, 'two summaries and two tails');
    const warm = await parseAt(null);
    assert.equal(warm.cache.filesRead, 0);
    assert.equal(warm.cache.resultHits, 2);
    assert.deepEqual(uploaded(warm), uploaded(cold));
    // Nothing an older collector owns was written, restamped or removed --
    // neither by using its summaries nor by re-reading under a cut.
    await parseAt(W1030);
    await parseAt(CODEX_ULTRAFAST_ALL_HISTORY);
    assert.deepEqual(olderCacheFiles(fixture.cacheDir), older);
  });
});

test('algorithm-6 summaries wholly before the cut are kept; one with a window at or after it is re-read', async () => {
  await withFixture({
    // Only the 10:00 window.
    'rollout-early.jsonl': mixedSession('early').slice(0, 5),
    // Reaches into 10:30.
    'rollout-late.jsonl': mixedSession('late'),
  }, async (fixture) => {
    const expected = await parseUncached(W1030);
    await parseAt(null);
    downgradeCacheToAlgorithm6(fixture.cacheDir);

    const afterCut = await parseAt(W1030);
    assert.equal(afterCut.cache.resultHits, 1, 'the early rollout comes from its algorithm-6 summary');
    assert.equal(afterCut.cache.filesRead, 1, 'only the rollout with a post-cut window is read again');
    assert.deepEqual(uploaded(afterCut), uploaded(expected));
    assert.deepEqual(byKey(afterCut), {
      [`${MODEL}@10:00`]: 110, [`${MODEL}@10:30`]: 60, [`${UF}@10:30`]: 40,
    });

    // The rebuilt summary is cut-independent from now on.
    const again = await parseAt(W1030);
    assert.equal(again.cache.filesRead, 0);
    assert.deepEqual(uploaded(again), uploaded(expected));
    // With the cut at the epoch even the early summary has to go.
    const all = await parseAt(CODEX_ULTRAFAST_ALL_HISTORY);
    assert.equal(all.cache.filesRead, 1);
    assert.deepEqual(uploaded(all), uploaded(await parseUncached(CODEX_ULTRAFAST_ALL_HISTORY)));
  });
});

test('an algorithm-6 tail is never resumed: it lost the Ultrafast tier', async () => {
  const records = mixedSession();
  // Stop inside an Ultrafast turn whose tokens have not been written yet.
  await withFixture({ 'rollout-mixed.jsonl': records.slice(0, 8) }, async (fixture) => {
    await parseAt(null);
    downgradeCacheToAlgorithm6(fixture.cacheDir);
    appendFileSync(join(fixture.dir, 'rollout-mixed.jsonl'), `${JSON.stringify(records[8])}\n`);
    const appended = await parseAt(W1030);
    assert.equal(appended.cache.tailHits, 0);
    // Resuming from the old tail would have filed these 40 tokens under the plain model.
    assert.deepEqual(byKey(appended), { [`${MODEL}@10:00`]: 55, [`${MODEL}@10:30`]: 60, [`${UF}@10:30`]: 40 });
  });
});
