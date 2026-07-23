import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from '../src/parsers/dimagent.js';

test('parse reads DimAgent SQLite usage and excludes forked copies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-dimagent-test-'));
  const dbPath = join(root, 'dimcode.sqlite');
  const previousDbPath = process.env.VIBE_USAGE_DIMAGENT_DB;

  execFileSync('sqlite3', [dbPath, `
    CREATE TABLE sessions (
      sessionId TEXT PRIMARY KEY,
      cwd TEXT NOT NULL
    );
    CREATE TABLE usage_ledger (
      ledgerId TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      runId TEXT,
      providerId TEXT NOT NULL,
      modelId TEXT NOT NULL,
      usage TEXT NOT NULL,
      cost REAL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE messages (
      messageId TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      role TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );

    INSERT INTO sessions VALUES
      ('main', '/work/example-app'),
      ('fork', '/work/example-app'),
      ('fork-2', '/work/example-app');

    INSERT INTO usage_ledger VALUES
      ('usage_run-1', 'main', 'run-1', 'dim', 'gpt-main',
       '{"promptTokens":100,"completionTokens":20,"totalTokens":120,"cacheReadTokens":40}',
       NULL, '2026-07-01T00:10:00.000Z'),
      ('ledger_11111111-1111-4111-8111-111111111111', 'fork', 'run-1', 'dim', 'gpt-main',
       '{"promptTokens":100,"completionTokens":20,"totalTokens":120,"cacheReadTokens":40}',
       NULL, '2026-07-01T00:10:00.000Z'),
      ('plugin_ledger_original', 'main', NULL, 'dim', 'plugin-model',
       '{"promptTokens":30,"completionTokens":5,"totalTokens":35}',
       NULL, '2026-07-01T00:20:00.000Z'),
      ('ledger_22222222-2222-4222-8222-222222222222', 'fork', NULL, 'dim', 'plugin-model',
       '{"promptTokens":30,"completionTokens":5,"totalTokens":35}',
       NULL, '2026-07-01T00:20:00.000Z'),
      ('ledger_33333333-3333-4333-8333-333333333333', 'fork', NULL, 'dim', 'orphan-model',
       '{"promptTokens":50,"completionTokens":10,"totalTokens":60,"cacheReadTokens":20}',
       NULL, '2026-07-01T00:25:00.000Z'),
      ('ledger_44444444-4444-4444-8444-444444444444', 'fork-2', NULL, 'dim', 'orphan-model',
       '{"promptTokens":50,"completionTokens":10,"totalTokens":60,"cacheReadTokens":20}',
       NULL, '2026-07-01T00:25:00.000Z'),
      ('ledger_1700000000000_1', 'main', NULL, 'dim', 'cache-write-model',
       '{"promptTokens":80,"completionTokens":8,"totalTokens":88,"cacheReadTokens":20,"cacheWriteTokens":30}',
       NULL, '2026-07-01T00:26:00.000Z'),
      ('bad-json', 'main', NULL, 'dim', 'bad-model',
       '{', NULL, '2026-07-01T00:27:00.000Z');

    INSERT INTO messages VALUES
      ('main-user-1', 'main', 'user', '2026-07-01T00:00:00.000Z'),
      ('main-assistant-1', 'main', 'assistant', '2026-07-01T00:00:05.000Z'),
      ('main-assistant-2', 'main', 'assistant', '2026-07-01T00:00:10.000Z'),
      ('main-user-2', 'main', 'user', '2026-07-01T00:05:00.000Z'),
      ('main-assistant-3', 'main', 'assistant', '2026-07-01T00:05:03.000Z'),
      ('msg_fork_1_user', 'fork', 'user', '2026-07-01T00:00:00.000Z'),
      ('msg_fork_1_assistant', 'fork', 'assistant', '2026-07-01T00:00:10.000Z'),
      ('fork-user', 'fork', 'user', '2026-07-01T00:06:00.000Z'),
      ('fork-assistant', 'fork', 'assistant', '2026-07-01T00:06:04.000Z');
  `]);

  process.env.VIBE_USAGE_DIMAGENT_DB = dbPath;
  try {
    const result = await parse();
    const byModel = Object.fromEntries(result.buckets.map(bucket => [bucket.model, bucket]));

    assert.deepEqual(
      {
        inputTokens: byModel['gpt-main'].inputTokens,
        outputTokens: byModel['gpt-main'].outputTokens,
        cachedInputTokens: byModel['gpt-main'].cachedInputTokens,
      },
      { inputTokens: 60, outputTokens: 20, cachedInputTokens: 40 },
    );
    assert.equal(byModel['plugin-model'].inputTokens, 30);
    assert.equal(byModel['orphan-model'].inputTokens, 30);
    assert.equal(byModel['cache-write-model'].inputTokens, 60);
    assert.equal(result.buckets.length, 4);

    assert.equal(result.sessions.length, 2);
    const mainSession = result.sessions.find(session => session.userMessageCount === 2);
    const forkSession = result.sessions.find(session => session.userMessageCount === 1);
    assert.equal(mainSession.project, 'example-app');
    assert.equal(mainSession.messageCount, 5);
    assert.equal(mainSession.activeSeconds, 5);
    assert.equal(forkSession.messageCount, 2);
  } finally {
    if (previousDbPath === undefined) delete process.env.VIBE_USAGE_DIMAGENT_DB;
    else process.env.VIBE_USAGE_DIMAGENT_DB = previousDbPath;
    rmSync(root, { recursive: true, force: true });
  }
});
