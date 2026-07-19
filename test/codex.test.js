import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from '../src/parsers/codex.js';

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
  process.env.CODEX_HOME = root;
  try {
    return await parse();
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
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
  process.env.CODEX_HOME = root;
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
