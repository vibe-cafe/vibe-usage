import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cliEventsToEntries, conversationsToEstimateEntries, parse, snapshotsToCreditEntries } from '../src/parsers/kiro.js';

test('snapshotsToCreditEntries emits positive credit deltas only', () => {
  const entries = snapshotsToCreditEntries([
    snapshot('2026-06-25T00:00:00Z', 0, '2026-07-01T00:00:00Z'),
    snapshot('2026-06-29T12:00:00Z', 10.25, '2026-07-01T00:00:00Z'),
    snapshot('2026-06-29T12:05:00Z', 10.25, '2026-07-01T00:00:00Z'),
    snapshot('2026-06-29T13:00:00Z', 13, '2026-07-01T00:00:00Z'),
  ]);

  assert.deepEqual(entries.map(e => ({
    model: e.model,
    outputTokens: e.outputTokens,
    iso: e.timestamp.toISOString(),
  })), [
    { model: 'kiro-credits', outputTokens: 10.25, iso: '2026-06-29T12:00:00.000Z' },
    { model: 'kiro-credits', outputTokens: 2.75, iso: '2026-06-29T13:00:00.000Z' },
  ]);
});

test('snapshotsToCreditEntries treats a usage reset as a new baseline', () => {
  const entries = snapshotsToCreditEntries([
    snapshot('2026-06-30T23:00:00Z', 42, '2026-07-01T00:00:00Z'),
    snapshot('2026-07-01T00:05:00Z', 1, '2026-08-01T00:00:00Z'),
    snapshot('2026-07-01T01:00:00Z', 4, '2026-08-01T00:00:00Z'),
  ]);

  assert.deepEqual(entries.map(e => e.outputTokens), [3]);
});

test('parse reads q-client logs and aggregates Kiro credits without model guessing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-kiro-test-'));
  const userPath = join(root, 'Kiro', 'User');
  const sessionsDir = join(root, 'empty-sessions');
  const logDir = join(root, 'Kiro', 'logs', '20260629T120000', 'window1', 'exthost', 'kiro.kiroAgent');
  mkdirSync(userPath, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, 'q-client.log'), [
    logLine('2026-06-29 12:00:00.000', 100, '2026-07-01T00:00:00.000Z'),
    logLine('2026-06-29 12:10:00.000', 125.5, '2026-07-01T00:00:00.000Z'),
    logLine('2026-06-29 12:40:00.000', 130, '2026-07-01T00:00:00.000Z'),
  ].join('\n') + '\n');

  const prevUserPath = process.env.KIRO_USER_PATH;
  const prevSessionsDir = process.env.KIRO_SESSIONS_DIR;
  const prevCliDbPath = process.env.KIRO_CLI_DB_PATH;
  const prevCliSessionsDir = process.env.KIRO_CLI_SESSIONS_DIR;
  const prevLegacy = process.env.VIBE_USAGE_KIRO_LEGACY_TOKENS;
  process.env.KIRO_USER_PATH = userPath;
  process.env.KIRO_SESSIONS_DIR = sessionsDir;
  process.env.KIRO_CLI_DB_PATH = join(root, 'missing.sqlite3');
  process.env.KIRO_CLI_SESSIONS_DIR = sessionsDir;
  delete process.env.VIBE_USAGE_KIRO_LEGACY_TOKENS;
  try {
    const result = await parse();
    assert.equal(result.sessions.length, 0);
    assert.deepEqual(result.buckets.map(b => ({
      model: b.model,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      totalTokens: b.totalTokens,
    })), [
      { model: 'kiro-credits', inputTokens: 0, outputTokens: 25.5, totalTokens: 25.5 },
      { model: 'kiro-credits', inputTokens: 0, outputTokens: 4.5, totalTokens: 4.5 },
    ]);
  } finally {
    restoreEnv('KIRO_USER_PATH', prevUserPath);
    restoreEnv('KIRO_SESSIONS_DIR', prevSessionsDir);
    restoreEnv('KIRO_CLI_DB_PATH', prevCliDbPath);
    restoreEnv('KIRO_CLI_SESSIONS_DIR', prevCliSessionsDir);
    restoreEnv('VIBE_USAGE_KIRO_LEGACY_TOKENS', prevLegacy);
    rmSync(root, { recursive: true, force: true });
  }
});

test('conversationsToEstimateEntries estimates Kiro CLI cache write/read/output tokens', () => {
  const entries = conversationsToEstimateEntries([{
    conversation_id: 'conv-1',
    cwd: '/repo/app',
    created_at: 1782720000000,
    updated_at: 1782721800000,
    value: {
      conversation_id: 'conv-1',
      history: [
        {
          user: { text: 'abcdefgh' },
          assistant: { text: 'ABCDEFGH' },
          request_metadata: {
            request_start_timestamp_ms: 1782720000000,
            model_id: 'claude-sonnet-4.5',
            time_between_chunks: [1, 2, 3],
          },
        },
        {
          user: { text: 'abcd' },
          assistant: { text: 'ABCDEFGHIJKL' },
          request_metadata: {
            request_start_timestamp_ms: 1782721800000,
            model_id: 'claude-sonnet-4.5',
            time_between_chunks: [1],
          },
        },
      ],
    },
  }]);

  assert.deepEqual(entries.map(e => ({
    model: e.model,
    project: e.project,
    inputTokens: e.inputTokens,
    cachedInputTokens: e.cachedInputTokens,
    outputTokens: e.outputTokens,
    iso: e.timestamp.toISOString(),
  })), [
    {
      model: 'claude-sonnet-4.5',
      project: '/repo/app',
      inputTokens: 2,
      cachedInputTokens: 0,
      outputTokens: 3,
      iso: '2026-06-29T08:00:00.000Z',
    },
    {
      model: 'claude-sonnet-4.5',
      project: '/repo/app',
      inputTokens: 3,
      cachedInputTokens: 4,
      outputTokens: 1,
      iso: '2026-06-29T08:30:00.000Z',
    },
  ]);
});

test('parse prefers archived Kiro CLI token estimates over q-client credits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-kiro-cli-test-'));
  const userPath = join(root, 'Kiro', 'User');
  const sessionsDir = join(root, '.kiro_sessions');
  const logDir = join(root, 'Kiro', 'logs', '20260629T120000', 'window1', 'exthost', 'kiro.kiroAgent');
  mkdirSync(userPath, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, 'q-client.log'), [
    logLine('2026-06-29 12:00:00.000', 100, '2026-07-01T00:00:00.000Z'),
    logLine('2026-06-29 12:10:00.000', 105, '2026-07-01T00:00:00.000Z'),
  ].join('\n') + '\n');
  writeFileSync(join(sessionsDir, 'conv-2.json'), JSON.stringify({
    conversation_id: 'conv-2',
    cwd: '/repo/cli',
    created_at: 1782720000000,
    updated_at: 1782720000000,
    value: {
      conversation_id: 'conv-2',
      history: [{
        user: { text: 'abcdefgh' },
        assistant: { text: '' },
        request_metadata: {
          request_start_timestamp_ms: 1782720000000,
          model_id: 'claude-opus-4.5',
          time_between_chunks: [1, 2],
        },
      }],
    },
  }));

  const prevUserPath = process.env.KIRO_USER_PATH;
  const prevSessionsDir = process.env.KIRO_SESSIONS_DIR;
  const prevCliDbPath = process.env.KIRO_CLI_DB_PATH;
  const prevCliSessionsDir = process.env.KIRO_CLI_SESSIONS_DIR;
  process.env.KIRO_USER_PATH = userPath;
  process.env.KIRO_SESSIONS_DIR = sessionsDir;
  process.env.KIRO_CLI_DB_PATH = join(root, 'missing.sqlite3');
  process.env.KIRO_CLI_SESSIONS_DIR = join(root, 'missing-cli-sessions');
  try {
    const result = await parse();
    assert.deepEqual(result.buckets.map(b => ({
      model: b.model,
      project: b.project,
      inputTokens: b.inputTokens,
      cachedInputTokens: b.cachedInputTokens,
      outputTokens: b.outputTokens,
    })), [{
      model: 'claude-opus-4.5',
      project: '/repo/cli',
      inputTokens: 2,
      cachedInputTokens: 0,
      outputTokens: 2,
    }]);
  } finally {
    restoreEnv('KIRO_USER_PATH', prevUserPath);
    restoreEnv('KIRO_SESSIONS_DIR', prevSessionsDir);
    restoreEnv('KIRO_CLI_DB_PATH', prevCliDbPath);
    restoreEnv('KIRO_CLI_SESSIONS_DIR', prevCliSessionsDir);
    rmSync(root, { recursive: true, force: true });
  }
});

test('cliEventsToEntries estimates in/out/think, excludes signatures from output, keeps them in cache, and inherits the prompt timestamp', () => {
  const events = [
    { version: 'v1', kind: 'Prompt', data: {
      content: [{ kind: 'text', data: 'a'.repeat(40) }],   // 40/4 = 10 input
      meta: { timestamp: 1782720000 },                      // epoch SECONDS
    } },
    { version: 'v1', kind: 'AssistantMessage', data: { content: [
      { kind: 'thinking', data: {
        text: 'T'.repeat(20),          // 20/4 = 5 reasoning
        signature: 'S'.repeat(400),    // 400/4 = 100 — excluded from output/reasoning
        modelId: 'claude-opus-4.8',
      } },
      { kind: 'text', data: 'O'.repeat(24) },               // 24/4 = 6 output
      { kind: 'toolUse', data: { toolUseId: 'x'.repeat(30), name: 'read', input: { path: '/p' } } }, // 'read'+'/p' = 6 chars -> 1
    ] } },
    { version: 'v1', kind: 'ToolResults', data: { content: [
      { kind: 'toolResult', data: { toolUseId: 'y'.repeat(30), content: [{ text: 'R'.repeat(40) }] } }, // 40/4 = 10 input
    ] } },
    { version: 'v1', kind: 'AssistantMessage', data: { content: [
      { kind: 'text', data: 'Z'.repeat(16) },               // 16/4 = 4 output, no new Prompt -> same ts
    ] } },
  ];

  const entries = cliEventsToEntries(events, { cwd: '/x', model: null });

  assert.deepEqual(entries.map(e => ({
    model: e.model,
    project: e.project,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    reasoningOutputTokens: e.reasoningOutputTokens,
    cachedInputTokens: e.cachedInputTokens,
    ms: e.timestamp.getTime(),
  })), [
    // turn 1: cache = 0 (nothing prior) + 20000 system overhead
    { model: 'claude-opus-4.8', project: '/x', inputTokens: 10, outputTokens: 7, reasoningOutputTokens: 5, cachedInputTokens: 20000, ms: 1782720000 * 1000 },
    // turn 2: cache = prior context (10+7+5+100 signature = 122) + 20000; ts inherited
    { model: 'claude-opus-4.8', project: '/x', inputTokens: 10, outputTokens: 4, reasoningOutputTokens: 0, cachedInputTokens: 20122, ms: 1782720000 * 1000 },
  ]);
});

test('parse reads native ~/.kiro/sessions/cli/*.jsonl event streams', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-kiro-stream-'));
  const cliDir = join(root, 'cli');
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(join(cliDir, 'sess.json'), JSON.stringify({ cwd: '/repo/x' }));
  writeFileSync(join(cliDir, 'sess.jsonl'), [
    JSON.stringify({ version: 'v1', kind: 'Prompt', data: { content: [{ kind: 'text', data: 'a'.repeat(40) }], meta: { timestamp: 1782720000 } } }),
    JSON.stringify({ version: 'v1', kind: 'AssistantMessage', data: { content: [
      { kind: 'thinking', data: { text: 'T'.repeat(20), signature: 'S'.repeat(400), modelId: 'claude-opus-4.8' } },
      { kind: 'text', data: 'O'.repeat(24) },
    ] } }),
  ].join('\n') + '\n');

  const prevCliSessionsDir = process.env.KIRO_CLI_SESSIONS_DIR;
  process.env.KIRO_CLI_SESSIONS_DIR = cliDir;
  try {
    const result = await parse();
    assert.equal(result.sessions.length, 0);
    assert.deepEqual(result.buckets.map(b => ({
      model: b.model,
      project: b.project,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      reasoningOutputTokens: b.reasoningOutputTokens,
      cachedInputTokens: b.cachedInputTokens,
      totalTokens: b.totalTokens,
    })), [{
      model: 'claude-opus-4.8',
      project: '/repo/x',
      inputTokens: 10,
      outputTokens: 6,
      reasoningOutputTokens: 5,
      cachedInputTokens: 20000,
      totalTokens: 21,   // 10 + 6 + 5
    }]);
  } finally {
    restoreEnv('KIRO_CLI_SESSIONS_DIR', prevCliSessionsDir);
    rmSync(root, { recursive: true, force: true });
  }
});

function snapshot(iso, currentUsage, resetDate) {
  return { timestamp: new Date(iso), currentUsage, resetDate };
}

function logLine(ts, currentUsage, resetDate) {
  return `${ts} [info] ${JSON.stringify({
    commandName: 'GetUsageLimitsCommand',
    output: {
      usageBreakdownList: [{
        resourceType: 'CREDIT',
        unit: 'INVOCATIONS',
        currentUsage,
        nextDateReset: resetDate,
      }],
    },
  })}`;
}

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
