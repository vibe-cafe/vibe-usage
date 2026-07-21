import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from '../src/parsers/codex.js';
import { codexCacheDir } from '../src/parsers/codex-cache.js';

function sessionMeta(timestamp, id, extra = {}) {
  const { metaTimestamp = timestamp, ...payloadExtra } = extra;
  return {
    timestamp,
    type: 'session_meta',
    payload: { id, cwd: '/Users/x/proj', timestamp: metaTimestamp, ...payloadExtra },
  };
}

function taskStarted(timestamp, startedAt, type = 'task_started') {
  return {
    timestamp,
    type: 'event_msg',
    payload: { type, ...(startedAt == null ? {} : { started_at: startedAt }) },
  };
}

function eventMsg(timestamp, type) {
  return { timestamp, type: 'event_msg', payload: { type } };
}

function usage(input, cached, output, reasoning) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

function tokenCount(timestamp, last, cumulativeTotal) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model: 'gpt-5.2',
        total_token_usage: { total_tokens: cumulativeTotal },
        last_token_usage: last,
        model_context_window: 258400,
      },
    },
  };
}

function tokenCountInfo(timestamp, info) {
  return { timestamp, type: 'event_msg', payload: { type: 'token_count', info } };
}

/** Write fixture rollouts under a temp CODEX_HOME and run the parser. */
async function parseFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codex-test-'));
  const dir = join(root, 'sessions', '2026', '07', '10');
  mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    const spec = Array.isArray(value) ? { records: value } : value;
    const targetDir = spec.archived
      ? join(root, 'archived_sessions')
      : dir;
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
      join(targetDir, name),
      spec.records.map((r) => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n'
    );
  }
  const prevHome = process.env.CODEX_HOME;
  const prevCacheDir = process.env.VIBE_USAGE_CACHE_DIR;
  process.env.CODEX_HOME = root;
  process.env.VIBE_USAGE_CACHE_DIR = join(root, 'cache');
  try {
    return await parse();
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
    if (prevCacheDir === undefined) delete process.env.VIBE_USAGE_CACHE_DIR;
    else process.env.VIBE_USAGE_CACHE_DIR = prevCacheDir;
    rmSync(root, { recursive: true, force: true });
  }
}

function createPersistentFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codex-cache-test-'));
  const dir = join(root, 'sessions', '2026', '07', '10');
  mkdirSync(dir, { recursive: true });
  for (const [name, records] of Object.entries(files)) {
    writeFileSync(join(dir, name), records.map(JSON.stringify).join('\n') + '\n');
  }
  return { root, dir, cacheDir: join(root, 'cache') };
}

async function withCodexEnv(fixture, fn) {
  const prevHome = process.env.CODEX_HOME;
  const prevCacheDir = process.env.VIBE_USAGE_CACHE_DIR;
  const prevBudget = process.env.VIBE_USAGE_CODEX_WORK_BUDGET_MS;
  const prevCacheEnabled = process.env.VIBE_USAGE_CODEX_CACHE;
  process.env.CODEX_HOME = fixture.root;
  process.env.VIBE_USAGE_CACHE_DIR = fixture.cacheDir;
  try {
    return await fn();
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
    if (prevCacheDir === undefined) delete process.env.VIBE_USAGE_CACHE_DIR;
    else process.env.VIBE_USAGE_CACHE_DIR = prevCacheDir;
    if (prevBudget === undefined) delete process.env.VIBE_USAGE_CODEX_WORK_BUDGET_MS;
    else process.env.VIBE_USAGE_CODEX_WORK_BUDGET_MS = prevBudget;
    if (prevCacheEnabled === undefined) delete process.env.VIBE_USAGE_CODEX_CACHE;
    else process.env.VIBE_USAGE_CODEX_CACHE = prevCacheEnabled;
  }
}

function sumBuckets(buckets) {
  return buckets.reduce(
    (acc, b) => ({
      input: acc.input + b.inputTokens,
      output: acc.output + b.outputTokens,
      cached: acc.cached + b.cachedInputTokens,
      reasoning: acc.reasoning + b.reasoningOutputTokens,
    }),
    { input: 0, output: 0, cached: 0, reasoning: 0 }
  );
}

function epochSeconds(iso) {
  return Math.floor(Date.parse(iso) / 1000);
}

test('sub-agent rollout skips inherited parent history before its own task_started', async () => {
  const t = '2026-07-10T08:00:55.000Z';
  const { buckets, sessions } = await parseFixture({
    'rollout-sub.jsonl': [
      sessionMeta(t, 'sub-1', {
        parent_thread_id: 'parent-1',
        thread_source: 'subagent',
        source: { subagent: { thread_spawn: { parent_thread_id: 'parent-1' } } },
      }),
      // Inherited parent history, re-stamped at spawn time. Already counted
      // from the parent's own rollout — must not count again here.
      eventMsg(t, 'user_message'),
      eventMsg(t, 'agent_message'),
      tokenCount(t, usage(100000, 90000, 5000, 1000), 1000000),
      tokenCount(t, usage(200000, 180000, 6000, 1500), 2000000),
      tokenCount(t, usage(300000, 270000, 7000, 2000), 3000000),
      // The sub-agent's own work starts here.
      taskStarted('2026-07-10T08:00:56.000Z'),
      tokenCount('2026-07-10T08:01:10.000Z', usage(1000, 800, 100, 20), 1100),
      tokenCount('2026-07-10T08:02:30.000Z', usage(2000, 1600, 200, 40), 3300),
    ],
  });

  assert.deepEqual(sumBuckets(buckets), {
    input: (1000 - 800) + (2000 - 1600),
    output: (100 - 20) + (200 - 40),
    cached: 800 + 1600,
    reasoning: 20 + 40,
  });

  // Session stats reflect only the sub-agent's own conversation:
  // session_meta + task_started + 2 token_counts.
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].messageCount, 4);
  assert.equal(sessions[0].userMessageCount, 1);
});

test('double-meta sub-agent keeps child identity and skips copied parent tasks and tokens', async () => {
  const parentStart = '2026-07-10T08:00:00.000Z';
  const spawn = '2026-07-10T08:10:10.800Z';
  const ownStart = '2026-07-10T08:10:13.000Z';
  const { buckets, sessions } = await parseFixture({
    'rollout-parent.jsonl': [
      sessionMeta(parentStart, 'parent-1', { cwd: '/Users/x/parent-project' }),
      taskStarted(parentStart, epochSeconds(parentStart)),
      tokenCount('2026-07-10T08:01:00.000Z', usage(100, 0, 10, 0), 110),
      tokenCount('2026-07-10T08:09:00.000Z', usage(200, 0, 20, 0), 330),
      // The parent starts another task in the same rounded second as the
      // child spawn, then continues producing usage after the spawn.
      taskStarted('2026-07-10T08:10:10.100Z', epochSeconds(spawn)),
      tokenCount('2026-07-10T08:11:00.000Z', usage(300, 0, 30, 0), 660),
    ],
    'rollout-child.jsonl': [
      sessionMeta(spawn, 'child-1', {
        cwd: '/Users/x/child-project',
        forked_from_id: 'parent-1',
        parent_thread_id: 'parent-1',
        thread_source: 'subagent',
        source: { subagent: { thread_spawn: { parent_thread_id: 'parent-1' } } },
      }),
      // Real Codex Desktop layout: the copied parent session_meta and parent
      // tasks are present before the child's own task_started.
      sessionMeta(spawn, 'parent-1', {
        cwd: '/Users/x/parent-project',
        metaTimestamp: parentStart,
        thread_source: 'user',
      }),
      taskStarted(spawn, epochSeconds(parentStart)),
      tokenCount(spawn, usage(100, 0, 10, 0), 110),
      tokenCount(spawn, usage(200, 0, 20, 0), 330),
      // Copied parent task happens to match the spawn second. The later match
      // is the child's actual boundary and must win.
      taskStarted(spawn, epochSeconds(spawn)),
      taskStarted(ownStart, epochSeconds(ownStart), 'turn_started'),
      tokenCount('2026-07-10T08:10:20.000Z', usage(5, 0, 3, 0), 338),
    ],
  });

  // Parent usage is counted once (including its post-spawn work); only the
  // child's own final token_count is added from the child rollout.
  assert.deepEqual(sumBuckets(buckets), { input: 605, output: 63, cached: 0, reasoning: 0 });
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map(s => s.project).sort(), ['child-project', 'parent-project']);
  const child = sessions.find(s => s.project === 'child-project');
  assert.equal(child.messageCount, 3); // child meta + own task_started + own token_count
  assert.equal(child.userMessageCount, 1);
});

test('ordinary fork skips parent raw tokens only up to fork time', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const tf = '2026-07-10T08:30:00.000Z';
  const malformed = eventMsg(null, 'token_count');
  const copiedMalformed = eventMsg(null, 'token_count');
  const { buckets } = await parseFixture({
    'rollout-parent.jsonl': [
      sessionMeta(t, 'parent-1'),
      tokenCount('2026-07-10T08:05:00.000Z', usage(10, 0, 1, 0), 11),
      malformed, // raw ordinal with no info still belongs to the replay prefix
      tokenCount('2026-07-10T08:20:00.000Z', usage(20, 0, 2, 0), 33),
      // Parent keeps running after the fork; this record was never copied.
      tokenCount('2026-07-10T08:40:00.000Z', usage(30, 0, 3, 0), 66),
    ],
    'rollout-fork.jsonl': [
      sessionMeta(tf, 'fork-1', { forked_from_id: 'parent-1' }),
      tokenCount(tf, usage(10, 0, 1, 0), 11),
      copiedMalformed,
      tokenCount(tf, usage(20, 0, 2, 0), 33),
      tokenCount('2026-07-10T08:31:00.000Z', usage(5, 0, 3, 0), 41),
    ],
  });

  assert.deepEqual(sumBuckets(buckets), { input: 65, output: 9, cached: 0, reasoning: 0 });
});

test('last-N-turn fork matches a replayed parent suffix without dropping child usage', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const tf = '2026-07-10T08:30:00.000Z';
  const { buckets } = await parseFixture({
    'rollout-parent.jsonl': [
      sessionMeta(t, 'parent-1'),
      tokenCount('2026-07-10T08:05:00.000Z', usage(10, 0, 1, 0), 11),
      tokenCount('2026-07-10T08:10:00.000Z', usage(20, 0, 2, 0), 33),
      tokenCount('2026-07-10T08:15:00.000Z', usage(30, 0, 3, 0), 66),
      tokenCount('2026-07-10T08:20:00.000Z', usage(40, 0, 4, 0), 110),
    ],
    'rollout-fork.jsonl': [
      sessionMeta(tf, 'fork-1', { forked_from_id: 'parent-1' }),
      // Current Codex can retain only the last N turns. These are a suffix of
      // the parent history, not the prefix assumed by the old count heuristic.
      tokenCount(tf, usage(30, 0, 3, 0), 66),
      tokenCount(tf, usage(40, 0, 4, 0), 110),
      tokenCount('2026-07-10T08:31:00.000Z', usage(5, 0, 5, 0), 120),
    ],
  });

  assert.deepEqual(sumBuckets(buckets), { input: 105, output: 15, cached: 0, reasoning: 0 });
});

test('last-N-turn sub-agent finds a delayed own task after the matched replay suffix', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const spawn = '2026-07-10T08:30:00.800Z';
  const ownStart = '2026-07-10T08:30:20.000Z';
  const { buckets, sessions } = await parseFixture({
    'rollout-parent.jsonl': [
      sessionMeta(t, 'parent-1'),
      taskStarted(t, epochSeconds(t)),
      tokenCount('2026-07-10T08:05:00.000Z', usage(10, 0, 1, 0), 11),
      taskStarted('2026-07-10T08:10:00.000Z', epochSeconds('2026-07-10T08:10:00.000Z')),
      tokenCount('2026-07-10T08:15:00.000Z', usage(20, 0, 2, 0), 33),
    ],
    'rollout-child.jsonl': [
      sessionMeta(spawn, 'child-1', {
        forked_from_id: 'parent-1',
        parent_thread_id: 'parent-1',
        thread_source: 'subagent',
      }),
      // A last-turn suffix has no copied parent session_meta.
      taskStarted(spawn, epochSeconds('2026-07-10T08:10:00.000Z')),
      tokenCount(spawn, usage(20, 0, 2, 0), 33),
      // Startup can exceed the old fixed five-second matching window.
      taskStarted(ownStart, epochSeconds(ownStart)),
      tokenCount('2026-07-10T08:30:25.000Z', usage(5, 0, 3, 0), 41),
    ],
  });

  assert.deepEqual(sumBuckets(buckets), { input: 35, output: 6, cached: 0, reasoning: 0 });
  assert.equal(sessions.length, 2);
  const child = sessions.find(session => session.firstMessageAt === spawn);
  assert.ok(child);
  assert.equal(child.messageCount, 3);
});

test('in-progress sub-agent replay does not count a partial parent snapshot', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const spawn = '2026-07-10T08:30:00.000Z';
  const parentRecords = [
    sessionMeta(t, 'parent-1'),
    tokenCount('2026-07-10T08:05:00.000Z', usage(10, 0, 1, 0), 11),
    tokenCount('2026-07-10T08:10:00.000Z', usage(20, 0, 2, 0), 33),
    tokenCount('2026-07-10T08:15:00.000Z', usage(30, 0, 3, 0), 66),
  ];
  const childMeta = sessionMeta(spawn, 'child-1', {
    parent_thread_id: 'parent-1',
    thread_source: 'subagent',
  });

  // Codex writes the copied parent block before the child's own task. A sync
  // can catch that append halfway through, when the child prefix is an exact
  // interior slice of the parent but has not reached the parent snapshot end.
  const partial = await parseFixture({
    'rollout-parent.jsonl': parentRecords,
    'rollout-child.jsonl': [childMeta, parentRecords[1], parentRecords[2]],
  });

  const complete = await parseFixture({
    'rollout-parent.jsonl': parentRecords,
    'rollout-child.jsonl': [
      childMeta,
      ...parentRecords.slice(1),
      taskStarted('2026-07-10T08:30:01.000Z', epochSeconds('2026-07-10T08:30:01.000Z')),
      tokenCount('2026-07-10T08:30:05.000Z', usage(5, 0, 5, 0), 76),
    ],
  });

  assert.deepEqual(sumBuckets(partial.buckets), { input: 60, output: 6, cached: 0, reasoning: 0 });
  assert.deepEqual(sumBuckets(complete.buckets), { input: 65, output: 11, cached: 0, reasoning: 0 });
});

test('copied task boundaries inside a partial sub-agent replay stay inherited', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const secondTurn = '2026-07-10T08:10:00.000Z';
  const spawn = '2026-07-10T08:30:00.000Z';
  const firstToken = tokenCount('2026-07-10T08:05:00.000Z', usage(10, 0, 1, 0), 11);
  const secondToken = tokenCount('2026-07-10T08:15:00.000Z', usage(20, 0, 2, 0), 33);
  const finalToken = tokenCount('2026-07-10T08:20:00.000Z', usage(30, 0, 3, 0), 66);
  const { buckets } = await parseFixture({
    'rollout-parent.jsonl': [
      sessionMeta(t, 'parent-1'),
      taskStarted(t, epochSeconds(t)),
      firstToken,
      taskStarted(secondTurn, epochSeconds(secondTurn)),
      secondToken,
      finalToken,
    ],
    'rollout-child.jsonl': [
      sessionMeta(spawn, 'child-1', {
        parent_thread_id: 'parent-1',
        thread_source: 'subagent',
      }),
      // Single-meta Last-N rollouts can copy parent task markers too. The
      // legacy first-task fallback must not expose the copied tokens that
      // follow this parent boundary while the replay is still incomplete.
      taskStarted(spawn, epochSeconds(t)),
      firstToken,
      taskStarted(spawn, epochSeconds(secondTurn)),
      secondToken,
    ],
  });

  assert.deepEqual(sumBuckets(buckets), { input: 60, output: 6, cached: 0, reasoning: 0 });
});

test('live rollout appends are deferred to the next stable parser snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codex-live-test-'));
  const dir = join(root, 'sessions', '2026', '07', '10');
  mkdirSync(dir, { recursive: true });

  const t = '2026-07-10T08:00:00.000Z';
  const spawn = '2026-07-10T08:30:00.000Z';
  const parentTokens = [
    tokenCount('2026-07-10T08:05:00.000Z', usage(10, 0, 1, 0), 11),
    tokenCount('2026-07-10T08:10:00.000Z', usage(20, 0, 2, 0), 33),
    tokenCount('2026-07-10T08:15:00.000Z', usage(30, 0, 3, 0), 66),
  ];
  const parentPath = join(dir, 'rollout-parent.jsonl');
  const childPath = join(dir, 'rollout-child.jsonl');
  writeFileSync(
    parentPath,
    [sessionMeta(t, 'parent-1'), ...parentTokens].map(JSON.stringify).join('\n') + '\n'
  );
  writeFileSync(
    childPath,
    [
      sessionMeta(spawn, 'child-1', {
        parent_thread_id: 'parent-1',
        thread_source: 'subagent',
      }),
      parentTokens[0],
      parentTokens[1],
    ].map(JSON.stringify).join('\n') + '\n'
  );

  const prevHome = process.env.CODEX_HOME;
  const prevCacheDir = process.env.VIBE_USAGE_CACHE_DIR;
  process.env.CODEX_HOME = root;
  process.env.VIBE_USAGE_CACHE_DIR = join(root, 'cache');
  try {
    // parse() captures every rollout's byte size before its first asynchronous
    // read. Appending immediately afterward must not leak new records into its
    // second pass; they belong to the next sync's snapshot.
    const firstParse = parse();
    appendFileSync(
      childPath,
      [
        parentTokens[2],
        taskStarted('2026-07-10T08:30:01.000Z', epochSeconds('2026-07-10T08:30:01.000Z')),
        tokenCount('2026-07-10T08:30:05.000Z', usage(5, 0, 5, 0), 76),
      ].map(JSON.stringify).join('\n') + '\n'
    );

    const partial = await firstParse;
    const complete = await parse();
    assert.deepEqual(sumBuckets(partial.buckets), { input: 60, output: 6, cached: 0, reasoning: 0 });
    assert.deepEqual(sumBuckets(complete.buckets), { input: 65, output: 11, cached: 0, reasoning: 0 });
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
    if (prevCacheDir === undefined) delete process.env.VIBE_USAGE_CACHE_DIR;
    else process.env.VIBE_USAGE_CACHE_DIR = prevCacheDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('unmatched sub-agent usage without a task boundary is still counted', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const spawn = '2026-07-10T08:30:00.000Z';
  const { buckets } = await parseFixture({
    'rollout-parent.jsonl': [
      sessionMeta(t, 'parent-1'),
      tokenCount(t, usage(10, 0, 1, 0), 11),
    ],
    'rollout-child.jsonl': [
      sessionMeta(spawn, 'child-1', {
        parent_thread_id: 'parent-1',
        thread_source: 'subagent',
      }),
      tokenCount(spawn, usage(7, 0, 4, 0), 22),
    ],
  });

  // Partial-replay protection is exact: unrelated child payloads retain the
  // existing fail-open behavior even without a task_started marker.
  assert.deepEqual(sumBuckets(buckets), { input: 17, output: 5, cached: 0, reasoning: 0 });
});

test('unmatched fork payloads are counted instead of over-skipping by parent length', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const tf = '2026-07-10T08:30:00.000Z';
  const { buckets } = await parseFixture({
    'rollout-parent.jsonl': [
      sessionMeta(t, 'parent-1'),
      tokenCount(t, usage(10, 0, 1, 0), 11),
      tokenCount(t, usage(20, 0, 2, 0), 33),
    ],
    'rollout-fork.jsonl': [
      sessionMeta(tf, 'fork-1', { forked_from_id: 'parent-1' }),
      tokenCount(tf, usage(7, 0, 4, 0), 11),
    ],
  });

  assert.deepEqual(sumBuckets(buckets), { input: 37, output: 7, cached: 0, reasoning: 0 });
});

test('fork matching rejects an interior parent token that is not the snapshot suffix', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const tf = '2026-07-10T08:30:00.000Z';
  const repeated = tokenCount(tf, usage(10, 0, 1, 0), 11);
  const { buckets } = await parseFixture({
    'rollout-parent.jsonl': [
      sessionMeta(t, 'parent-1'),
      tokenCount(t, usage(10, 0, 1, 0), 11),
      tokenCount('2026-07-10T08:10:00.000Z', usage(20, 0, 2, 0), 33),
    ],
    'rollout-fork.jsonl': [
      sessionMeta(tf, 'fork-1', { forked_from_id: 'parent-1' }),
      repeated,
    ],
  });

  // A LastNTurns snapshot always reaches the parent's current end, so the
  // repeated first parent payload alone is not sufficient replay evidence.
  assert.deepEqual(sumBuckets(buckets), { input: 40, output: 4, cached: 0, reasoning: 0 });
});

test('replayed cumulative totals advance the fallback baseline', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const firstTotal = usage(100, 0, 10, 0);
  const nextTotal = usage(150, 0, 20, 0);
  const { buckets } = await parseFixture({
    'rollout-sub.jsonl': [
      sessionMeta(t, 'sub-1', { thread_source: 'subagent', parent_thread_id: 'missing-parent' }),
      // A malformed timestamp must not prevent this copied cumulative record
      // from advancing the fallback baseline.
      tokenCountInfo(null, {
        model: 'gpt-5.2',
        total_token_usage: firstTotal,
        last_token_usage: firstTotal,
      }),
      taskStarted('2026-07-10T08:00:01.000Z'),
      tokenCountInfo('2026-07-10T08:00:02.000Z', {
        model: 'gpt-5.2',
        total_token_usage: nextTotal,
      }),
    ],
  });

  assert.deepEqual(sumBuckets(buckets), { input: 50, output: 10, cached: 0, reasoning: 0 });
});

test('cumulative-only counter reset starts a fresh non-negative baseline', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const { buckets } = await parseFixture({
    'rollout-a.jsonl': [
      sessionMeta(t, 'a-1'),
      tokenCountInfo(t, {
        model: 'gpt-5.2',
        total_token_usage: usage(100, 0, 10, 0),
      }),
      tokenCountInfo('2026-07-10T08:05:00.000Z', {
        model: 'gpt-5.2',
        total_token_usage: usage(20, 0, 2, 0),
      }),
    ],
  });

  assert.deepEqual(sumBuckets(buckets), { input: 120, output: 12, cached: 0, reasoning: 0 });
});

test('cumulative-only fallback remains session-wide across model switches', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const { buckets } = await parseFixture({
    'rollout-a.jsonl': [
      sessionMeta(t, 'a-1'),
      tokenCountInfo(t, {
        model: 'gpt-5.2',
        total_token_usage: usage(100, 0, 10, 0),
      }),
      tokenCountInfo('2026-07-10T08:05:00.000Z', {
        model: 'gpt-5.3',
        total_token_usage: usage(150, 0, 20, 0),
      }),
    ],
  });

  assert.deepEqual(sumBuckets(buckets), { input: 150, output: 20, cached: 0, reasoning: 0 });
});

test('same session in live and archived directories uses the more complete copy once', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const records = [
    sessionMeta(t, 'same-1'),
    taskStarted(t),
    tokenCount(t, usage(100, 0, 10, 0), 110),
  ];
  const { buckets, sessions } = await parseFixture({
    'rollout-live.jsonl': records.slice(0, 2),
    'rollout-archived.jsonl': { records, archived: true },
  });

  assert.deepEqual(sumBuckets(buckets), { input: 100, output: 10, cached: 0, reasoning: 0 });
  assert.equal(sessions.length, 1);
});

test('repeated same-id session metadata remains part of the logical session', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const later = '2026-07-10T09:00:00.000Z';
  const { sessions } = await parseFixture({
    'rollout-a.jsonl': [
      sessionMeta(t, 'same-1'),
      tokenCount(t, usage(100, 0, 10, 0), 110),
      sessionMeta(later, 'same-1'),
      tokenCount(later, usage(20, 0, 2, 0), 132),
    ],
  });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].messageCount, 4);
  assert.equal(sessions[0].userMessageCount, 2);
});

test('sub-agent rollout without a task boundary or parent evidence is counted in full', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const { buckets } = await parseFixture({
    'rollout-sub.jsonl': [
      sessionMeta(t, 'sub-1', { thread_source: 'subagent', parent_thread_id: 'parent-1' }),
      tokenCount(t, usage(1000, 0, 100, 0), 1100),
      tokenCount(t, usage(2000, 0, 200, 0), 3300),
    ],
  });

  assert.deepEqual(sumBuckets(buckets), { input: 3000, output: 300, cached: 0, reasoning: 0 });
});

test('duplicate token_count emissions (unchanged cumulative total) count once', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const { buckets } = await parseFixture({
    'rollout-a.jsonl': [
      sessionMeta(t, 'a-1'),
      taskStarted(t),
      tokenCount(t, usage(1000, 0, 100, 0), 1100),
      // Exact re-emission of the previous record — cumulative total is
      // unchanged, so it must contribute nothing.
      tokenCount(t, usage(1000, 0, 100, 0), 1100),
      tokenCount('2026-07-10T08:05:00.000Z', usage(2000, 0, 200, 0), 3300),
    ],
  });

  assert.deepEqual(sumBuckets(buckets), { input: 3000, output: 300, cached: 0, reasoning: 0 });
});

test('zero-usage bookkeeping events with an unchanged cumulative total contribute nothing', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const { buckets } = await parseFixture({
    'rollout-a.jsonl': [
      sessionMeta(t, 'a-1'),
      taskStarted(t),
      tokenCount(t, usage(1000, 0, 100, 0), 1100),
      // Compaction-style event: component fields all zero, only
      // last_token_usage.total_tokens set, cumulative unchanged.
      tokenCount(t, { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 13582 }, 1100),
    ],
  });

  assert.deepEqual(sumBuckets(buckets), { input: 1000, output: 100, cached: 0, reasoning: 0 });
});

test('forked session still skips exactly the source session\'s replayed token_counts', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const tf = '2026-07-10T08:30:00.000Z';
  const { buckets } = await parseFixture({
    'rollout-parent.jsonl': [
      sessionMeta(t, 'parent-1'),
      taskStarted(t),
      tokenCount(t, usage(10, 0, 1, 0), 11),
      tokenCount(t, usage(20, 0, 2, 0), 33),
    ],
    'rollout-fork.jsonl': [
      sessionMeta(tf, 'fork-1', { forked_from_id: 'parent-1' }),
      // Replayed copy of the parent's file (2 token_counts), then new work.
      taskStarted(tf),
      tokenCount(tf, usage(10, 0, 1, 0), 11),
      tokenCount(tf, usage(20, 0, 2, 0), 33),
      tokenCount(tf, usage(5, 0, 3, 0), 41),
    ],
  });

  // parent (10+20 in, 1+2 out) counted once + fork's own new turn (5 in, 3 out).
  assert.deepEqual(sumBuckets(buckets), { input: 35, output: 6, cached: 0, reasoning: 0 });
});

test('unchanged ordinary sessions reuse cached headers and results without reading rollouts', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const fixture = createPersistentFixture({
    'rollout-a.jsonl': [
      sessionMeta(t, 'cache-a'),
      tokenCount(t, usage(100, 20, 10, 2), 110),
    ],
  });
  try {
    await withCodexEnv(fixture, async () => {
      const cold = await parse();
      const warm = await parse();
      assert.deepEqual(warm.buckets, cold.buckets);
      assert.deepEqual(warm.sessions, cold.sessions);
      assert.equal(cold.cache.filesRead, 2); // short header discovery + one full parse
      assert.equal(warm.cache.filesRead, 0);
      assert.equal(warm.cache.headerHits, 1);
      assert.equal(warm.cache.resultHits, 1);
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('an appended rollout invalidates only that file while unchanged files stay cached', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const fixture = createPersistentFixture({
    'rollout-a.jsonl': [sessionMeta(t, 'cache-a'), tokenCount(t, usage(10, 0, 1, 0), 11)],
    'rollout-b.jsonl': [sessionMeta(t, 'cache-b'), tokenCount(t, usage(20, 0, 2, 0), 22)],
  });
  try {
    await withCodexEnv(fixture, async () => {
      await parse();
      const warm = await parse();
      assert.equal(warm.cache.filesRead, 0);

      appendFileSync(
        join(fixture.dir, 'rollout-a.jsonl'),
        JSON.stringify(tokenCount('2026-07-10T08:05:00.000Z', usage(5, 0, 3, 0), 19)) + '\n'
      );
      const changed = await parse();
      assert.deepEqual(sumBuckets(changed.buckets), { input: 35, output: 6, cached: 0, reasoning: 0 });
      assert.equal(changed.cache.resultHits, 1);
      assert.equal(changed.cache.tailHits, 1);
      assert.equal(changed.cache.filesRead, 1); // only the appended tail
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('an in-place rollout rewrite rejects the tail cache and rebuilds from raw logs', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const fixture = createPersistentFixture({
    'rollout-a.jsonl': [sessionMeta(t, 'old-session'), tokenCount(t, usage(10, 0, 1, 0), 11)],
  });
  try {
    await withCodexEnv(fixture, async () => {
      await parse();
      writeFileSync(
        join(fixture.dir, 'rollout-a.jsonl'),
        [
          sessionMeta(t, 'replacement-session'),
          tokenCount(t, usage(30, 0, 3, 0), 33),
          tokenCount('2026-07-10T08:05:00.000Z', usage(40, 0, 4, 0), 77),
        ].map(JSON.stringify).join('\n') + '\n'
      );

      const rebuilt = await parse();
      assert.deepEqual(sumBuckets(rebuilt.buckets), { input: 70, output: 7, cached: 0, reasoning: 0 });
      assert.equal(rebuilt.sessions.length, 1);
      assert.equal(rebuilt.cache.tailHits, 0);
      assert.equal(rebuilt.cache.filesRead, 2); // replacement header + full replacement file
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('cache can be disabled without changing parser results', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const fixture = createPersistentFixture({
    'rollout-a.jsonl': [sessionMeta(t, 'no-cache'), tokenCount(t, usage(10, 2, 3, 1), 13)],
  });
  try {
    await withCodexEnv(fixture, async () => {
      const cached = await parse();
      process.env.VIBE_USAGE_CODEX_CACHE = '0';
      const uncached = await parse();
      assert.deepEqual(uncached.buckets, cached.buckets);
      assert.deepEqual(uncached.sessions, cached.sessions);
      assert.equal(uncached.cache.filesRead, 2);
      assert.equal(uncached.cache.resultHits, 0);
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a corrupt parser cache fails open and rebuilds from raw logs', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const fixture = createPersistentFixture({
    'rollout-a.jsonl': [sessionMeta(t, 'cache-a'), tokenCount(t, usage(10, 0, 1, 0), 11)],
  });
  try {
    await withCodexEnv(fixture, async () => {
      const expected = await parse();
      const dir = codexCacheDir(fixture.root);
      const [entry] = readdirSync(dir).filter(name => name.endsWith('.json') && !name.endsWith('.tail.json'));
      assert.ok(entry);
      writeFileSync(join(dir, entry), '{broken');

      const rebuilt = await parse();
      assert.deepEqual(rebuilt.buckets, expected.buckets);
      assert.deepEqual(rebuilt.sessions, expected.sessions);
      assert.equal(rebuilt.cache.filesRead, 2);
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rolling audit re-reads one bounded warm file without changing results', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const fixture = createPersistentFixture({
    'rollout-a.jsonl': [sessionMeta(t, 'audit-a'), tokenCount(t, usage(10, 0, 1, 0), 11)],
    'rollout-b.jsonl': [sessionMeta(t, 'audit-b'), tokenCount(t, usage(20, 0, 2, 0), 22)],
  });
  const prevInterval = process.env.VIBE_USAGE_CODEX_AUDIT_INTERVAL_MS;
  try {
    await withCodexEnv(fixture, async () => {
      const expected = await parse();
      process.env.VIBE_USAGE_CODEX_AUDIT_INTERVAL_MS = '0';
      const audited = await parse();
      assert.deepEqual(audited.buckets, expected.buckets);
      assert.deepEqual(audited.sessions, expected.sessions);
      assert.equal(audited.cache.audited, 1);
      assert.equal(audited.cache.filesRead, 2); // short header + one ordinary full scan
      assert.equal(audited.cache.resultHits, 1);
    });
  } finally {
    if (prevInterval === undefined) delete process.env.VIBE_USAGE_CODEX_AUDIT_INTERVAL_MS;
    else process.env.VIBE_USAGE_CODEX_AUDIT_INTERVAL_MS = prevInterval;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a cold build checkpoints between files and resumes after its work budget', async () => {
  const t = '2026-07-10T08:00:00.000Z';
  const files = {};
  for (let i = 0; i < 60; i++) {
    files[`rollout-${i}.jsonl`] = [
      sessionMeta(t, `budget-${i}`),
      tokenCount(t, usage(i + 1, 0, 1, 0), i + 2),
    ];
  }
  const fixture = createPersistentFixture(files);
  try {
    await withCodexEnv(fixture, async () => {
      process.env.VIBE_USAGE_CODEX_WORK_BUDGET_MS = '1';
      const partial = await parse();
      assert.equal(partial.skipped, true);
      assert.ok(partial.indexing.completed > 0);

      delete process.env.VIBE_USAGE_CODEX_WORK_BUDGET_MS;
      const complete = await parse();
      assert.equal(complete.skipped, undefined);
      assert.equal(complete.sessions.length, 60);
      assert.ok(complete.cache.headerHits > 0);
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
