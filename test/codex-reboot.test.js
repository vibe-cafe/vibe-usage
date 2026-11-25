import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  appendFileSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from '../src/parsers/codex.js';
import { codexCacheDir, fileSignature } from '../src/parsers/codex-cache.js';
import { codexSegmentSignature, legacyCodexSegmentSignature } from '../src/parsers/codex-segments.js';

// A reboot gives a Mac's data volume a new device number (st_dev). On
// 2026-11-25 that alone made the maintainer's whole Codex cache -- 24,000
// entries whose size, mtime and inode had not changed -- a miss, and Codex
// stopped uploading for about twelve syncs while it was rebuilt. Here the
// device number is shifted the way a reboot shifts it, and nothing may be read
// again. All fixtures are synthetic.

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

function tokenCount(timestamp, input, cumulativeTotal) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model: 'gpt-5.2',
        total_token_usage: { total_tokens: cumulativeTotal },
        last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: input + 1 },
      },
    },
  };
}

const jsonl = records => `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
const turn = { type: 'turn_context', timestamp: '2026-07-10T08:00:00.000Z', payload: { model: 'gpt-5.2' } };

// A session kept in both homes (Orca hard-links every rollout into each
// account's home): one duplicate-session group. It is also the parent of a
// fork that exists in one home only.
const parentFile = 'rollout-2026-07-10T08-00-00-parent-1.jsonl';
const parent = jsonl([
  sessionMeta('2026-07-10T08:00:00.000Z', 'parent-1'), turn,
  tokenCount('2026-07-10T08:05:00.000Z', 1000, 1001),
  tokenCount('2026-07-10T08:20:00.000Z', 2000, 3002),
]);
const forkFile = 'rollout-2026-07-10T09-00-00-fork-1.jsonl';
const forkRecords = [
  sessionMeta('2026-07-10T09:00:00.000Z', 'fork-1', { forked_from_id: 'parent-1' }),
  { ...tokenCount('2026-07-10T08:05:00.000Z', 1000, 1001), timestamp: '2026-07-10T09:00:00.000Z' },
  { ...tokenCount('2026-07-10T08:20:00.000Z', 2000, 3002), timestamp: '2026-07-10T09:00:00.000Z' },
  tokenCount('2026-07-10T09:01:00.000Z', 5, 3008),
];
// A session in one home only, and its fork: a parent that is a single file.
const soloFile = 'rollout-2026-07-10T10-00-00-solo-1.jsonl';
const solo = jsonl([
  sessionMeta('2026-07-10T10:00:00.000Z', 'solo-1'), turn,
  tokenCount('2026-07-10T10:05:00.000Z', 700, 701),
]);
const soloForkFile = 'rollout-2026-07-10T11-00-00-fork-2.jsonl';
const soloFork = jsonl([
  sessionMeta('2026-07-10T11:00:00.000Z', 'fork-2', { forked_from_id: 'solo-1' }),
  { ...tokenCount('2026-07-10T10:05:00.000Z', 700, 701), timestamp: '2026-07-10T11:00:00.000Z' },
  tokenCount('2026-07-10T11:01:00.000Z', 9, 711),
]);
// A conversation that goes on: read from its append tail.
const growFile = 'rollout-2026-07-10T12-00-00-grow-1.jsonl';
const grow = jsonl([
  sessionMeta('2026-07-10T12:00:00.000Z', 'grow-1'), turn,
  tokenCount('2026-07-10T12:05:00.000Z', 300, 301),
]);
const growMore = jsonl([tokenCount('2026-07-10T12:40:00.000Z', 40, 342)]);

async function withHomes(fn) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codex-reboot-'));
  const homes = { codex: join(root, 'a-codex'), orca: join(root, 'b-orca') };
  for (const home of Object.values(homes)) mkdirSync(join(home, DAY_DIR), { recursive: true });
  const keys = ['CODEX_HOME', 'VIBE_USAGE_CACHE_DIR', 'VIBE_USAGE_CODEX_WORK_BUDGET_MS', 'VIBE_USAGE_CODEX_CACHE',
    'VIBE_USAGE_CODEX_AUDIT_INTERVAL_MS'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.CODEX_HOME = homes.codex;
  process.env.VIBE_USAGE_CACHE_DIR = join(root, 'cache');
  process.env.VIBE_USAGE_CODEX_WORK_BUDGET_MS = '600000';
  delete process.env.VIBE_USAGE_CODEX_CACHE;
  delete process.env.VIBE_USAGE_CODEX_AUDIT_INTERVAL_MS;
  const file = (home, name) => join(homes[home], DAY_DIR, name);
  const run = () => parse({ extraRoots: [homes.orca] });
  const uncached = async () => {
    process.env.VIBE_USAGE_CODEX_CACHE = '0';
    try { return await run(); } finally { delete process.env.VIBE_USAGE_CODEX_CACHE; }
  };
  writeFileSync(file('orca', parentFile), parent);
  linkSync(file('orca', parentFile), file('codex', parentFile));
  writeFileSync(file('orca', forkFile), jsonl(forkRecords));
  writeFileSync(file('codex', soloFile), solo);
  writeFileSync(file('codex', soloForkFile), soloFork);
  writeFileSync(file('codex', growFile), grow);
  try {
    return await fn({ homes, file, run, uncached });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Every stat from here on reports its device number plus `offset`, the way a
 * reboot changes it (the same shim the first-sync check preloads with
 * `--import`). Returns the function that undoes it.
 */
function shiftDeviceNumbers(offset) {
  const real = { statSync: fs.statSync, lstatSync: fs.lstatSync, fstatSync: fs.fstatSync };
  const shift = stat => {
    if (stat && typeof stat.dev === 'number') stat.dev += offset;
    return stat;
  };
  for (const [name, fn] of Object.entries(real)) fs[name] = (...args) => shift(fn(...args));
  syncBuiltinESMExports();
  return () => {
    Object.assign(fs, real);
    syncBuiltinESMExports();
  };
}

/** The rollouts a call opens for reading. */
async function opened(fn) {
  const real = fs.createReadStream;
  const paths = [];
  fs.createReadStream = (path, ...rest) => {
    paths.push(String(path));
    return real(path, ...rest);
  };
  syncBuiltinESMExports();
  try {
    return { result: await fn(), paths };
  } finally {
    fs.createReadStream = real;
    syncBuiltinESMExports();
  }
}

const manifestPath = home => join(codexCacheDir(home), 'manifest.v1');
const manifestTexts = homes => Object.values(homes).map(home => readFileSync(manifestPath(home), 'utf8'));

function view(result) {
  return {
    buckets: [...result.buckets].sort((a, b) => `${a.bucketStart}${a.model}${a.project}`.localeCompare(`${b.bucketStart}${b.model}${b.project}`)),
    sessions: [...result.sessions].sort((a, b) => a.sessionHash.localeCompare(b.sessionHash)),
  };
}

const groupMembers = file => [file('codex', parentFile), file('orca', parentFile)]
  .map(filePath => ({ filePath, signature: fileSignature(statSync(filePath)), snapshotSize: statSync(filePath).size }));

/**
 * Turns the cache into what a release before 2026-11-25 left: the group's key
 * hashed with the members' device numbers, and parent states that carry the
 * device number (a group parent's: its key of that format).
 */
function toEarlierFormat(homes, file) {
  const members = groupMembers(file);
  const current = codexSegmentSignature(members);
  const legacy = legacyCodexSegmentSignature(members);
  let groupEntries = 0;
  let parentStates = 0;
  for (const home of Object.values(homes)) {
    const dir = codexCacheDir(home);
    for (const name of readdirSync(dir).filter(name => name.endsWith('.json'))) {
      const entry = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (entry.signature?.ino !== current.ino) continue;
      entry.signature = legacy;
      writeFileSync(join(dir, name), `${JSON.stringify(entry)}\n`);
      groupEntries++;
    }
    const manifest = JSON.parse(readFileSync(manifestPath(home), 'utf8'));
    for (const record of Object.values(manifest.records)) {
      if (record.signature?.ino === current.ino) record.signature = legacy;
      if (!record.boundaryParent) continue;
      const [path, state, digest] = record.boundaryParent.split('\u0000');
      const [size, mtimeMs, ino] = state.split(':');
      const group = ino === current.ino;
      const dev = group ? 'codex-segments' : String(statSync(path).dev);
      record.boundaryParent = `${path}\u0000${size}:${mtimeMs}:${dev}:${group ? legacy.ino : ino}\u0000${digest}`;
      parentStates++;
    }
    writeFileSync(manifestPath(home), `${JSON.stringify(manifest)}\n`);
  }
  assert.equal(groupEntries, 1, 'the group entry');
  assert.equal(parentStates, 2, 'both forks recorded their parent state');
  return { current, legacy };
}

test('after a reboot every entry, the group, the manifests and the append tail are used as they are', async () => {
  await withHomes(async ({ homes, file, run, uncached }) => {
    await run(); // the entries
    await run(); // the manifests
    const expected = view(await uncached());
    const before = manifestTexts(homes);

    let restore = shiftDeviceNumbers(1000);
    try {
      const { result, paths } = await opened(run);
      assert.deepEqual(paths, [], 'no rollout read');
      assert.equal(result.indexing, undefined);
      assert.equal(result.skipped, undefined);
      assert.deepEqual(view(result), expected);
      assert.deepEqual(manifestTexts(homes), before, 'nothing to record again');

      // Without the manifests: the entries themselves, the group's included.
      for (const home of Object.values(homes)) rmSync(manifestPath(home));
      const fromEntries = await opened(run);
      assert.deepEqual(fromEntries.paths, []);
      assert.deepEqual(view(fromEntries.result), expected);
    } finally {
      restore();
    }

    // Another reboot, and the conversation goes on: only what was appended
    // is read, from the tail saved before the reboot.
    appendFileSync(file('codex', growFile), growMore);
    restore = shiftDeviceNumbers(2000);
    try {
      const { result, paths } = await opened(run);
      assert.deepEqual(paths, [file('codex', growFile)]);
      assert.equal(result.cache.tailHits, 1);
      assert.deepEqual(view(result), view(await uncached()));
    } finally {
      restore();
    }
  });
});

test('a fork that goes on after a reboot is checked against its parent group\'s index from the entry', async () => {
  await withHomes(async ({ file, run, uncached }) => {
    await run();
    await run();
    const restore = shiftDeviceNumbers(1000);
    try {
      appendFileSync(file('orca', forkFile), jsonl([tokenCount('2026-07-10T09:30:00.000Z', 6, 3015)]));
      const { result, paths } = await opened(run);
      // The fork's index and its usage; the parent group is not merged again.
      assert.deepEqual([...new Set(paths)], [file('orca', forkFile)]);
      assert.deepEqual(view(result), view(await uncached()));
    } finally {
      restore();
    }
  });
});

test('a cache an earlier release wrote is used after the upgrade, and after a reboot', async () => {
  await withHomes(async ({ homes, file, run, uncached }) => {
    await run();
    await run();
    const expected = view(await uncached());
    const { current, legacy } = toEarlierFormat(homes, file);
    const earlier = manifestTexts(homes);

    // The upgrade, before any reboot: nothing read, and nothing recorded again
    // -- a 0.15.x collector still running reads the same manifests, and keys
    // changed back and forth would make both rewrite them on every run.
    const upgraded = await opened(run);
    assert.deepEqual(upgraded.paths, []);
    assert.deepEqual(view(upgraded.result), expected);
    assert.deepEqual(manifestTexts(homes), earlier);

    // A reboot. The earlier keys still name the same states, under the device
    // number they were written with: nothing read. They can only be found
    // through that number, so they are recorded the current way now -- the
    // group under its current key, with the key its entry still has.
    let restore = shiftDeviceNumbers(1000);
    try {
      const rebooted = await opened(run);
      assert.deepEqual(rebooted.paths, []);
      assert.deepEqual(view(rebooted.result), expected);
    } finally {
      restore();
    }
    const records = Object.values(homes).flatMap(home => Object.values(JSON.parse(readFileSync(manifestPath(home), 'utf8')).records));
    const group = records.find(record => record.signature.dev === 'codex-segments');
    assert.equal(group.signature.ino, current.ino);
    assert.equal(group.entrySignature.ino, legacy.ino);
    const states = records.filter(record => record.boundaryParent).map(record => record.boundaryParent.split('\u0000')[1]);
    assert.equal(states.length, 2);
    for (const state of states) assert.equal(state.split(':').length, 3, `no device number in ${state}`);

    // Another reboot, and the fork goes on: the parent group's full index
    // comes from its entry, still under the earlier key. Only the fork is read.
    restore = shiftDeviceNumbers(2000);
    try {
      appendFileSync(file('orca', forkFile), jsonl([tokenCount('2026-07-10T09:30:00.000Z', 6, 3015)]));
      const { result, paths } = await opened(run);
      assert.deepEqual([...new Set(paths)], [file('orca', forkFile)]);
      assert.deepEqual(view(result), view(await uncached()));
    } finally {
      restore();
    }
  });
});

test('a hard link is still told apart from a copy on another device', async () => {
  // Same size, mtime and inode number, different device: two files, not one.
  // planCodexSegments() must not take the second for a link of the first.
  const { planCodexSegments } = await import('../src/parsers/codex-segments.js');
  const signature = { size: 10, mtimeMs: 1, dev: '1', ino: '7' };
  const a = { filePath: '/a/x.jsonl', signature, compressed: false };
  const b = { filePath: '/b/x.jsonl', signature: { ...signature, dev: '2' }, compressed: false };
  assert.equal(planCodexSegments([a, b]).read.length, 2);
  const link = { filePath: '/c/x.jsonl', signature: { ...signature }, compressed: false };
  assert.equal(planCodexSegments([a, link]).read.length, 1);
});
