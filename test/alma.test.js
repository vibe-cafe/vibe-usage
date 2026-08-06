import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALMA_USAGE_SQL, parse, resolveAlmaDbPath } from '../src/parsers/alma.js';
import { parsers } from '../src/parsers/index.js';
import { detectInstalledTools, TOOLS } from '../src/tools.js';

async function createFixtureDb(dbPath, sql) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    // Node 20 exercises the sqlite3 CLI fallback used by queryDbJson().
  }
  if (DatabaseSync) {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
    return;
  }
  execFileSync('sqlite3', [dbPath, sql]);
}

async function withAlmaDb(sql, fn) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-alma-test-'));
  const dbPath = join(root, 'chat_threads.db');
  await createFixtureDb(dbPath, sql);
  const previous = process.env.VIBE_USAGE_ALMA_DB;
  process.env.VIBE_USAGE_ALMA_DB = dbPath;
  try {
    return await fn(dbPath);
  } finally {
    if (previous === undefined) delete process.env.VIBE_USAGE_ALMA_DB;
    else process.env.VIBE_USAGE_ALMA_DB = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

const schema = `
  CREATE TABLE usage_records (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    model TEXT,
    provider_id TEXT,
    date TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cached_input_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    timestamp TEXT NOT NULL,
    created_at TEXT NOT NULL,
    cache_write_input_tokens INTEGER DEFAULT 0
  );
  CREATE TABLE chat_threads (
    id TEXT PRIMARY KEY,
    workspace_id TEXT
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    path TEXT,
    name TEXT
  );
`;

test('Alma is registered as a parser and detected tool', () => {
  assert.equal(typeof parsers.alma, 'function');
  assert.equal(TOOLS.find(tool => tool.id === 'alma')?.name, 'Alma');
});

test('resolveAlmaDbPath honors fixture override and target-platform path semantics', () => {
  assert.equal(resolveAlmaDbPath({ VIBE_USAGE_ALMA_DB: '/tmp/alma.db' }, 'darwin', '/Users/test'), '/tmp/alma.db');
  assert.equal(resolveAlmaDbPath({ VIBE_USAGE_ALMA_DB: 'C:\\fixtures\\alma.db' }, 'win32', 'C:\\Users\\test'), 'C:\\fixtures\\alma.db');
  assert.equal(resolveAlmaDbPath({}, 'darwin', '/Users/test'), '/Users/test/Library/Application Support/alma/chat_threads.db');
  assert.equal(resolveAlmaDbPath({ APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }, 'win32', 'C:\\Users\\test'), 'C:\\Users\\test\\AppData\\Roaming\\alma\\chat_threads.db');
  assert.equal(resolveAlmaDbPath({}, 'win32', 'C:\\Users\\test'), 'C:\\Users\\test\\AppData\\Roaming\\alma\\chat_threads.db');
  assert.equal(resolveAlmaDbPath({ XDG_CONFIG_HOME: '/tmp/config' }, 'linux', '/home/test'), '/tmp/config/alma/chat_threads.db');
});

test('Alma usage SQL selects only required non-sensitive fields', () => {
  const selectClause = ALMA_USAGE_SQL.match(/\bSELECT\b([\s\S]*?)\bFROM\b/i)?.[1];
  assert.ok(selectClause, 'expected a SELECT clause');

  const selectedColumns = [...selectClause.matchAll(/\b(?:usage_records|chat_threads|workspaces)\.([a-z_]+)\b/gi)]
    .map(([, column]) => column.toLowerCase());
  assert.deepEqual(selectedColumns.sort(), [
    'cache_write_input_tokens',
    'cached_input_tokens',
    'input_tokens',
    'model',
    'name',
    'output_tokens',
    'reasoning_tokens',
    'timestamp',
  ].sort());

  for (const sensitiveColumn of ['message', 'metadata', 'provider_id', 'path', 'message_id', 'thread_id', 'id', 'workspace_id']) {
    assert.equal(selectedColumns.includes(sensitiveColumn), false, `${sensitiveColumn} must not be selected`);
    assert.doesNotMatch(selectClause, new RegExp(`\\b${sensitiveColumn}\\b`, 'i'));
  }
});

test('tool detection honors the Alma fixture database override', async () => {
  await withAlmaDb(schema, async () => {
    assert.equal(detectInstalledTools().some(tool => tool.id === 'alma'), true);
  });
});

test('parse reads Alma usage into 30-minute buckets without sessions', async () => {
  await withAlmaDb(`${schema}
    INSERT INTO workspaces (id, path, name) VALUES
      ('ws_named', '/Users/private/secret-repo', 'Public Project'),
      ('ws_path_name', '/Users/private/another-secret', '/Users/private/safe-basename');
    INSERT INTO chat_threads (id, workspace_id) VALUES
      ('thread_1', 'ws_named'),
      ('thread_2', 'ws_path_name'),
      ('thread_3', NULL);
    INSERT INTO usage_records (
      id, message_id, thread_id, model, provider_id, date,
      input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
      total_tokens, timestamp, created_at, cache_write_input_tokens
    ) VALUES
      ('usage_1', 'message_1', 'thread_1', 'claude-sonnet', 'private-provider', '2026-08-06',
       100, 30, 400, 10, 540, '2026-08-06T09:05:00.000Z', '2026-08-06T09:05:01.000Z', 20),
      ('usage_2', 'message_2', 'thread_1', 'claude-sonnet', 'private-provider', '2026-08-06',
       50, 15, 0, 5, 70, '2026-08-06T09:25:00.000Z', '2026-08-06T09:25:01.000Z', 0),
      ('usage_3', 'message_3', 'thread_2', NULL, NULL, '2026-08-06',
       7, 3, 2, 0, 12, '2026-08-06T09:35:00.000Z', '2026-08-06T09:35:01.000Z', 1),
      ('usage_4', 'message_4', 'thread_3', 'model-x', NULL, '2026-08-06',
       0, 0, 0, 0, 0, 'not-a-date', '2026-08-06T09:40:01.000Z', 0);
  `, async () => {
    const result = await parse();
    assert.deepEqual(result.buckets, [
      {
        source: 'alma',
        model: 'claude-sonnet',
        project: 'Public Project',
        bucketStart: '2026-08-06T09:00:00.000Z',
        inputTokens: 170,
        outputTokens: 45,
        cachedInputTokens: 400,
        reasoningOutputTokens: 15,
        totalTokens: 230,
      },
      {
        source: 'alma',
        model: 'unknown',
        project: 'safe-basename',
        bucketStart: '2026-08-06T09:30:00.000Z',
        inputTokens: 8,
        outputTokens: 3,
        cachedInputTokens: 2,
        reasoningOutputTokens: 0,
        totalTokens: 11,
      },
    ]);
    assert.deepEqual(result.sessions, []);
  });
});

test('parse returns an empty successful result when the Alma database is missing', async () => {
  const previous = process.env.VIBE_USAGE_ALMA_DB;
  process.env.VIBE_USAGE_ALMA_DB = join(tmpdir(), `missing-alma-${process.pid}.db`);
  try {
    assert.deepEqual(await parse(), { buckets: [], sessions: [] });
  } finally {
    if (previous === undefined) delete process.env.VIBE_USAGE_ALMA_DB;
    else process.env.VIBE_USAGE_ALMA_DB = previous;
  }
});

test('parse skips with a warning when the Alma schema is incompatible', async () => {
  await withAlmaDb('CREATE TABLE unrelated (id TEXT PRIMARY KEY);', async () => {
    const result = await parse();
    assert.deepEqual(result.buckets, []);
    assert.deepEqual(result.sessions, []);
    assert.equal(result.skipped, true);
    assert.match(result.warnings[0], /^alma: cannot read usage database \(.+\)$/);
  });
});
