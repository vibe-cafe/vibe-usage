import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeAlmaModel, parse, resolveAlmaDbPath } from '../src/parsers/alma.js';
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

async function withAlmaDb(sql, run) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-alma-test-'));
  const dbPath = join(root, 'chat_threads.db');
  await createFixtureDb(dbPath, sql);
  const previous = process.env.VIBE_USAGE_ALMA_DB;
  process.env.VIBE_USAGE_ALMA_DB = dbPath;
  try {
    return await run(dbPath);
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
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cached_input_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    timestamp TEXT NOT NULL,
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
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    body TEXT,
    metadata TEXT
  );
`;

test('Alma is registered as a parser and detected tool', () => {
  assert.equal(typeof parsers.alma, 'function');
  assert.equal(TOOLS.find(tool => tool.id === 'alma')?.name, 'Alma');
});

test('resolveAlmaDbPath follows Electron platform paths and fixture override', () => {
  assert.equal(
    resolveAlmaDbPath({ VIBE_USAGE_ALMA_DB: '/tmp/alma.db' }, 'darwin', '/Users/test'),
    '/tmp/alma.db'
  );
  assert.equal(
    resolveAlmaDbPath({ VIBE_USAGE_ALMA_DB: 'C:\\fixtures\\alma.db' }, 'win32', 'C:\\Users\\test'),
    'C:\\fixtures\\alma.db'
  );
  assert.equal(
    resolveAlmaDbPath({}, 'darwin', '/Users/test'),
    '/Users/test/Library/Application Support/alma/chat_threads.db'
  );
  assert.equal(
    resolveAlmaDbPath({ APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }, 'win32', 'C:\\Users\\test'),
    'C:\\Users\\test\\AppData\\Roaming\\alma\\chat_threads.db'
  );
  assert.equal(
    resolveAlmaDbPath({ XDG_CONFIG_HOME: '/tmp/config' }, 'linux', '/home/test'),
    '/tmp/config/alma/chat_threads.db'
  );
});

test('tool detection honors the Alma database override', async () => {
  await withAlmaDb(schema, async () => {
    assert.equal(detectInstalledTools().some(tool => tool.id === 'alma'), true);
  });
});

test('normalizeAlmaModel strips provider prefixes and handles invalid values', () => {
  assert.equal(normalizeAlmaModel('plugin:openai-codex-auth:openai-codex:gpt-5.4'), 'gpt-5.4');
  assert.equal(normalizeAlmaModel('plugin:openai-codex-auth:openai-codex:gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(normalizeAlmaModel('motw9woq9az6u1r1cw:gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(normalizeAlmaModel('claude-sonnet'), 'claude-sonnet');
  assert.equal(normalizeAlmaModel('  claude-sonnet  '), 'claude-sonnet');
  assert.equal(normalizeAlmaModel(null), 'unknown');
  assert.equal(normalizeAlmaModel('   '), 'unknown');
  assert.equal(normalizeAlmaModel('provider:'), 'unknown');
});

test('Alma merges provider-prefixed forms of the same model into one bucket', async () => {
  await withAlmaDb(`${schema}
    INSERT INTO workspaces (id, path, name) VALUES
      ('ws_shared', '/Users/private/shared-project', 'Shared Project');
    INSERT INTO chat_threads (id, workspace_id) VALUES
      ('thread_1', 'ws_shared');
    INSERT INTO usage_records (
      id, message_id, thread_id, model, provider_id,
      input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
      timestamp, cache_write_input_tokens
    ) VALUES
      ('usage_1', 'message_1', 'thread_1', 'plugin:openai-codex-auth:openai-codex:gpt-5.6-sol', NULL,
       10, 3, 0, 0, '2026-08-06T09:05:00.000Z', 0),
      ('usage_2', 'message_2', 'thread_1', 'motw9woq9az6u1r1cw:gpt-5.6-sol', NULL,
       20, 7, 0, 0, '2026-08-06T09:25:00.000Z', 0);
  `, async () => {
    const result = await parse();
    assert.deepEqual(result.buckets, [
      {
        source: 'alma',
        model: 'gpt-5.6-sol',
        project: 'Shared Project',
        bucketStart: '2026-08-06T09:00:00.000Z',
        inputTokens: 30,
        outputTokens: 10,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 40,
      },
    ]);
  });
});

test('Alma emits usage buckets without chat content or session metadata', async () => {
  await withAlmaDb(`${schema}
    INSERT INTO workspaces (id, path, name) VALUES
      ('ws_named', '/Users/private/secret-repo', 'Public Project'),
      ('ws_path_name', '/Users/private/another-secret', '/Users/private/safe-basename');
    INSERT INTO chat_threads (id, workspace_id) VALUES
      ('thread_1', 'ws_named'),
      ('thread_2', 'ws_path_name');
    INSERT INTO messages (id, body, metadata) VALUES
      ('message_1', 'PRIVATE_ALMA_MESSAGE', 'PRIVATE_ALMA_METADATA');
    INSERT INTO usage_records (
      id, message_id, thread_id, model, provider_id,
      input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
      timestamp, cache_write_input_tokens
    ) VALUES
      ('usage_1', 'message_1', 'thread_1', 'claude-sonnet', 'private-provider',
       100, 30, 400, 10, '2026-08-06T09:05:00.000Z', 20),
      ('usage_2', 'message_2', 'thread_1', 'claude-sonnet', 'private-provider',
       50, 15, 0, 5, '2026-08-06T09:25:00.000Z', 0),
      ('usage_3', 'message_3', 'thread_2', NULL, NULL,
       7, 3, 2, 0, '2026-08-06T09:35:00.000Z', 1),
      ('usage_4', 'message_4', 'thread_2', 'model-x', NULL,
       1, 1, 0, 0, 'not-a-date', 0);
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
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('PRIVATE_ALMA'), false);
    assert.equal(serialized.includes('/Users/private'), false);
    assert.equal(serialized.includes('private-provider'), false);
  });
});

test('Alma returns an empty successful result when its database is missing', async () => {
  const previous = process.env.VIBE_USAGE_ALMA_DB;
  process.env.VIBE_USAGE_ALMA_DB = join(tmpdir(), `missing-alma-${process.pid}.db`);
  try {
    assert.deepEqual(await parse(), { buckets: [], sessions: [] });
  } finally {
    if (previous === undefined) delete process.env.VIBE_USAGE_ALMA_DB;
    else process.env.VIBE_USAGE_ALMA_DB = previous;
  }
});

test('Alma protects prior state when its schema is incompatible', async () => {
  await withAlmaDb('CREATE TABLE unrelated (id TEXT PRIMARY KEY);', async () => {
    const result = await parse();
    assert.deepEqual(result.buckets, []);
    assert.deepEqual(result.sessions, []);
    assert.equal(result.skipped, true);
    assert.match(result.warnings[0], /incompatible database schema/);
  });
});
