import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function taskStarted(timestamp, startedAt) {
  return {
    timestamp,
    type: 'event_msg',
    payload: { type: 'task_started', ...(startedAt == null ? {} : { started_at: startedAt }) },
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
      taskStarted(ownStart, epochSeconds(ownStart)),
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

test('sub-agent rollout without a task_started boundary is counted in full', async () => {
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
