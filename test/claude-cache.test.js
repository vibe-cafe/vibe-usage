import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from '../src/parsers/claude-code.js';
import { createMagpieContext } from '../src/parsers/magpie.js';

// All synthetic. Each test gets its own Claude root and cache directory; no
// test reads the developer's ~/.claude or writes the real ~/.vibe-usage.
const ENV_KEYS = [
  'VIBE_USAGE_CLAUDE_DIRS', 'VIBE_USAGE_CLAUDE_DESKTOP_DIRS', 'VIBE_USAGE_CACHE_DIR',
  'VIBE_USAGE_CLAUDE_CACHE', 'VIBE_USAGE_CLAUDE_WORK_BUDGET_MS',
  'VIBE_USAGE_CLAUDE_AUDIT_INTERVAL_MS', 'VIBE_USAGE_MAGPIE_TEST_FILE',
];

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'vibe-usage-claude-cache-test-'));
  const root = join(base, 'claude');
  const cacheDir = join(base, 'cache');
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(base, { recursive: true, force: true });
  });
  const isolated = {
    VIBE_USAGE_CLAUDE_DIRS: root,
    VIBE_USAGE_CLAUDE_DESKTOP_DIRS: join(base, 'no-desktop'),
    VIBE_USAGE_CACHE_DIR: cacheDir,
    VIBE_USAGE_MAGPIE_TEST_FILE: join(base, 'magpie', 'usage.jsonl'),
  };
  const applyEnv = (env = {}) => {
    const settings = { ...isolated, ...env };
    for (const key of ENV_KEYS) {
      if (settings[key] === undefined) delete process.env[key];
      else process.env[key] = settings[key];
    }
  };
  // Isolate right away: a Magpie context captures its ledger path when it is
  // created, which can be before the first run() call.
  applyEnv();
  const run = async (env = {}, options = {}) => {
    applyEnv(env);
    return parse(options);
  };
  return {
    base,
    root,
    cacheDir,
    path: (sessionId, project = '-Users-dev-app') => join(root, 'projects', project, `${sessionId}.jsonl`),
    run,
    // Ground truth: the same parser with the cache switched off.
    uncached: (options) => run({ VIBE_USAGE_CLAUDE_CACHE: '0' }, options),
    cacheEntries: () => {
      try {
        return readdirSync(join(cacheDir, 'claude-code')).filter((name) => name.endsWith('.json'));
      } catch {
        return [];
      }
    },
  };
}

const ts = (minute) => new Date(Date.UTC(2026, 10, 2, 10, minute)).toISOString();

function user(minute, extra = {}) {
  return { type: 'user', timestamp: ts(minute), cwd: '/Users/dev/app', ...extra };
}

function assistant(minute, { id, requestId = id && `req-${id}`, model = 'claude-opus-4-8',
  input = 10, output = 5, cacheRead = 0, cacheWrite = 0, speed, uuid, cwd } = {}) {
  const usage = { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite, ...(speed ? { speed } : {}) };
  return { type: 'assistant', timestamp: ts(minute), ...(cwd ? { cwd } : {}),
    ...(uuid ? { uuid } : {}), ...(requestId ? { requestId } : {}),
    message: { ...(id ? { id } : {}), model, usage } };
}

const lines = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

function writeTranscript(path, records, { mtimeSeconds } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines(records));
  if (mtimeSeconds) utimesSync(path, mtimeSeconds, mtimeSeconds);
}

/** Overwrite bytes [start, end) in place (same inode, same size), keeping newlines. */
function blankRange(path, start, end) {
  const bytes = readFileSync(path).subarray(start, end);
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 0x0a) bytes[i] = 0x20;
  const fd = openSync(path, 'r+');
  try {
    writeSync(fd, bytes, 0, bytes.length, start);
  } finally {
    closeSync(fd);
  }
}

// Code-point order, so the pinned lists below do not depend on ICU collation.
const byKey = (key) => (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
const normalize = (result) => ({
  skipped: !!result.skipped,
  buckets: [...result.buckets].sort(byKey((b) => `${b.model}|${b.project}|${b.bucketStart}`)),
  sessions: [...result.sessions].sort(byKey((s) => s.sessionHash)),
});

// A session that exercises every field the cache has to carry: a cwd that
// appears late, a <synthetic> line inheriting the last model, fast mode,
// content-block duplicates of one call (partial then final), an anonymous uuid
// record, and out-of-order timestamps (sessions must then sort all events).
function richSession() {
  return [
    { type: 'summary', summary: 'no cwd yet' },
    user(0, { cwd: undefined }),
    assistant(1, { id: 'm1', input: 100, output: 1, cwd: '/Users/dev/app' }),
    assistant(1, { id: 'm1', input: 100, output: 40 }),
    assistant(2, { id: 'm1', input: 100, output: 40 }),
    assistant(3, { id: 'm2', model: '<synthetic>', input: 7, output: 2 }),
    assistant(4, { id: 'm3', speed: 'fast', input: 9, output: 3, cacheWrite: 50 }),
    assistant(35, { uuid: 'legacy-line', requestId: null, input: 4, output: 4, cacheRead: 11 }),
    user(5),
    assistant(6, { id: 'm4', model: 'claude-sonnet-5', input: 20, output: 8 }),
  ];
}

test('a warm run serves unchanged transcripts from the cache without opening them', async (t) => {
  const f = fixture(t);
  const mtimeSeconds = 1_790_000_000;
  writeTranscript(f.path('rich'), richSession(), { mtimeSeconds });
  writeTranscript(f.path('copy', '-Users-dev-other'), [
    user(10, { cwd: '/Users/dev/other' }),
    // The same call copied into another session with zeroed usage loses to
    // the complete payload, exactly as without the cache.
    assistant(11, { id: 'm4', model: 'claude-sonnet-5', input: 0, output: 0 }),
    assistant(12, { id: 'm5', input: 3, output: 1 }),
  ], { mtimeSeconds });

  const expected = normalize(await f.uncached());
  assert.equal(f.cacheEntries().length, 0, 'VIBE_USAGE_CLAUDE_CACHE=0 writes nothing');
  // Pinned numbers, so a regression shared by the cached and uncached paths
  // still fails: m1 counts once at its final payload, m2 inherits the last
  // real model, m3 carries the fast marker, the zero-usage copy of m4 loses.
  assert.deepEqual(expected.buckets.map((b) => [b.model, b.project, b.bucketStart.slice(11, 16),
    b.inputTokens, b.outputTokens, b.cachedInputTokens, b.cacheCreation5mTokens]), [
    ['claude-opus-4-8-fast', 'app', '10:00', 9, 3, 0, 50],
    ['claude-opus-4-8', 'app', '10:00', 107, 42, 0, 0],
    ['claude-opus-4-8', 'app', '10:30', 4, 4, 11, 0],
    ['claude-opus-4-8', 'other', '10:00', 3, 1, 0, 0],
    ['claude-sonnet-5', 'app', '10:00', 20, 8, 0, 0],
  ]);
  const rich = expected.sessions.find((session) => session.project === 'app');
  // Out of order (the 10:35 line precedes 10:05): sorted, 10:00 → 10:35.
  assert.deepEqual([rich.firstMessageAt, rich.lastMessageAt, rich.messageCount, rich.userMessageCount,
    rich.activeSeconds], [ts(0), ts(35), 9, 2, 180 + 1740]);

  assert.deepEqual(normalize(await f.run()), expected, 'cold run builds the cache');
  assert.equal(f.cacheEntries().length, 2);

  // Blank both transcripts in place, then put their mtime back: a warm run
  // that opened them would now find no usage at all.
  for (const path of [f.path('rich'), f.path('copy', '-Users-dev-other')]) {
    blankRange(path, 0, statSync(path).size);
    utimesSync(path, mtimeSeconds, mtimeSeconds);
  }
  assert.deepEqual(normalize(await f.run()), expected, 'warm run comes from the cache');
});

test('an appended transcript is read only from its last complete line', async (t) => {
  const f = fixture(t);
  const path = f.path('growing');
  // A long first line puts the start of the file outside the 4 KiB guard.
  const head = [user(0, { note: 'x'.repeat(10_000) }), assistant(1, { id: 'a1', input: 50, output: 5 })];
  writeTranscript(path, head);
  await f.run();
  const offset = statSync(path).size;

  const tail = [
    // A later, more complete line for an existing call replaces it.
    assistant(1, { id: 'a1', input: 50, output: 25 }),
    user(2),
    // Out of order relative to what was already parsed: the session must be
    // rebuilt from every event, sorted.
    assistant(0, { id: 'a2', input: 5, output: 5 }),
    assistant(40, { id: 'a3', model: 'claude-sonnet-5', input: 8, output: 2 }),
  ];
  appendFileSync(path, lines(tail));
  const expected = normalize(await f.uncached());

  // Blank the part of the file the cache already covers but the guard does
  // not check: only a resumed read still sees the original numbers.
  blankRange(path, 0, offset - 4096);
  assert.deepEqual(normalize(await f.run()), expected);
});

test('a transcript rewritten in place is read again from the start', async (t) => {
  const f = fixture(t);
  const path = f.path('rewritten');
  writeTranscript(path, [user(0), assistant(1, { id: 'r1', input: 10, output: 1 })]);
  await f.run();
  writeTranscript(path, [
    user(0, { cwd: '/Users/dev/renamed' }),
    assistant(1, { id: 'r1', input: 999, output: 1 }),
    assistant(2, { id: 'r2', input: 1, output: 1 }),
  ]);
  const result = normalize(await f.run());
  assert.deepEqual(result, normalize(await f.uncached()));
  assert.equal(result.buckets[0].project, 'renamed');
  assert.equal(result.buckets[0].inputTokens, 1000);
});

test('a final line without a newline counts now and is not counted twice later', async (t) => {
  const f = fixture(t);
  const path = f.path('unterminated');
  writeTranscript(path, [user(0)]);
  // A complete record that is still missing its newline...
  appendFileSync(path, JSON.stringify(assistant(1, { id: 'u1', input: 30, output: 3 })));
  assert.deepEqual(normalize(await f.run()), normalize(await f.uncached()));
  assert.equal((await f.run()).buckets[0].inputTokens, 30);

  // ...then a record Claude is still writing.
  appendFileSync(path, '\n' + JSON.stringify(assistant(2, { id: 'u2', input: 70, output: 7 })).slice(0, 40));
  assert.deepEqual(normalize(await f.run()), normalize(await f.uncached()));
  assert.equal((await f.run()).buckets[0].inputTokens, 30);

  const rest = JSON.stringify(assistant(2, { id: 'u2', input: 70, output: 7 })).slice(40);
  appendFileSync(path, `${rest}\n`);
  const done = normalize(await f.run());
  assert.deepEqual(done, normalize(await f.uncached()));
  assert.equal(done.buckets[0].inputTokens, 100);
  assert.equal(done.sessions[0].messageCount, 3);
});

test('a non-interactive cold build stops at its work budget and resumes mid-file', async (t) => {
  const f = fixture(t);
  // One transcript of several read chunks, plus a few small ones. Number
  // arrays make every 1 MiB chunk take well over the 1 ms budget to parse, so
  // a run that reaches the big file stops inside it.
  const big = [user(0)];
  for (let i = 0; i < 40; i++) {
    big.push(user(1 + (i % 50), { note: new Array(15_000).fill(123456) }));
    big.push(assistant(1 + (i % 50), { id: `b${i}`, input: i + 1, output: 1 }));
  }
  writeTranscript(f.path('big'), big);
  const bigSize = statSync(f.path('big')).size;
  for (const name of ['s1', 's2', 's3']) {
    writeTranscript(f.path(name), [user(20), assistant(21, { id: `${name}-call`, input: 2, output: 2 })]);
  }
  const expected = normalize(await f.uncached());
  const bigCheckpoint = () => f.cacheEntries()
    .map((name) => JSON.parse(readFileSync(join(f.cacheDir, 'claude-code', name), 'utf8')))
    .find((entry) => entry.filePath === f.path('big'))?.parsedBytes;

  const budget = { VIBE_USAGE_CLAUDE_WORK_BUDGET_MS: '1' };
  let skippedRuns = 0;
  let midFile = false;
  let result;
  for (let i = 0; i < 50; i++) {
    result = await f.run(budget);
    if (!result.skipped) break;
    skippedRuns++;
    assert.deepEqual(result.buckets, [], 'a partial build uploads nothing');
    assert.deepEqual(result.sessions, []);
    assert.equal(result.indexing.phase, 'transcripts');
    assert.equal(result.indexing.total, 4);
    const offset = bigCheckpoint();
    if (offset > 0 && offset < bigSize) midFile = true;
  }
  assert.ok(skippedRuns >= 2, `expected several checkpointed runs, got ${skippedRuns}`);
  assert.ok(midFile, 'the big transcript was checkpointed part-way through');
  assert.deepEqual(normalize(result), expected);
  assert.deepEqual(normalize(await f.run(budget)), expected, 'a warm cache ignores the budget');
});

test('an unwritable cache finishes the run instead of stalling at the budget', async (t) => {
  const f = fixture(t);
  // Several read chunks per file, each with complete lines, so the budget
  // stops a read part-way through and the failed checkpoint write must lead
  // to reading on (as well as the failed writes after a finished file).
  for (const name of ['w1', 'w2']) {
    const records = [user(0)];
    for (let i = 0; i < 12; i++) {
      records.push(user(1 + i, { note: new Array(150_000).fill(1) }));
      records.push(assistant(1 + i, { id: `${name}-${i}`, input: 4, output: 1 }));
    }
    writeTranscript(f.path(name), records);
    assert.ok(statSync(f.path(name)).size > 3 * 1024 * 1024);
  }
  const expected = normalize(await f.uncached());
  // A regular file where the cache directory should be: every write fails.
  const blocked = join(f.base, 'blocked');
  writeFileSync(blocked, '');
  const result = await f.run({ VIBE_USAGE_CACHE_DIR: blocked, VIBE_USAGE_CLAUDE_WORK_BUDGET_MS: '1' });
  assert.equal(result.indexing, undefined);
  assert.deepEqual(normalize(result), expected);
});

test('Magpie bridge and attribution work on cached transcripts built without a ledger', async (t) => {
  const f = fixture(t);
  writeTranscript(f.path('bridged'), [user(0), assistant(1, { id: 'resp-b', requestId: 'req-bridge' })]);
  writeTranscript(f.path('attributed'), [
    user(0),
    assistant(1, { id: 'resp-a', requestId: 'req-a', model: 'claude-opus-4-8', input: 100, output: 20,
      cacheRead: 30, cacheWrite: 10, speed: 'fast' }),
  ]);
  await f.run({}, { magpie: createMagpieContext({ startAt: 'none' }) }); // no ledger yet

  const ledger = join(f.base, 'magpie', 'usage.jsonl');
  mkdirSync(dirname(ledger), { recursive: true });
  const row = (extra) => ({ t: ts(1), ms: 100, status: 200, in: 100, out: 20, cache_read: 30,
    cache_write: 10, ...extra });
  writeFileSync(ledger, lines([
    row({ agent: 'claude', provider: 'claude', rid: 'req-bridge', response_id: 'other' }),
    row({ agent: 'claude', provider: 'anthropic', model: 'claude-opus-4-9', response_id: 'resp-a' }),
  ]));
  const magpie = () => createMagpieContext({ startAt: 'none', now: Date.parse(ts(30)) });
  const expected = normalize(await f.uncached({ magpie: magpie() }));
  assert.equal(expected.sessions.length, 1, 'the bridged session is excluded');
  assert.deepEqual(expected.buckets.map((b) => b.model), ['magpie/anthropic/claude-opus-4-9-fast']);
  assert.deepEqual(normalize(await f.run({}, { magpie: magpie() })), expected);
});

test('cache entries follow their transcripts and damaged entries are only misses', async (t) => {
  const f = fixture(t);
  writeTranscript(f.path('keep'), [user(0), assistant(1, { id: 'k1' })]);
  writeTranscript(f.path('gone'), [user(0), assistant(1, { id: 'g1' })]);
  await f.run();
  assert.equal(f.cacheEntries().length, 2);

  rmSync(f.path('gone'));
  await f.run();
  assert.equal(f.cacheEntries().length, 1, 'the deleted transcript lost its entry');

  const [entry] = f.cacheEntries();
  const entryPath = join(f.cacheDir, 'claude-code', entry);
  for (const damage of ['{"schemaVersion":1,', JSON.stringify({
    ...JSON.parse(readFileSync(entryPath, 'utf8')), state: { keyed: 'not an array' } })]) {
    writeFileSync(entryPath, damage);
    const result = await f.run();
    assert.equal(result.skipped, undefined);
    assert.deepEqual(normalize(result), normalize(await f.uncached()));
  }

  // A run that cannot see this root (here: it was given another one) keeps
  // the entry: only a transcript that no longer exists loses its cache.
  writeFileSync(join(f.base, 'not-a-dir'), '');
  const partial = await f.run({ VIBE_USAGE_CLAUDE_DIRS: join(f.base, 'not-a-dir') });
  assert.equal(partial.skipped, true);
  assert.equal(f.cacheEntries().length, 1);
});

test('the rolling audit re-reads a transcript whose cache is older than the interval', async (t) => {
  const f = fixture(t);
  writeTranscript(f.path('audited'), [user(0), assistant(1, { id: 'x1', input: 10, output: 1 })]);
  await f.run();
  const [entry] = f.cacheEntries();
  const entryPath = join(f.cacheDir, 'claude-code', entry);
  // Simulate a cache that drifted from its transcript without any visible
  // change to the file: the cache is trusted until the audit comes round.
  const saved = JSON.parse(readFileSync(entryPath, 'utf8'));
  saved.state.keyed[0][3] = 999;
  writeFileSync(entryPath, JSON.stringify(saved));
  assert.equal((await f.run()).buckets[0].inputTokens, 999);
  const audited = await f.run({ VIBE_USAGE_CLAUDE_AUDIT_INTERVAL_MS: '0' });
  assert.equal(audited.buckets[0].inputTokens, 10);
  assert.equal((await f.run()).buckets[0].inputTokens, 10, 'the audit rewrote the entry');
});
