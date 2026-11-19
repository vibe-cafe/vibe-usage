// Issue #175: an OpenCode store with ~110k+ message rows made the parser throw
// `RangeError: Maximum call stack size exceeded` -- `rows.push(...rows)` passes
// every database row as a call argument -- and the whole source was skipped.
// 200k rows is past the limit on every runtime CI uses (Node 22 overflows from
// ~110k, the Mac app's Node 24 from ~150k). The stores are generated inside
// SQLite with a recursive CTE so the fixture stays fast.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ROWS = 200_000;
const START = Date.parse('2026-09-12T00:00:00Z');

// Isolate HOME, config/state/cache and the OpenCode root before importing.
const root = mkdtempSync(join(tmpdir(), 'opencode-large-db-'));
const isolated = {
  HOME: join(root, 'home'),
  USERPROFILE: join(root, 'home'),
  XDG_DATA_HOME: join(root, 'xdg'),
  VIBE_USAGE_CONFIG_DIR: join(root, 'vibe'),
  VIBE_USAGE_STATE_DIR: join(root, 'vibe'),
  VIBE_USAGE_CACHE_DIR: join(root, 'cache'),
  VIBE_USAGE_OPENCODE_DIRS: join(root, 'opencode'),
};
const previous = Object.fromEntries(Object.keys(isolated).map(key => [key, process.env[key]]));
Object.assign(process.env, isolated);
const { parse } = await import('../src/parsers/opencode.js');
after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function execSql(path, sql) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* Node 20 uses the CLI. */ }
  if (DatabaseSync) { const db = new DatabaseSync(path); try { db.exec(sql); } finally { db.close(); } }
  else execFileSync('sqlite3', [path], { input: sql });
}

// Rows alternate user / assistant one second apart in one session; every
// assistant row carries input 2, output 1, cache read 3.
const numbers = `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS - 1})`;
const tokens = `json_object('input', 2, 'output', 1, 'reasoning', 0, 'cache', json_object('read', 3, 'write', 0))`;

function writeStore(sql) {
  const dir = process.env.VIBE_USAGE_OPENCODE_DIRS;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execSql(join(dir, 'opencode.db'), sql);
}

function assertWholeStore(result, project) {
  assert.equal(result.skipped, undefined, `source skipped: ${JSON.stringify(result.warnings)}`);
  assert.equal(result.warnings, undefined);
  const sum = key => result.buckets.reduce((n, b) => n + b[key], 0);
  assert.equal(sum('inputTokens'), ROWS / 2 * 2);
  assert.equal(sum('outputTokens'), ROWS / 2);
  assert.equal(sum('cachedInputTokens'), ROWS / 2 * 3);
  assert.ok(result.buckets.every(b => b.project === project && b.model === 'test-model'));
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].messageCount, ROWS);
}

test('OpenCode 2.x store with 200k session_message rows syncs instead of overflowing the stack', async () => {
  writeStore(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, data TEXT);
    INSERT INTO session_v2 VALUES ('ses_big', '/work/big-v2');
    ${numbers}
    INSERT INTO session_message
    SELECT printf('msg_%07d', i), 'ses_big',
      CASE i % 2 WHEN 0 THEN 'user' ELSE 'assistant' END,
      ${START} + i * 1000,
      CASE i % 2 WHEN 0 THEN '{}' ELSE json_object('model', json_object('id', 'test-model'), 'tokens', ${tokens}) END
    FROM n;`);
  assertWholeStore(await parse(), 'big-v2');
});

test('OpenCode legacy store with 200k message rows syncs instead of overflowing the stack', async () => {
  writeStore(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
    ${numbers}
    INSERT INTO message
    SELECT printf('msg_%07d', i), 'ses_big',
      CASE i % 2
        WHEN 0 THEN json_object('role', 'user', 'time', json_object('created', ${START} + i * 1000),
          'path', json_object('root', '/work/big-v1'))
        ELSE json_object('role', 'assistant', 'time', json_object('created', ${START} + i * 1000),
          'modelID', 'test-model', 'tokens', ${tokens}, 'path', json_object('root', '/work/big-v1'))
      END
    FROM n;`);
  assertWholeStore(await parse(), 'big-v1');
});
