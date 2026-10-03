import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateExtraRoot } from '../src/extra-roots.js';

async function parseFixture(t, { values, cacheWrite = true, profile = '' }) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-hermes-test-'));
  const dbDir = profile ? join(root, 'profiles', profile) : root;
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, 'state.db');
  const previous = process.env.HERMES_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const sql = `
    CREATE TABLE sessions (
      id TEXT, model TEXT, started_at REAL, input_tokens INTEGER,
      output_tokens INTEGER, cache_read_tokens INTEGER, reasoning_tokens INTEGER
      ${cacheWrite ? ', cache_write_tokens INTEGER' : ''}
    );
    CREATE TABLE messages (session_id TEXT, role TEXT, timestamp REAL, content TEXT);
    INSERT INTO sessions VALUES ('test-session', 'test-model', 1788764700, ${values.join(',')});
    INSERT INTO messages VALUES ('test-session', 'user', 1788764700, 'unused prompt');
    INSERT INTO messages VALUES ('test-session', 'assistant', 1788764720, 'unused reply');
  `;
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* Node 20 uses sqlite3. */ }
  if (DatabaseSync) {
    const db = new DatabaseSync(dbPath);
    try { db.exec(sql); } finally { db.close(); }
  } else {
    execFileSync('sqlite3', [dbPath, sql]);
  }
  process.env.HERMES_HOME = root;
  const { parse } = await import(`../src/parsers/hermes.js?fixture=${encodeURIComponent(root)}`);
  return parse();
}

test('Hermes preserves provider totals while separating inclusive reasoning and cache writes', async (t) => {
  const result = await parseFixture(t, { values: [48783, 1232, 100, 422, 50] });
  assert.equal(result.buckets.length, 1);
  const bucket = result.buckets[0];
  assert.equal(bucket.inputTokens, 48833);
  assert.equal(bucket.outputTokens, 810);
  assert.equal(bucket.reasoningOutputTokens, 422);
  assert.equal(bucket.cachedInputTokens, 100);
  assert.equal(bucket.totalTokens, 50065);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].messageCount, 2);
});

test('Hermes reads legacy schemas without a cache-write column', async (t) => {
  const result = await parseFixture(t, { cacheWrite: false, values: [100, 20, 40, 5] });
  assert.equal(result.buckets[0].inputTokens, 100);
  assert.equal(result.buckets[0].outputTokens, 15);
  assert.equal(result.buckets[0].reasoningOutputTokens, 5);
  assert.equal(result.buckets[0].totalTokens, 120);
});

test('Hermes includes cache-only usage in named profiles', async (t) => {
  const result = await parseFixture(t, { profile: 'work', values: [0, 0, 100, 0, 20] });
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].project, 'work');
  assert.equal(result.buckets[0].cachedInputTokens, 100);
  assert.equal(result.buckets[0].inputTokens, 20);
  assert.equal(result.buckets[0].totalTokens, 20);
});

test('Hermes bounds inconsistent reasoning counters by total output', async (t) => {
  const result = await parseFixture(t, { values: [100, 20, 0, 99, 0] });
  assert.equal(result.buckets[0].outputTokens, 0);
  assert.equal(result.buckets[0].reasoningOutputTokens, 20);
  assert.equal(result.buckets[0].totalTokens, 120);
});

test('validateExtraRoot accepts a Hermes home with state.db or only a profile database', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-hermes-validate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const withDefault = join(root, 'with-default');
  mkdirSync(withDefault);
  writeFileSync(join(withDefault, 'state.db'), '');
  const profilesOnly = join(root, 'profiles-only', 'profiles', 'work');
  mkdirSync(profilesOnly, { recursive: true });
  writeFileSync(join(profilesOnly, 'state.db'), '');
  const empty = join(root, 'empty');
  mkdirSync(empty);
  const missing = join(root, 'missing');

  const okDefault = validateExtraRoot('hermes', withDefault);
  assert.equal(okDefault.ok, true);
  assert.equal(okDefault.path, withDefault);
  const okProfile = validateExtraRoot('hermes', join(root, 'profiles-only'));
  assert.equal(okProfile.ok, true);
  assert.equal(validateExtraRoot('hermes', empty).ok, false);
  assert.match(validateExtraRoot('hermes', empty).reason, /state\.db/);
  assert.equal(validateExtraRoot('hermes', missing).ok, false);
  assert.match(validateExtraRoot('hermes', missing).reason, /profiles\/\*\/state\.db/);
});

test('validateExtraRoot rejects an unreadable Hermes home', {
  skip: process.platform === 'win32' ? 'POSIX chmod fixture: Windows requires a separate ACL denial test'
    : process.getuid?.() === 0 && 'POSIX root bypasses chmod denial; run as an unprivileged user',
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-hermes-validate-locked-'));
  t.after(() => {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  });
  chmodSync(root, 0);
  const result = validateExtraRoot('hermes', root);
  assert.equal(result.ok, false);
  assert.match(result.reason, /无法读取 Hermes 目录|state\.db/);
});

test('Hermes parses a configured extra home alongside HERMES_HOME without double-counting that home', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-hermes-extra-parse-'));
  const previous = process.env.HERMES_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  async function writeDb(dir, sessionId) {
    mkdirSync(dir, { recursive: true });
    const sql = `
      CREATE TABLE sessions (
        id TEXT, model TEXT, started_at REAL, input_tokens INTEGER,
        output_tokens INTEGER, cache_read_tokens INTEGER, reasoning_tokens INTEGER,
        cache_write_tokens INTEGER
      );
      CREATE TABLE messages (session_id TEXT, role TEXT, timestamp REAL, content TEXT);
      INSERT INTO sessions VALUES ('${sessionId}', 'test-model', 1788764700, 100, 20, 0, 5, 0);
      INSERT INTO messages VALUES ('${sessionId}', 'user', 1788764700, 'unused prompt');
      INSERT INTO messages VALUES ('${sessionId}', 'assistant', 1788764720, 'unused reply');
    `;
    let DatabaseSync;
    try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* Node 20 uses sqlite3. */ }
    if (DatabaseSync) {
      const db = new DatabaseSync(join(dir, 'state.db'));
      try { db.exec(sql); } finally { db.close(); }
    } else {
      execFileSync('sqlite3', [join(dir, 'state.db'), sql]);
    }
  }
  const home = join(root, 'default-home');
  const extra = join(root, 'extra-home');
  await writeDb(home, 'from-default');
  await writeDb(join(extra, 'profiles', 'side'), 'from-extra');
  process.env.HERMES_HOME = home;
  const { parse } = await import(`../src/parsers/hermes.js?extra=${encodeURIComponent(root)}`);
  const both = await parse({ extraRoots: [extra] });
  assert.equal(both.skipped, undefined);
  assert.equal(both.buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0), 240);
  assert.deepEqual(both.buckets.map(bucket => bucket.project).sort(), ['default', 'side']);

  const deduped = await parse({ extraRoots: [home, extra] });
  assert.equal(deduped.skipped, undefined);
  assert.equal(deduped.buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0), 240);
  assert.equal(deduped.sessions.length, 2);

  const envOnly = await parse();
  assert.equal(envOnly.buckets.length, 1);
  assert.equal(envOnly.buckets[0].project, 'default');
  assert.equal(envOnly.buckets[0].totalTokens, 120);
});
