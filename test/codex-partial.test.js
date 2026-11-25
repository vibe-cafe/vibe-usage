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
  // The fork is history too, a month old (one in use is read first, with its
  // parent: the cold-start tests below).
  writeFileSync(m.file('codex', 'rollout-b-fork.jsonl'), fork);
  const monthAgo = (clock.now - 30 * 24 * 3600e3) / 1000;
  fs.utimesSync(m.file('codex', 'rollout-b-fork.jsonl'), monthAgo, monthAgo);
  writeFileSync(m.file('codex', 'rollout-c-parent.jsonl.zst'), zlib.zstdCompressSync(Buffer.from(parent)));

  // Three headers (30 ms), the conversation in use (40 ms), the fork's index
  // (50 ms). The compressed parent's index would start after the backlog's
  // 40 ms (of a 60 ms budget): left for the next run, and without its parent
  // the fork's copied history cannot be told apart: it waits.
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
  // The active conversation's appended records (10 ms), the parent's index
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
  // Codex compresses only what was not touched for a week: both are history.
  const monthAgo = (clock.now - 30 * 24 * 3600e3) / 1000;
  for (const name of ['rollout-shared.jsonl', 'rollout-other.jsonl']) fs.utimesSync(m.file('orca1', name), monthAgo, monthAgo);
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

test('a cold start reads the conversations in use first; history follows, and the end equals one uninterrupted read', async () => {
  const m = machine();
  // A month of history, every conversation in two homes (Orca hard-links each
  // rollout into every account's home), named so that a directory-order read
  // reaches it first; an old conversation and a fork of it made today; and a
  // conversation in use.
  const monthAgo = (clock.now - 30 * 24 * 3600e3) / 1000;
  for (let i = 1; i <= 6; i++) {
    const name = `rollout-2026-07-0${i}T08-00-00-h${i}.jsonl`;
    writeFileSync(m.file('codex', name), jsonl([
      sessionMeta(`2026-07-0${i}T08:00:00.000Z`, `history-${i}`),
      tokenCount(`2026-07-0${i}T08:05:00.000Z`, 100 * i, 100 * i + 1),
    ]));
    linkSync(m.file('codex', name), m.file('orca1', name));
    fs.utimesSync(m.file('codex', name), monthAgo, monthAgo);
  }
  writeFileSync(m.file('codex', 'rollout-2026-07-10T08-00-00-parent.jsonl'), parent);
  fs.utimesSync(m.file('codex', 'rollout-2026-07-10T08-00-00-parent.jsonl'), monthAgo, monthAgo);
  writeFileSync(m.file('orca1', 'rollout-2026-07-17T09-00-00-fork.jsonl'), fork);
  writeFileSync(m.file('orca1', 'rollout-2026-07-18T10-00-00-active.jsonl'), active([tokenCount('2026-07-18T10:05:00.000Z', 40, 41)]));

  // 15 headers (150 ms). Pass 1, the conversations in use: the fork's index,
  // the active conversation (170 ms). Pass 2, what they lack: the parent's
  // index, its usage, the fork's usage (200 ms). Pass 3, history, newest
  // first: one index read, then the budget is gone.
  const runs = [await m.run(205, { extraRoots: true })];
  const first = runs[0].result;
  assert.equal(first.skipped, undefined, JSON.stringify(first));
  assert.ok(first.indexing, 'history is left for the next runs');
  assert.equal(input(first), 40 + 3000 + 5, 'the conversations in use, the fork with its parent');
  assert.equal(input(first, FORK_WINDOW), 40 + 5, 'never the parent\'s history copied into the fork');

  while (runs.at(-1).result.indexing && runs.length < 6) runs.push(await m.run(205, { extraRoots: true }));
  const last = runs.at(-1).result;
  assert.equal(last.indexing, undefined, `complete after ${runs.length} runs`);
  const expected = await m.uncached({ extraRoots: true });
  // Byte for byte, in the order one uninterrupted read emits them.
  assert.equal(JSON.stringify({ buckets: last.buckets, sessions: last.sessions }),
    JSON.stringify({ buckets: expected.buckets, sessions: expected.sessions }));
  assert.equal(input(expected), 40 + 3000 + 5 + 2100);
  // No run ever sent more for a window than the complete read has there.
  const final = new Map(last.buckets.map(bucket => [`${bucket.bucketStart}|${bucket.model}|${bucket.project}`, bucket.totalTokens]));
  for (const { result } of runs) {
    for (const bucket of result.buckets) {
      assert.ok(bucket.totalTokens <= final.get(`${bucket.bucketStart}|${bucket.model}|${bucket.project}`), JSON.stringify(bucket));
    }
  }
});

test('what a conversation in use needs from compressed history is read with the whole budget', needsZstd, async () => {
  const m = machine();
  for (const n of [1, 2, 3]) {
    writeFileSync(m.file('codex', `rollout-a-active-${n}.jsonl`),
      active([tokenCount('2026-07-18T10:05:00.000Z', 10 * n, 10 * n + 1)]).replace('active-1', `active-${n}`));
  }
  writeFileSync(m.file('codex', 'rollout-b-fork.jsonl'), fork); // made today
  writeFileSync(m.file('codex', 'rollout-c-parent.jsonl.zst'), zlib.zstdCompressSync(Buffer.from(parent)));

  // Five headers (50 ms); the fork's index and the three conversations in use
  // (90 ms) already pass the backlog's 80 ms (of 120 ms). The fork's
  // compressed parent is still read -- it is what a conversation in use
  // needs -- and so are the fork and the parent's usage: everything in one run.
  const first = await m.run(120);
  assert.equal(first.result.indexing, undefined, JSON.stringify(first.result.indexing));
  assert.deepEqual(view(first.result), view(await m.uncached()));
  assert.equal(input(first.result, FORK_WINDOW), 10 + 20 + 30 + 5);
});
