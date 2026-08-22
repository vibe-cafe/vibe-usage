import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse, selectTraeUsageSpans } from '../src/parsers/trae-cli.js';

test('parse reads Trae CLI session cache logs and aggregates tokens', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-trae-cli-test-'));
  const sessionsDir = join(root, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });

  const sessionUUID = '892e9718-b764-4dad-ab5c-ea2e3d2a5828';
  const sessionPath = join(sessionsDir, sessionUUID);
  mkdirSync(sessionPath, { recursive: true });

  // Mock session.json
  writeFileSync(join(sessionPath, 'session.json'), JSON.stringify({
    id: sessionUUID,
    created_at: '2026-07-07T20:57:03.162922+08:00',
    updated_at: '2026-07-07T21:58:38.438473+08:00',
    metadata: {
      cwd: '/Users/park0er/coding/Foundations/AgentSetups',
      model_name: 'GLM-5.2',
      permission_mode: 'bypass_permissions',
      title: '扫码完成了'
    }
  }));

  // Mock traces.jsonl
  writeFileSync(join(sessionPath, 'traces.jsonl'), [
    JSON.stringify({
      traceID: '8ee89a9cbeb9641ebdbe9fe16e9129c9',
      spanID: 'c24432205ceac7a5',
      operationName: 'Doubao-Seed-2.1-Pro',
      startTime: 1783429023825200,
      tags: [
        { key: 'span.category', type: 'string', value: 'model.stream.eino' },
        { key: 'model.name', type: 'string', value: 'Doubao-Seed-2.1-Pro' },
        { key: 'usage.input_tokens', type: 'int64', value: 22503 },
        { key: 'usage.output_tokens', type: 'int64', value: 641 },
        { key: 'usage.total_tokens', type: 'int64', value: 23144 },
        { key: 'usage.cache_read_tokens', type: 'int64', value: 5944 },
        { key: 'usage.reasoning_tokens', type: 'int64', value: 578 }
      ]
    }),
    JSON.stringify({
      traceID: '8ee89a9cbeb9641ebdbe9fe16e9129c9',
      spanID: '4d01c049e62044ef',
      operationName: 'Doubao-Seed-2.1-Pro',
      startTime: 1783429023825100,
      tags: [
        { key: 'span.category', type: 'string', value: 'model.real_call' },
        { key: 'usage.input_tokens', type: 'int64', value: 22503 },
        { key: 'usage.output_tokens', type: 'int64', value: 641 },
        { key: 'usage.cache_read_tokens', type: 'int64', value: 5944 },
        { key: 'usage.reasoning_tokens', type: 'int64', value: 0 }
      ]
    }),
    JSON.stringify({
      traceID: 'invalid-time',
      startTime: 'not-a-timestamp',
      tags: [
        { key: 'usage.input_tokens', type: 'int64', value: 999 }
      ]
    })
  ].join('\n') + '\n');

  // Mock events.jsonl
  writeFileSync(join(sessionPath, 'events.jsonl'), [
    JSON.stringify({
      id: 'e0bcb513-39b4-4447-8e22-93c74144ce56',
      session_id: sessionUUID,
      created_at: '2026-07-07T20:57:03.2208+08:00',
      agent_start: {}
    }),
    JSON.stringify({
      id: '2752eeb1-d99f-4b0c-9bf4-35c59660d241',
      session_id: sessionUUID,
      created_at: '2026-07-07T20:57:03.521842+08:00',
      message: { message: { role: 'assistant', content: 'hello' } }
    }),
    JSON.stringify({
      id: 'invalid-time-event',
      session_id: sessionUUID,
      created_at: 'not-a-timestamp',
      agent_start: {}
    })
  ].join('\n') + '\n');

  // Override env path for test
  const prevTraeCliSessions = process.env.VIBE_USAGE_TRAE_CLI_SESSIONS;
  process.env.VIBE_USAGE_TRAE_CLI_SESSIONS = sessionsDir;

  try {
    const result = await parse();

    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].source, 'trae-cli');
    assert.equal(result.sessions[0].project, 'AgentSetups');

    assert.equal(result.buckets.length, 1);
    const bucket = result.buckets[0];
    assert.equal(bucket.source, 'trae-cli');
    assert.equal(bucket.model, 'Doubao-Seed-2.1-Pro');
    assert.equal(bucket.project, 'AgentSetups');
    assert.equal(bucket.inputTokens, 22503);
    assert.equal(bucket.outputTokens, 641);
    assert.equal(bucket.cachedInputTokens, 5944);
    assert.equal(bucket.reasoningOutputTokens, 578);
    assert.equal(bucket.totalTokens, 22503 + 641 + 578);
  } finally {
    if (prevTraeCliSessions) {
      process.env.VIBE_USAGE_TRAE_CLI_SESSIONS = prevTraeCliSessions;
    } else {
      delete process.env.VIBE_USAGE_TRAE_CLI_SESSIONS;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function usageSpan(category, usage, startTime = 1783429023825200, model = 'GLM-5.3') {
  return { category, model, startTime, usage };
}

test('selectTraeUsageSpans keeps one layer per LLM call and sums sequential calls', () => {
  const u1 = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, reasoningTokens: 5 };
  const u2 = { inputTokens: 200, outputTokens: 20, cacheReadTokens: 80, reasoningTokens: 8 };
  const selected = selectTraeUsageSpans([
    usageSpan('model.stream.eino', u1),
    usageSpan('model.real_call', u1),
    usageSpan('model.call', u1),
    usageSpan('model.stream.eino', u2, 1783429023900000),
    usageSpan('model.real_call', u2, 1783429023900000),
    usageSpan('model.call', u2, 1783429023900000),
  ]);
  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map((s) => s.category), ['model.stream.eino', 'model.stream.eino']);
  assert.equal(selected.reduce((n, s) => n + s.usage.inputTokens, 0), 300);
});

test('selectTraeUsageSpans includes failover generate spans alongside stream.eino', () => {
  const glm = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, reasoningTokens: 4 };
  const doubao = { inputTokens: 80, outputTokens: 70, cacheReadTokens: 0, reasoningTokens: 0 };
  const selected = selectTraeUsageSpans([
    usageSpan('model.stream.eino', glm, 1, 'GLM-5.3'),
    usageSpan('model.generate', doubao, 2, 'Doubao-Seed-Evolving'),
  ]);
  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map((s) => s.model).sort(), ['Doubao-Seed-Evolving', 'GLM-5.3']);
});

test('selectTraeUsageSpans falls back to model.real_call when stream.eino is absent', () => {
  const usage = { inputTokens: 40, outputTokens: 2, cacheReadTokens: 0, reasoningTokens: 0 };
  const selected = selectTraeUsageSpans([
    usageSpan('model.real_call', usage),
    usageSpan('model.call', usage),
  ]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].category, 'model.real_call');
});

test('parse sums sequential LLM calls that share one session traceID', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-trae-cli-sum-'));
  const sessionsDir = join(root, 'sessions');
  const sessionPath = join(sessionsDir, 'same-trace');
  mkdirSync(sessionPath, { recursive: true });
  writeFileSync(join(sessionPath, 'session.json'), JSON.stringify({
    id: 'same-trace',
    metadata: { cwd: '/tmp/demo', model_name: 'GLM-5.3' },
  }));
  const traceID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  function span(category, input, output, startTime, reasoning = 0) {
    return JSON.stringify({
      traceID,
      startTime,
      tags: [
        { key: 'span.category', value: category },
        { key: 'model.name', value: 'GLM-5.3' },
        { key: 'usage.input_tokens', value: input },
        { key: 'usage.output_tokens', value: output },
        { key: 'usage.cache_read_tokens', value: 0 },
        { key: 'usage.reasoning_tokens', value: reasoning },
      ],
    });
  }
  writeFileSync(join(sessionPath, 'traces.jsonl'), [
    span('model.stream.eino', 1000, 10, 1787345117880722, 4),
    span('model.real_call', 1000, 10, 1787345117880722, 0),
    span('model.call', 1000, 10, 1787345117880722, 0),
    span('model.stream.eino', 2000, 20, 1787345118880722, 6),
    span('model.real_call', 2000, 20, 1787345118880722, 0),
    span('model.call', 2000, 20, 1787345118880722, 0),
  ].join('\n') + '\n');
  writeFileSync(join(sessionPath, 'events.jsonl'), '');

  const prev = process.env.VIBE_USAGE_TRAE_CLI_SESSIONS;
  process.env.VIBE_USAGE_TRAE_CLI_SESSIONS = sessionsDir;
  try {
    const result = await parse();
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0].inputTokens, 3000);
    assert.equal(result.buckets[0].outputTokens, 30);
    assert.equal(result.buckets[0].reasoningOutputTokens, 10);
    assert.equal(result.buckets[0].model, 'GLM-5.3');
  } finally {
    if (prev) process.env.VIBE_USAGE_TRAE_CLI_SESSIONS = prev;
    else delete process.env.VIBE_USAGE_TRAE_CLI_SESSIONS;
    rmSync(root, { recursive: true, force: true });
  }
});
