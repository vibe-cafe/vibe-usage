import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from '../src/parsers/trae-cli.js';

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
