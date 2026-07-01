import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse, snapshotsToCreditEntries } from '../src/parsers/kiro.js';

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
  const logDir = join(root, 'Kiro', 'logs', '20260629T120000', 'window1', 'exthost', 'kiro.kiroAgent');
  mkdirSync(userPath, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, 'q-client.log'), [
    logLine('2026-06-29 12:00:00.000', 100, '2026-07-01T00:00:00.000Z'),
    logLine('2026-06-29 12:10:00.000', 125.5, '2026-07-01T00:00:00.000Z'),
    logLine('2026-06-29 12:40:00.000', 130, '2026-07-01T00:00:00.000Z'),
  ].join('\n') + '\n');

  const prevUserPath = process.env.KIRO_USER_PATH;
  const prevLegacy = process.env.VIBE_USAGE_KIRO_LEGACY_TOKENS;
  process.env.KIRO_USER_PATH = userPath;
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
    restoreEnv('VIBE_USAGE_KIRO_LEGACY_TOKENS', prevLegacy);
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
