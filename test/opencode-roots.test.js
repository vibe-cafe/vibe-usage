import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { parse } from '../src/parsers/opencode.js';
import { validateExtraRoot } from '../src/extra-roots.js';
import { getOpenCodeStores } from '../src/opencode-roots.js';
const require = createRequire(import.meta.url);
const start = Date.parse('2026-09-12T00:00:00Z');
function rows(session = 'ses_one', model = 'test-model') {
  return [{ id: 'user', sessionID: session, role: 'user', time: { created: start }, path: { root: '/work/project' } },
    { id: 'reply', sessionID: session, role: 'assistant', time: { created: start + 1000 },
      modelID: model, tokens: { input: 10, output: 3, reasoning: 1, cache: { read: 2 } }, path: { root: '/work/project' } }];
}
function sqlite(root, messages) {
  mkdirSync(root, { recursive: true });
  const quote = v => "'" + String(v).replaceAll("'", "''") + "'";
  const sql = 'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);'
    + messages.map(m => `INSERT INTO message VALUES (${quote(m.id)},${quote(m.sessionID)},${quote(JSON.stringify(m))});`).join('');
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* Node 20 uses the CLI. */ }
  const path = join(root, 'opencode.db');
  if (DatabaseSync) { const db = new DatabaseSync(path); try { db.exec(sql); } finally { db.close(); } }
  else execFileSync('sqlite3', [path], { input: sql });
}
function json(root, messages) {
  mkdirSync(join(root, 'storage', 'message'), { recursive: true });
  for (const m of messages) {
    const dir = join(root, 'storage', 'message', m.sessionID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, m.id + '.json'), JSON.stringify(m));
  }
}
async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'opencode-roots-'));
  const old = process.env.VIBE_USAGE_OPENCODE_DIRS;
  process.env.VIBE_USAGE_OPENCODE_DIRS = join(root, 'default');
  try { await run(root, join(root, 'default')); }
  finally {
    if (old === undefined) delete process.env.VIBE_USAGE_OPENCODE_DIRS;
    else process.env.VIBE_USAGE_OPENCODE_DIRS = old;
    rmSync(root, { recursive: true, force: true });
  }
}

test('OpenCode validates SQLite and legacy layouts without throwing on absent paths', async () => fixture(async root => {
  const db = join(root, 'db'), old = join(root, 'json');
  sqlite(db, []); json(old, []);
  assert.equal(validateExtraRoot('opencode', db).ok, true);
  assert.equal(validateExtraRoot('opencode', old).ok, true);
  assert.equal(validateExtraRoot('opencode', join(root, 'absent')).ok, false);
  mkdirSync(join(root, 'wrong', 'opencode.db'), { recursive: true });
  assert.equal(validateExtraRoot('opencode', join(root, 'wrong')).ok, false);
}));

test('OpenCode combines default SQLite and extra SQLite raw rows exactly once', async () => fixture(async (root, primary) => {
  sqlite(primary, rows()); const extra = join(root, 'extra'); sqlite(extra, rows('ses_two'));
  const result = await parse({ extraRoots: [extra] });
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].inputTokens, 20);
  assert.equal(result.buckets[0].cachedInputTokens, 4);
  assert.equal(result.buckets[0].reasoningOutputTokens, 2);
  assert.equal(result.sessions.length, 2);
  assert.deepEqual(await parse({ extraRoots: [extra] }), result);
}));

test('OpenCode merges SQLite and JSON stores and preserves top-level model precedence', async () => fixture(async (root, primary) => {
  json(primary, rows()); const extra = join(root, 'extra');
  const nested = rows('ses_two'); nested[1].model = { modelID: 'nested-model' }; delete nested[1].modelID;
  sqlite(extra, nested);
  const both = rows('ses_three', 'keep-existing'); both[1].model = { modelID: 'do-not-rename' };
  const extraJson = join(root, 'extra-json'); json(extraJson, both);
  const result = await parse({ extraRoots: [extra, extraJson] });
  assert.deepEqual(result.buckets.map(b => b.model).sort(), ['keep-existing', 'nested-model', 'test-model']);
  assert.equal(result.sessions.length, 3);
}));

test('OpenCode deduplicates copied databases, symlinks, and SQLite/JSON copies by message identity', async () => fixture(async (root, primary) => {
  sqlite(primary, rows()); const copy = join(root, 'copy'); cpSync(primary, copy, { recursive: true });
  const alias = join(root, 'alias'); symlinkSync(primary, alias, 'dir');
  const legacy = join(root, 'legacy'); json(legacy, rows());
  const result = await parse({ extraRoots: [primary, copy, alias, legacy] });
  assert.equal(getOpenCodeStores({ extraRoots: [primary, alias] }).length, 1);
  assert.equal(result.buckets[0].inputTokens, 10);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].userMessageCount, 1);
}));

test('OpenCode keeps richer copies and additional messages while preserving independent sessions', async () => fixture(async (root, primary) => {
  sqlite(primary, rows()); const extra = join(root, 'extra'); const messages = rows();
  messages[1].tokens.input = 15;
  messages.push({ ...messages[1], id: 'reply-two', time: { created: start + 2000 } });
  json(extra, messages);
  const result = await parse({ extraRoots: [extra] });
  assert.equal(result.buckets[0].inputTokens, 30);
  assert.equal(result.sessions[0].messageCount, 3);
}));

test('OpenCode SQLite precedence is per root, including an empty migrated database', async () => fixture(async (root, primary) => {
  sqlite(primary, []); json(primary, rows()); const extra = join(root, 'extra'); json(extra, rows('ses_two'));
  const result = await parse({ extraRoots: [extra] });
  assert.equal(result.buckets[0].inputTokens, 10);
  assert.equal(result.sessions.length, 1);
}));

test('OpenCode missing configured roots and corrupt stores suppress partial uploads', async () => fixture(async (root, primary) => {
  sqlite(primary, rows());
  for (const name of ['missing', 'broken-db', 'broken-json']) {
    const dir = join(root, name);
    if (name === 'broken-db') { mkdirSync(dir); writeFileSync(join(dir, 'opencode.db'), 'not sqlite'); }
    if (name === 'broken-json') { json(dir, rows()); writeFileSync(join(dir, 'storage/message/ses_one/reply.json'), '{'); }
    const result = await parse({ extraRoots: [dir] });
    assert.equal(result.skipped, true);
    assert.ok(result.warnings.length);
    assert.deepEqual(result.buckets, []);
  }
}));


test('OpenCode does not rename existing unknown-project buckets from cwd metadata', async () => fixture(async (root, primary) => {
  const messages = rows(); messages[1].path = { cwd: '/work/do-not-rename' };
  sqlite(primary, messages);
  assert.equal((await parse()).buckets[0].project, 'unknown');
}));

test('unreadable OpenCode database protects the source state', { skip: process.getuid?.() === 0 }, async () => fixture(async (root, primary) => {
  sqlite(primary, rows()); const path = join(primary, 'opencode.db');
  chmodSync(path, 0);
  try {
    const result = await parse();
    assert.equal(result.skipped, true);
    assert.ok(result.warnings.length);
    assert.deepEqual(result.buckets, []);
  } finally { chmodSync(path, 0o600); }
}));
