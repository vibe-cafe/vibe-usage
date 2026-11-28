import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  appendFileSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from '../src/parsers/codex.js';
import { CODEX_PARSER_ALGORITHM_VERSION, codexCacheDir, olderCodexCacheDir } from '../src/parsers/codex-cache.js';

// The per-home manifest (codex-cache.js): a warm sync starts from it without
// opening the entries, and reads a full replay index only for the boundary of
// a fork or sub-agent whose own or parent's file changed. All fixtures are
// synthetic.

const previousCindyDirs = process.env.VIBE_USAGE_CINDY_DIRS;
process.env.VIBE_USAGE_CINDY_DIRS = join(tmpdir(), 'vibe-usage-cindy-disabled');
test.after(() => {
  if (previousCindyDirs === undefined) delete process.env.VIBE_USAGE_CINDY_DIRS;
  else process.env.VIBE_USAGE_CINDY_DIRS = previousCindyDirs;
});

const DAY_DIR = join('sessions', '2026', '07', '10');

function sessionMeta(timestamp, id, extra = {}) {
  return { timestamp, type: 'session_meta', payload: { id, cwd: '/Users/x/proj', timestamp, ...extra } };
}

function tokenCount(timestamp, input, cumulativeTotal, model = 'gpt-5.2') {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model,
        total_token_usage: { total_tokens: cumulativeTotal },
        last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: input + 1 },
      },
    },
  };
}

const jsonl = records => `${records.map(record => JSON.stringify(record)).join('\n')}\n`;

const parent = jsonl([
  sessionMeta('2026-07-10T08:00:00.000Z', 'parent-1'),
  { type: 'turn_context', timestamp: '2026-07-10T08:00:00.000Z', payload: { model: 'gpt-5.2' } },
  tokenCount('2026-07-10T08:05:00.000Z', 1000, 1001),
  { timestamp: '2026-07-10T08:06:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: '父会话 ✓'.repeat(200) } },
  tokenCount('2026-07-10T08:20:00.000Z', 2000, 3002),
]);
const parentFile = 'rollout-2026-07-10T08-00-00-parent-1.jsonl';
// A fork that replays the parent's two calls, then makes its own.
const fork = jsonl([
  sessionMeta('2026-07-10T09:00:00.000Z', 'fork-1', { forked_from_id: 'parent-1' }),
  { ...tokenCount('2026-07-10T08:05:00.000Z', 1000, 1001), timestamp: '2026-07-10T09:00:00.000Z' },
  { ...tokenCount('2026-07-10T08:20:00.000Z', 2000, 3002), timestamp: '2026-07-10T09:00:00.000Z' },
  tokenCount('2026-07-10T09:01:00.000Z', 5, 3008),
]);
const forkFile = 'rollout-2026-07-10T09-00-00-fork-1.jsonl';
const plain = jsonl([
  sessionMeta('2026-07-10T07:00:00.000Z', 'plain-1'),
  tokenCount('2026-07-10T07:05:00.000Z', 300, 301),
]);
const plainFile = 'rollout-2026-07-10T07-00-00-plain-1.jsonl';

/** `~/.codex` and one extra home holding hard links, as Orca keeps them. */
async function withHomes(fn) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codex-manifest-'));
  const homes = { codex: join(root, 'a-codex'), orca: join(root, 'b-orca') };
  for (const home of Object.values(homes)) mkdirSync(join(home, DAY_DIR), { recursive: true });
  const saved = {
    CODEX_HOME: process.env.CODEX_HOME,
    VIBE_USAGE_CACHE_DIR: process.env.VIBE_USAGE_CACHE_DIR,
    VIBE_USAGE_CODEX_WORK_BUDGET_MS: process.env.VIBE_USAGE_CODEX_WORK_BUDGET_MS,
    VIBE_USAGE_CODEX_CACHE: process.env.VIBE_USAGE_CODEX_CACHE,
    VIBE_USAGE_CODEX_AUDIT_INTERVAL_MS: process.env.VIBE_USAGE_CODEX_AUDIT_INTERVAL_MS,
  };
  process.env.CODEX_HOME = homes.codex;
  process.env.VIBE_USAGE_CACHE_DIR = join(root, 'cache');
  process.env.VIBE_USAGE_CODEX_WORK_BUDGET_MS = '600000';
  delete process.env.VIBE_USAGE_CODEX_CACHE;
  delete process.env.VIBE_USAGE_CODEX_AUDIT_INTERVAL_MS;
  const file = (home, name) => join(homes[home], DAY_DIR, name);
  const run = (options = {}) => parse({ extraRoots: [homes.orca], ...options });
  const uncached = async (options = {}) => {
    process.env.VIBE_USAGE_CODEX_CACHE = '0';
    try { return await run(options); } finally { delete process.env.VIBE_USAGE_CODEX_CACHE; }
  };
  try {
    return await fn({ root, homes, file, run, uncached });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function view(result) {
  return {
    buckets: [...result.buckets].sort((a, b) => `${a.bucketStart}${a.model}${a.project}`.localeCompare(`${b.bucketStart}${b.model}${b.project}`)),
    sessions: [...result.sessions].sort((a, b) => a.sessionHash.localeCompare(b.sessionHash)),
  };
}

const totalInput = result => result.buckets.reduce((sum, bucket) => sum + bucket.inputTokens, 0);

/** Every cache file a call reads (readFileSync), relative to the cache directory. */
async function readsDuring(root, fn) {
  const real = fs.readFileSync;
  const reads = [];
  fs.readFileSync = (path, ...rest) => {
    const text = String(path);
    if (text.startsWith(join(root, 'cache') + sep)) reads.push(text.slice(join(root, 'cache').length + 1));
    return real(path, ...rest);
  };
  syncBuiltinESMExports();
  try {
    return { result: await fn(), reads };
  } finally {
    fs.readFileSync = real;
    syncBuiltinESMExports();
  }
}

/**
 * Date.now() under the test's control for the rest of the test, so nothing
 * depends on how fine the machine's clock is: from a fixed instant, one
 * millisecond per call (every audit time differs), or -- onlyOnReads() -- only
 * when a file is opened, which is how a test runs a sync out of budget at a
 * chosen point.
 */
function controlledClock() {
  const realNow = Date.now;
  const realCreateReadStream = fs.createReadStream;
  let now = Date.parse('2026-07-20T00:00:00.000Z');
  let perRead = false;
  Date.now = () => (perRead ? now : ++now);
  fs.createReadStream = (...args) => {
    if (perRead) now++;
    return realCreateReadStream(...args);
  };
  syncBuiltinESMExports();
  return {
    onlyOnReads() { perRead = true; },
    everyCall() { perRead = false; },
    restore() {
      Date.now = realNow;
      fs.createReadStream = realCreateReadStream;
      syncBuiltinESMExports();
    },
  };
}

/** Every entry this version wrote, parsed. */
function entries(homes) {
  const found = [];
  for (const home of Object.values(homes)) {
    const dir = codexCacheDir(home);
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (name.endsWith('.json')) found.push({ name, entry: JSON.parse(readFileSync(join(dir, name), 'utf8')) });
    }
  }
  return found;
}

function assertNoSlimIndexWritten(homes) {
  for (const { name, entry } of entries(homes)) {
    if (!entry.index) continue;
    for (const field of ['tokenTimes', 'tokenFingerprints', 'taskBoundaries']) {
      assert.ok(Array.isArray(entry.index[field]), `${name}: index without ${field}`);
    }
  }
}

/**
 * The plain conversation, the parent and its fork in one home, modified in
 * that order a second apart. A run summarizes the newest sessions first, a
 * parent with its newest fork: parent, fork, plain -- the order the rolling
 * audit then goes through them.
 */
function writeThree(file) {
  const base = Date.parse('2026-07-10T10:00:00.000Z') / 1000;
  [[plainFile, plain], [parentFile, parent], [forkFile, fork]].forEach(([name, text], i) => {
    writeFileSync(file('codex', name), text);
    utimesSync(file('codex', name), base + i, base + i);
  });
}

function setUp(file) {
  writeFileSync(file('orca', parentFile), parent);
  linkSync(file('orca', parentFile), file('codex', parentFile));
  writeFileSync(file('orca', forkFile), fork);
  writeFileSync(file('codex', plainFile), plain);
}

test('a warm sync reads only the manifests and returns what an uncached read returns', async () => {
  await withHomes(async ({ root, homes, file, run, uncached }) => {
    setUp(file);
    const first = await run(); // builds the entries
    const second = await run(); // reads them, writes the manifests
    assert.equal(second.cache.filesRead, 0);
    for (const home of Object.values(homes)) {
      // Written in pieces, but exactly what JSON.stringify() of it gives.
      const text = readFileSync(join(codexCacheDir(home), 'manifest.v1'), 'utf8');
      const manifest = JSON.parse(text);
      assert.equal(text, `${JSON.stringify(manifest)}\n`, home);
      assert.equal(manifest.codexHome, home);
      assert.ok(Object.keys(manifest.records).length > 0, home);
    }
    const { result: third, reads } = await readsDuring(root, run);
    assert.deepEqual(reads.map(path => path.split(sep).at(-1)).sort(), ['manifest.v1', 'manifest.v1']);
    assert.equal(third.cache.filesRead, 0);
    assert.ok(third.cache.manifestHits >= 4, JSON.stringify(third.cache));
    assert.deepEqual(view(third), view(first));
    assert.deepEqual(view(third), view(await uncached()));
    assert.equal(totalInput(third), 3305);
    assertNoSlimIndexWritten(homes);
  });
});

test('a parent that grows makes the fork boundary be computed from full indexes again', async () => {
  await withHomes(async ({ root, homes, file, run, uncached }) => {
    setUp(file);
    await run();
    await run();
    await run();
    appendFileSync(file('orca', parentFile), jsonl([tokenCount('2026-07-10T10:00:00.000Z', 40, 3043)]));
    const { result, reads } = await readsDuring(root, run);
    // The fork's own entry is read for its full index (its record stays valid).
    assert.ok(reads.some(path => path.endsWith('.json')), JSON.stringify(reads));
    assert.deepEqual(view(result), view(await uncached()));
    assert.equal(totalInput(result), 3345, 'the fork does not count its copy of the parent again');
    const settled = await run();
    const { result: warm, reads: warmReads } = await readsDuring(root, run);
    assert.deepEqual(view(settled), view(result));
    assert.deepEqual(view(warm), view(result));
    assert.ok(warmReads.every(path => path.endsWith('manifest.v1')), JSON.stringify(warmReads));
    assertNoSlimIndexWritten(homes);
  });
});

test('writing back a cache state taken from the manifest writes the full index', async () => {
  await withHomes(async ({ homes, file, run, uncached }) => {
    // One home, no shared session: every file has a summary, so the rolling
    // audit re-reads a file's header and writes its entry back -- the fork's
    // and its parent's with an index the manifest held slim.
    writeFileSync(file('codex', parentFile), parent);
    writeFileSync(file('codex', forkFile), fork);
    writeFileSync(file('codex', plainFile), plain);
    const single = { extraRoots: [] };
    const clock = controlledClock();
    try {
      await run(single);
      await run(single);
      process.env.VIBE_USAGE_CODEX_AUDIT_INTERVAL_MS = '0';
      let audited = 0;
      for (let i = 0; i < 4; i++) {
        const result = await run(single);
        audited += result.cache.audited;
        assert.deepEqual(view(result), view(await uncached(single)));
        assertNoSlimIndexWritten(homes);
      }
      assert.equal(audited, 4);
    } finally {
      clock.restore();
    }
  });
});

test('a damaged or outdated manifest only costs the entry reads', async () => {
  await withHomes(async ({ homes, file, run, uncached }) => {
    setUp(file);
    await run();
    await run();
    writeFileSync(join(codexCacheDir(homes.codex), 'manifest.v1'), '{"schemaVersion":1,"records":');
    const damaged = await run();
    assert.equal(damaged.cache.filesRead, 0);
    assert.deepEqual(view(damaged), view(await uncached()));
    assert.match(readFileSync(join(codexCacheDir(homes.codex), 'manifest.v1'), 'utf8'), /"records"/);
    // A record for a file state that is gone: the plain conversation grew.
    appendFileSync(file('codex', plainFile), jsonl([tokenCount('2026-07-10T07:30:00.000Z', 7, 309)]));
    const grown = await run();
    assert.equal(grown.cache.tailHits, 1);
    assert.deepEqual(view(grown), view(await uncached()));
  });
});

test('a slim index whose entry is gone is built again from the rollout', async () => {
  await withHomes(async ({ homes, file, run, uncached }) => {
    setUp(file);
    await run();
    await run();
    await run();
    // The fork's own entry disappears (its record stays); then its parent grows.
    for (const { name, entry } of entries(homes)) {
      if (entry.filePath === file('orca', forkFile)) unlinkSync(join(codexCacheDir(homes.orca), name));
    }
    appendFileSync(file('orca', parentFile), jsonl([tokenCount('2026-07-10T10:00:00.000Z', 40, 3043)]));
    const result = await run();
    assert.deepEqual(view(result), view(await uncached()));
    assert.equal(totalInput(result), 3345);
    assertNoSlimIndexWritten(homes);
  });
});

test('a record of an older version\'s summary is never used', async () => {
  await withHomes(async ({ homes, file, run, uncached }) => {
    setUp(file);
    await run();
    await run();
    const path = join(codexCacheDir(homes.codex), 'manifest.v1');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const record = manifest.records[file('codex', plainFile)];
    assert.ok(record?.result, 'the plain conversation has a record with a summary');
    // An algorithm-6 summary for exactly this file state whose numbers differ,
    // so whether it is used shows in the output. Since algorithm 8 no older
    // summary stands in (its sessions have no model time), with or without a
    // cut.
    record.src = 6;
    record.result = { ...record.result, ultrafastBuckets: undefined,
      buckets: record.result.buckets.map(bucket => ({ ...bucket, inputTokens: bucket.inputTokens + 1000 })) };
    delete record.result.ultrafastBuckets;
    writeFileSync(path, JSON.stringify(manifest));
    const cut = '2026-07-10T07:00:00.000Z';
    assert.deepEqual(view(await run({ codexUltrafastStartAt: cut })), view(await uncached({ codexUltrafastStartAt: cut })));
    writeFileSync(path, JSON.stringify(manifest));
    assert.deepEqual(view(await run()), view(await uncached()));
  });
});

test('a parent that shows up later is not hidden by the fork\'s recorded summary', async () => {
  await withHomes(async ({ file, run, uncached }) => {
    // The fork alone: nothing to compare its first calls with, so they count.
    writeFileSync(file('orca', forkFile), fork);
    writeFileSync(file('codex', plainFile), plain);
    await run();
    await run();
    const alone = await run();
    assert.equal(totalInput(alone), 3305);
    // Its parent appears (restored, copied in): the copy must stop counting.
    writeFileSync(file('orca', parentFile), parent);
    const result = await run();
    assert.deepEqual(view(result), view(await uncached()));
    assert.equal(totalInput(result), 3305, 'parent 3000 + the fork\'s own 5 + plain 300');
  });
});

test('an index copied from a hard-linked twin known only by its slim index is the full one', async () => {
  await withHomes(async ({ homes, file, run, uncached }) => {
    setUp(file);
    await run();
    await run();
    // The Orca link of the parent (indexed after ~/.codex's) loses both its
    // entry and its record, so its index is taken from its twin in ~/.codex,
    // which the manifest holds slim.
    const linked = file('orca', parentFile);
    for (const { name, entry } of entries(homes)) {
      if (entry.filePath === linked) unlinkSync(join(codexCacheDir(homes.orca), name));
    }
    const path = join(codexCacheDir(homes.orca), 'manifest.v1');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    assert.ok(manifest.records[linked]);
    delete manifest.records[linked];
    writeFileSync(path, JSON.stringify(manifest));
    const result = await run();
    assert.deepEqual(view(result), view(await uncached()));
    assertNoSlimIndexWritten(homes);
    const copied = entries(homes).find(({ entry }) => entry.filePath === linked);
    assert.ok(Array.isArray(copied?.entry.index?.tokenFingerprints), 'the copy got its twin\'s full index');
  });
});

test('an entry written back when the run stops right after it still has its full index', async () => {
  await withHomes(async ({ homes, file, run }) => {
    // One home: the rolling audit re-reads a file's header and writes the
    // entry back with the index it held -- for the parent, an index the
    // manifest holds slim -- before the replay index is read again. A run that
    // stops in between leaves exactly that write behind.
    writeThree(file);
    const single = { extraRoots: [] };
    const clock = controlledClock();
    let stopped;
    try {
      await run(single);
      await run(single);
      process.env.VIBE_USAGE_CODEX_AUDIT_INTERVAL_MS = '0';
      // Audit times follow the order the files were first summarized in: the
      // parent first (writeThree()). With the clock moving only when a file is
      // opened and a 1 ms budget, the run stops at the first check after its
      // header.
      process.env.VIBE_USAGE_CODEX_WORK_BUDGET_MS = '1';
      clock.onlyOnReads();
      stopped = await run(single);
    } finally {
      clock.restore();
      process.env.VIBE_USAGE_CODEX_WORK_BUDGET_MS = '600000';
    }
    assert.equal(stopped.skipped, true);
    assert.equal(stopped.indexing?.phase, 'discovery');
    assert.equal(stopped.indexing?.completed, 2, 'stopped right after the parent');
    const parentEntry = entries(homes).find(({ entry }) => entry.filePath === file('codex', parentFile));
    assert.ok(parentEntry?.entry.index, 'the parent entry keeps an index');
    assertNoSlimIndexWritten(homes);
  });
});

test('the rolling audit moves on to the next file instead of repeating one', async () => {
  await withHomes(async ({ file, run }) => {
    writeThree(file);
    const single = { extraRoots: [] };
    const clock = controlledClock();
    const realCreateReadStream = fs.createReadStream; // the clock's own wrapper
    const audited = [];
    try {
      await run(single);
      await run(single);
      process.env.VIBE_USAGE_CODEX_AUDIT_INTERVAL_MS = '0';
      // Each run audits the file audited longest ago and reads only that one.
      for (let i = 0; i < 3; i++) {
        const opened = new Set();
        fs.createReadStream = (path, ...rest) => {
          opened.add(String(path));
          return realCreateReadStream(path, ...rest);
        };
        syncBuiltinESMExports();
        assert.equal((await run(single)).cache.audited, 1);
        assert.equal(opened.size, 1, [...opened].join());
        audited.push(...opened);
      }
    } finally {
      fs.createReadStream = realCreateReadStream;
      clock.restore();
    }
    assert.deepEqual(audited, [file('codex', parentFile), file('codex', forkFile), file('codex', plainFile)]);
  });
});

test('a fork left for the next run keeps the parent state its summary was checked against', async () => {
  await withHomes(async ({ file, run, uncached }) => {
    const single = { extraRoots: [] };
    writeFileSync(file('codex', plainFile), plain);
    writeFileSync(file('codex', forkFile), fork);
    const clock = controlledClock();
    let partial;
    try {
      await run(single);
      await run(single);
      assert.equal(totalInput(await run(single)), 3305, 'no parent yet: the fork counts all of its calls');
      // Its parent appears, and this run runs out of budget right after reading
      // the parent (its header, then its replay index: two files opened): the
      // fork's boundary changes, but the fork is left for the next run instead
      // of being summarized again.
      writeFileSync(file('codex', parentFile), parent);
      process.env.VIBE_USAGE_CODEX_WORK_BUDGET_MS = '2';
      clock.onlyOnReads();
      partial = await run(single);
    } finally {
      clock.restore();
      process.env.VIBE_USAGE_CODEX_WORK_BUDGET_MS = '600000';
    }
    assert.equal(partial.skipped, undefined, JSON.stringify(partial.indexing));
    assert.equal(partial.indexing?.phase, 'usage');
    const next = await run(single);
    assert.deepEqual(view(next), view(await uncached(single)));
    assert.equal(totalInput(next), 3305, 'parent 3000 + the fork\'s own 5 + plain 300');
  });
});

test('an algorithm-5 parent index is never taken, so a fork\'s copy of the parent never counts', async () => {
  await withHomes(async ({ homes, file, run, uncached }) => {
    const single = { extraRoots: [] };
    writeFileSync(file('codex', parentFile), parent);
    writeFileSync(file('codex', forkFile), fork);
    await run(single);
    // The parent as an algorithm-5 collector left it: its entry in the older
    // location and none of this version's, no manifest. Algorithm 5
    // fingerprinted durable usage records without their response id, so its
    // index does not match a fork indexed by this version; here the
    // fingerprints are simply made different.
    const dir = codexCacheDir(homes.codex);
    for (const { name, entry } of entries(homes)) {
      if (entry.filePath !== file('codex', parentFile)) continue;
      const older = { ...entry, algorithmVersion: 5, header: { ...entry.header }, result: { ...entry.result },
        index: { ...entry.index, tokenFingerprints: entry.index.tokenFingerprints.map(fingerprint => `v5-${fingerprint}`) } };
      delete older.header.modelProvider;
      delete older.result.magpieEntries;
      delete older.result.ultrafastBuckets;
      writeFileSync(join(olderCodexCacheDir(homes.codex), name), JSON.stringify(older));
      unlinkSync(join(dir, name));
    }
    rmSync(join(dir, 'manifest.v1'), { force: true });
    // Since algorithm 8 nothing of an algorithm-5 entry is taken, also where
    // Magpie is free and there is no cut: the parent is indexed again by this
    // version, so the fork's copy of it never counts.
    const first = await run(single);
    assert.deepEqual(view(first), view(await uncached(single)));
    assert.equal(totalInput(first), 3005);
    assert.equal(totalInput(await run(single)), 3005);
    const all = { ...single, codexUltrafastStartAt: '1970-01-01T00:00:00.000Z' };
    const rebuilt = await run(all);
    assert.deepEqual(view(rebuilt), view(await uncached(all)));
    assert.equal(totalInput(rebuilt), 3005, 'parent 3000 + the fork\'s own 5');
    assert.equal(totalInput(await run(all)), 3005);
  });
});

test('a full index that has to be built from the rollout again counts against the budget', async () => {
  await withHomes(async ({ homes, file, run, uncached }) => {
    const single = { extraRoots: [] };
    writeFileSync(file('codex', plainFile), plain);
    writeFileSync(file('codex', parentFile), parent);
    writeFileSync(file('codex', forkFile), fork);
    const clock = controlledClock();
    const realCreateReadStream = fs.createReadStream; // the clock's own wrapper
    const opened = [];
    let partial;
    try {
      await run(single);
      await run(single);
      await run(single);
      // The fork's entry is gone (its record stays), and its parent grows: the
      // fork's boundary has to be computed from a full index the entry can no
      // longer give. The parent alone (header, index, usage: three files
      // opened) uses up a 3 ms budget.
      for (const { name, entry } of entries(homes)) {
        if (entry.filePath === file('codex', forkFile)) unlinkSync(join(codexCacheDir(homes.codex), name));
      }
      appendFileSync(file('codex', parentFile), jsonl([tokenCount('2026-07-10T10:00:00.000Z', 40, 3043)]));
      process.env.VIBE_USAGE_CODEX_WORK_BUDGET_MS = '3';
      clock.onlyOnReads();
      fs.createReadStream = (path, ...rest) => {
        opened.push(String(path));
        return realCreateReadStream(path, ...rest);
      };
      syncBuiltinESMExports();
      partial = await run(single);
    } finally {
      fs.createReadStream = realCreateReadStream;
      clock.restore();
      process.env.VIBE_USAGE_CODEX_WORK_BUDGET_MS = '600000';
    }
    assert.equal(partial.indexing?.phase, 'usage', JSON.stringify(partial.indexing));
    assert.ok(!opened.includes(file('codex', forkFile)), 'the fork is left for the next run, not read past the budget');
    const next = await run(single);
    assert.deepEqual(view(next), view(await uncached(single)));
    assert.equal(totalInput(next), 3345);
  });
});

test('an algorithm-5 entry is never served from the manifest, so an entry an older collector rebuilt is used', async () => {
  await withHomes(async ({ homes, file, run, uncached }) => {
    const single = { extraRoots: [] };
    // A second fork of the same parent, which appears only at the end.
    const fork2 = jsonl([
      sessionMeta('2026-07-10T09:30:00.000Z', 'fork-2', { forked_from_id: 'parent-1' }),
      { ...tokenCount('2026-07-10T08:05:00.000Z', 1000, 1001), timestamp: '2026-07-10T09:30:00.000Z' },
      { ...tokenCount('2026-07-10T08:20:00.000Z', 2000, 3002), timestamp: '2026-07-10T09:30:00.000Z' },
      tokenCount('2026-07-10T09:31:00.000Z', 7, 3010),
    ]);
    const fork2File = 'rollout-2026-07-10T09-30-00-fork-2.jsonl';
    writeFileSync(file('codex', parentFile), parent);
    writeFileSync(file('codex', forkFile), fork);
    await run(single);
    const dir = codexCacheDir(homes.codex);
    // This version's entry for the parent: what a collector still running
    // 0.15.x (also algorithm 7) writes back when its audit rebuilds it.
    const own = entries(homes).find(({ entry }) => entry.filePath === file('codex', parentFile));
    assert.ok(own?.entry.index, 'the parent has a replay index');
    const rebuilt = readFileSync(join(dir, own.name), 'utf8');
    // The parent as an algorithm-5 collector left it (index fingerprinted
    // differently, see above), with no entry of this version and no manifest.
    const older = { ...own.entry, algorithmVersion: 5, header: { ...own.entry.header }, result: { ...own.entry.result },
      index: { ...own.entry.index, tokenFingerprints: own.entry.index.tokenFingerprints.map(fingerprint => `v5-${fingerprint}`) } };
    delete older.header.modelProvider;
    delete older.result.magpieEntries;
    delete older.result.ultrafastBuckets;
    writeFileSync(join(olderCodexCacheDir(homes.codex), own.name), JSON.stringify(older));
    unlinkSync(join(dir, own.name));
    rmSync(join(dir, 'manifest.v1'), { force: true });
    await run(single);
    await run(single);
    const path = join(dir, 'manifest.v1');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    // Nothing of the algorithm-5 entry is taken: the parent is read again by
    // this version and recorded as its own.
    assert.equal(manifest.records[file('codex', parentFile)]?.src, CODEX_PARSER_ALGORITHM_VERSION,
      'an algorithm-5 entry is not recorded');
    // A manifest written before this rule would hold it anyway.
    const { tokenTimes, tokenFingerprints, taskBoundaries, ...slim } = older.index;
    manifest.records[file('codex', parentFile)] = { signature: older.signature, src: 5, header: older.header,
      index: slim, result: older.result, lastAuditedAt: older.lastAuditedAt ?? null };
    writeFileSync(path, JSON.stringify(manifest));
    // The older collector's audit rebuilds the parent's entry, same file state;
    // then a second fork of it appears.
    writeFileSync(join(dir, own.name), rebuilt);
    writeFileSync(file('codex', fork2File), fork2);
    const result = await run(single);
    assert.deepEqual(view(result), view(await uncached(single)));
    assert.equal(totalInput(result), 3012, 'parent 3000 + the forks\' own 5 and 7');
    assert.equal(totalInput(await run(single)), 3012);
  });
});

test('a new fork\'s boundary comes from this version\'s own entry, never from an older one', async () => {
  await withHomes(async ({ homes, file, run, uncached }) => {
    const single = { extraRoots: [] };
    // A second fork of the parent, which appears only at the end.
    const fork2 = jsonl([
      sessionMeta('2026-07-10T09:30:00.000Z', 'fork-2', { forked_from_id: 'parent-1' }),
      { ...tokenCount('2026-07-10T08:05:00.000Z', 1000, 1001), timestamp: '2026-07-10T09:30:00.000Z' },
      { ...tokenCount('2026-07-10T08:20:00.000Z', 2000, 3002), timestamp: '2026-07-10T09:30:00.000Z' },
      tokenCount('2026-07-10T09:31:00.000Z', 7, 3010),
    ]);
    const fork2File = 'rollout-2026-07-10T09-30-00-fork-2.jsonl';
    // A first fork gives the parent a replay index, then goes away.
    writeFileSync(file('codex', parentFile), parent);
    writeFileSync(file('codex', forkFile), fork);
    await run(single);
    unlinkSync(file('codex', forkFile));
    const dir = codexCacheDir(homes.codex);
    // This version's entry for the parent: what a collector still running
    // 0.15.x writes back when its rolling audit rebuilds it.
    const own = entries(homes).find(({ entry }) => entry.filePath === file('codex', parentFile));
    assert.ok(own?.entry.index && own.entry.result, 'the parent has an index and a summary');
    const rebuilt = readFileSync(join(dir, own.name), 'utf8');
    // The parent as an algorithm-6 collector left it, carrying an index an
    // earlier algorithm computed (an incremental rewrite keeps the index it
    // had; here its fingerprints are simply made different), and nothing of
    // this version.
    const older = { ...own.entry, algorithmVersion: 6, result: { ...own.entry.result },
      index: { ...own.entry.index, tokenFingerprints: own.entry.index.tokenFingerprints.map(fingerprint => `v5-${fingerprint}`) } };
    delete older.result.ultrafastBuckets;
    writeFileSync(join(olderCodexCacheDir(homes.codex), own.name), JSON.stringify(older));
    unlinkSync(join(dir, own.name));
    rmSync(join(dir, 'manifest.v1'), { force: true });
    await run(single);
    await run(single);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.v1'), 'utf8'));
    const record = manifest.records[file('codex', parentFile)];
    // Since algorithm 9 nothing of the older entry is taken, and at this point
    // no fork or sub-agent names the parent (the first fork is gone), so no
    // replay index is needed: the record is this version's own entry, for the
    // header and the usage.
    assert.equal(record?.src, CODEX_PARSER_ALGORITHM_VERSION, 'the parent is recorded as this version\'s entry');
    assert.equal(record.index, null, 'no replay index is needed yet');
    // The entry is rebuilt with its full index for the same file state (two
    // processes of this version run side by side); then a new fork of it
    // appears, and its boundary has to come from that entry.
    writeFileSync(join(dir, own.name), rebuilt);
    writeFileSync(file('codex', fork2File), fork2);
    const result = await run(single);
    assert.deepEqual(view(result), view(await uncached(single)));
    assert.equal(totalInput(result), 3007, 'parent 3000 + the new fork\'s own 7');
    assert.equal(totalInput(await run(single)), 3007);
  });
});
