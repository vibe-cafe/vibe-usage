import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import zlib from 'node:zlib';
import { parse } from '../src/parsers/codex.js';

// The first sync after an upgrade that finds a long compressed history must
// still upload Codex: what is exact goes up, what depends on history not read
// yet waits for a later run, and nothing is ever counted that a complete read
// would not count (the server keeps the larger of two values, so an excess is
// permanent while a shortfall is filled in later).
//
// Time is simulated: opening a rollout for reading costs COST_MS on a fake
// clock, and the budget is BUDGET_MS, of which the compressed backlog gets two
// thirds (BACKLOG_SHARE in codex.js).

const COST_MS = 10;
const realNow = Date.now;
const realCreateReadStream = fs.createReadStream;
const clock = { now: realNow(), charging: false };
fs.createReadStream = (...args) => {
  if (clock.charging) clock.now += COST_MS;
  return realCreateReadStream(...args);
};
syncBuiltinESMExports();
Date.now = () => clock.now;

const ENV_KEYS = ['CODEX_HOME', 'VIBE_USAGE_CACHE_DIR', 'VIBE_USAGE_CODEX_CACHE', 'VIBE_USAGE_CODEX_WORK_BUDGET_MS', 'VIBE_USAGE_CINDY_DIRS'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const roots = [];
test.after(() => {
  fs.createReadStream = realCreateReadStream;
  syncBuiltinESMExports();
  Date.now = realNow;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function';
const needsZstd = HAS_ZSTD ? {} : { skip: 'node:zlib has no zstd before Node 22.15' };
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

const parent = jsonl([
  sessionMeta('2026-07-10T08:00:00.000Z', 'parent-1'),
  tokenCount('2026-07-10T08:05:00.000Z', 1000, 1001),
  tokenCount('2026-07-10T08:20:00.000Z', 2000, 3002),
]);
const FORK_WINDOW = '2026-07-17T09:00:00.000Z';
const fork = jsonl([
  sessionMeta(FORK_WINDOW, 'fork-1', { forked_from_id: 'parent-1' }),
  { ...tokenCount('2026-07-10T08:05:00.000Z', 1000, 1001), timestamp: FORK_WINDOW },
  { ...tokenCount('2026-07-10T08:20:00.000Z', 2000, 3002), timestamp: FORK_WINDOW },
  tokenCount('2026-07-17T09:01:00.000Z', 5, 3008),
]);
const active = records => jsonl([
  sessionMeta('2026-07-18T10:00:00.000Z', 'active-1'),
  ...records,
]);

function machine() {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codex-partial-'));
  roots.push(root);
  const homes = { codex: join(root, 'a-codex'), orca1: join(root, 'b-orca1'), orca2: join(root, 'c-orca2') };
  for (const home of Object.values(homes)) mkdirSync(join(home, DAY_DIR), { recursive: true });
  const file = (home, name) => join(homes[home], DAY_DIR, name);
  const env = budget => {
    process.env.CODEX_HOME = homes.codex;
    process.env.VIBE_USAGE_CACHE_DIR = join(root, 'cache');
    process.env.VIBE_USAGE_CINDY_DIRS = join(root, 'no-cindy');
    process.env.VIBE_USAGE_CODEX_WORK_BUDGET_MS = String(budget);
    delete process.env.VIBE_USAGE_CODEX_CACHE;
  };
  const options = extraRoots => (extraRoots ? { extraRoots: [homes.orca1, homes.orca2] } : {});
  return {
    homes,
    file,
    async run(budget, { extraRoots = false } = {}) {
      env(budget);
      const startedAt = clock.now;
      clock.charging = true;
      try {
        const result = await parse(options(extraRoots));
        return { result, elapsedMs: clock.now - startedAt };
      } finally {
        clock.charging = false;
      }
    },
    async uncached({ extraRoots = false } = {}) {
      env(600000);
      process.env.VIBE_USAGE_CODEX_CACHE = '0';
      return parse(options(extraRoots));
    },
  };
}

function view(result) {
  return {
    buckets: [...result.buckets].sort((a, b) => `${a.bucketStart}${a.model}`.localeCompare(`${b.bucketStart}${b.model}`)),
    sessions: [...result.sessions].sort((a, b) => a.sessionHash.localeCompare(b.sessionHash)),
  };
}

const input = (result, from = null) => result.buckets
  .filter(bucket => from === null || Date.parse(bucket.bucketStart) >= Date.parse(from))
  .reduce((sum, bucket) => sum + bucket.inputTokens, 0);

test('the first run uploads the conversations in use and leaves a fork of an unread compressed parent for later', needsZstd, async () => {
  const m = machine();
  writeFileSync(m.file('codex', 'rollout-a-active.jsonl'), active([tokenCount('2026-07-18T10:05:00.000Z', 40, 41)]));
  writeFileSync(m.file('codex', 'rollout-b-fork.jsonl'), fork);
  writeFileSync(m.file('codex', 'rollout-c-parent.jsonl.zst'), zlib.zstdCompressSync(Buffer.from(parent)));

  // Three headers (30 ms), the fork's index (40 ms). The compressed parent's
  // index would start at the end of the backlog's 40 ms (of a 60 ms budget):
  // left for the next run. The active conversation is still read (50 ms), and
  // there would be time for the fork too, but without its parent the copied
  // history cannot be told apart: it waits.
  const first = await m.run(60);
  assert.equal(first.result.skipped, undefined, JSON.stringify(first.result));
  assert.equal(first.result.indexing.phase, 'replay-index');
  assert.deepEqual([first.result.indexing.completed, first.result.indexing.total], [1, 3]);
  assert.equal(input(first.result), 40, 'only the active conversation');
  assert.equal(input(first.result, FORK_WINDOW), 40, 'never the fork with its parent\'s copied history');
  assert.deepEqual(first.result.sessions.map(session => session.inputTokens ?? null).length, 1);

  // The conversation goes on; the next run reads the parent and the fork.
  writeFileSync(m.file('codex', 'rollout-a-active.jsonl'), active([
    tokenCount('2026-07-18T10:05:00.000Z', 40, 41),
    tokenCount('2026-07-18T10:06:00.000Z', 60, 102),
  ]));
  // The parent's index (10 ms), the active conversation's appended records
  // (20 ms), the fork (30 ms) and the parent's usage, started inside the
  // backlog's 40 ms of a 60 ms budget.
  const second = await m.run(60);
  assert.equal(second.result.skipped, undefined);
  assert.equal(second.result.indexing, undefined, JSON.stringify(second.result.indexing));
  const expected = await m.uncached();
  assert.deepEqual(view(second.result), view(expected));
  assert.equal(input(expected), 3000 + 5 + 100);
  assert.equal(input(expected, FORK_WINDOW), 5 + 100);
});

test('a group with a compressed copy not compared yet waits; the other sessions are uploaded', needsZstd, async () => {
  const m = machine();
  const shared = jsonl([
    sessionMeta('2026-07-10T08:00:00.000Z', 'shared-1'),
    tokenCount('2026-07-10T08:05:00.000Z', 1000, 1001),
    tokenCount('2026-07-10T08:20:00.000Z', 2000, 3002),
  ]);
  const other = jsonl([sessionMeta('2026-07-11T08:00:00.000Z', 'other-1'), tokenCount('2026-07-11T08:05:00.000Z', 300, 301)]);
  writeFileSync(m.file('orca1', 'rollout-shared.jsonl'), shared);
  linkSync(m.file('orca1', 'rollout-shared.jsonl'), m.file('orca2', 'rollout-shared.jsonl'));
  writeFileSync(m.file('orca1', 'rollout-other.jsonl'), other);
  linkSync(m.file('orca1', 'rollout-other.jsonl'), m.file('orca2', 'rollout-other.jsonl'));
  const before = await m.run(600000, { extraRoots: true });
  assert.equal(input(before.result), 3300);

  // Codex compressed its own copy. Its header costs 10 ms, which is the whole
  // backlog share of a 15 ms budget: the comparison waits, and so does the
  // session; the unchanged one is uploaded as before.
  writeFileSync(m.file('codex', 'rollout-shared.jsonl.zst'), zlib.zstdCompressSync(Buffer.from(shared)));
  const first = await m.run(15, { extraRoots: true });
  assert.equal(first.result.skipped, undefined, JSON.stringify(first.result));
  assert.equal(first.result.indexing.phase, 'replay-index');
  assert.equal(input(first.result), 300);

  const second = await m.run(15, { extraRoots: true });
  assert.equal(second.result.indexing, undefined, JSON.stringify(second.result));
  // One comparison; the group's summary is the one the plain links made.
  assert.equal(second.result.cache.filesRead, 1);
  assert.deepEqual(view(second.result), view(await m.uncached({ extraRoots: true })));
  assert.deepEqual(view(second.result), view(before.result));
});

test('a run that cannot read every header is still skipped', async () => {
  const m = machine();
  for (const name of ['rollout-a.jsonl', 'rollout-b.jsonl', 'rollout-c.jsonl']) {
    writeFileSync(m.file('codex', name), active([tokenCount('2026-07-18T10:05:00.000Z', 1, 2)]).replace('active-1', name));
  }
  // An unknown header could be a copy or the parent of any session.
  const first = await m.run(15);
  assert.equal(first.result.skipped, true);
  assert.equal(first.result.indexing.phase, 'discovery');
});
