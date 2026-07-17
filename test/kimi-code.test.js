import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The parser resolves both stores at module load. Point them at an isolated
// fixture before importing so a developer's real Kimi history cannot leak in.
const root = mkdtempSync(join(tmpdir(), 'vibe-usage-kimi-test-'));
const currentRoot = join(root, 'kimi-code');
const legacyRoot = join(root, 'kimi-legacy');
process.env.VIBE_USAGE_KIMI_CODE_DIR = currentRoot;
process.env.VIBE_USAGE_KIMI_DIR = legacyRoot;

const { parse } = await import('../src/parsers/kimi-code.js');

after(() => rmSync(root, { recursive: true, force: true }));

function usage(time, usageScope, values) {
  return {
    type: 'usage.record',
    model: 'kimi-code/k3',
    usage: {
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
      ...values,
    },
    usageScope,
    time,
  };
}

test('current Kimi parser counts all delta scopes, cache creation, and subagents once', async () => {
  const sessionDir = join(currentRoot, 'sessions', 'wd_fallback_abcd', 'session_123');
  const mainDir = join(sessionDir, 'agents', 'main');
  const childDir = join(sessionDir, 'agents', 'agent-0');
  mkdirSync(mainDir, { recursive: true });
  mkdirSync(childDir, { recursive: true });

  writeFileSync(join(currentRoot, 'session_index.jsonl'), `${JSON.stringify({
    sessionId: '123',
    sessionDir,
    workDir: '/workspace/actual-project',
  })}\n`, 'utf-8');

  const start = Date.parse('2026-07-17T00:01:00.000Z');
  const mainRecords = [
    { type: 'turn.prompt', origin: { kind: 'user' }, time: start },
    usage(start + 60_000, 'turn', {
      inputOther: 10,
      output: 2,
      inputCacheRead: 4,
      inputCacheCreation: 3,
    }),
    // Session-scoped records are real per-request deltas (for example retry
    // or compaction work), not cumulative summaries.
    usage(start + 120_000, 'session', {
      inputOther: 5,
      output: 1,
      inputCacheRead: 6,
      inputCacheCreation: 7,
    }),
  ];
  writeFileSync(join(mainDir, 'wire.jsonl'), `${mainRecords.map(JSON.stringify).join('\n')}\n${JSON.stringify({
    ...usage(0, 'turn', { inputOther: 999 }),
    time: 1e20,
  })}\n`, 'utf-8');

  const childRecords = [
    { type: 'turn.prompt', origin: { kind: 'system_trigger' }, time: start + 150_000 },
    usage(start + 180_000, 'turn', {
      inputOther: 2,
      output: 1,
      inputCacheRead: 3,
      inputCacheCreation: 1,
    }),
  ];
  writeFileSync(join(childDir, 'wire.jsonl'), `${childRecords.map(JSON.stringify).join('\n')}\n`, 'utf-8');

  const result = await parse();
  assert.equal(result.buckets.length, 1);
  assert.deepEqual(result.buckets[0], {
    source: 'kimi-code',
    model: 'kimi-code/k3',
    project: 'actual-project',
    bucketStart: '2026-07-17T00:00:00.000Z',
    inputTokens: 28,
    outputTokens: 4,
    cachedInputTokens: 13,
    reasoningOutputTokens: 0,
    totalTokens: 32,
  });

  // Main and child wires are one logical user session, not a parent session
  // plus a zero-user subagent session.
  assert.equal(result.sessions.length, 1);
  assert.deepEqual(result.sessions[0], {
    source: 'kimi-code',
    project: 'actual-project',
    sessionHash: result.sessions[0].sessionHash,
    firstMessageAt: '2026-07-17T00:01:00.000Z',
    lastMessageAt: '2026-07-17T00:04:00.000Z',
    durationSeconds: 180,
    activeSeconds: 120,
    messageCount: 4,
    userMessageCount: 1,
    userPromptHours: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  });
});
