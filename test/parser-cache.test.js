import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  commitFileEntries,
  dirJsonStatToken,
  fileStatToken,
  hashManifest,
  loadFileEntries,
  loadSourceSnapshot,
  magpieManifestToken,
  parserCachePath,
  saveSourceSnapshot,
  sqliteStatToken,
} from '../src/parsers/parser-cache.js';

const require = createRequire(import.meta.url);
const hasNodeSqlite = (() => {
  try { return Boolean(require('node:sqlite')?.DatabaseSync); } catch { return false; }
})();

const ENV_KEYS = ['VIBE_USAGE_CACHE_DIR', 'VIBE_USAGE_PARSER_CACHE', 'VIBE_USAGE_PARSER_CACHE_VERSION', 'VIBE_USAGE_OPENCODE_DIRS'];

function withTempCache(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-usage-parser-cache-test-'));
  const previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.VIBE_USAGE_CACHE_DIR = dir;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('L1 source snapshot round-trips and invalidates on manifest or algo change', { skip: !hasNodeSqlite }, (t) => {
  withTempCache(t);
  const manifestA = hashManifest(['fileA|1:100:1:2']);
  const manifestB = hashManifest(['fileA|2:200:1:2']);
  const payload = { buckets: [{ source: 'dsh', totalTokens: 42 }], sessions: [] };

  assert.equal(loadSourceSnapshot('dsh', 1, manifestA), null);
  assert.equal(saveSourceSnapshot('dsh', 1, manifestA, payload), true);
  assert.deepStrictEqual(loadSourceSnapshot('dsh', 1, manifestA), payload);
  assert.equal(loadSourceSnapshot('dsh', 1, manifestB), null);
  assert.equal(loadSourceSnapshot('dsh', 2, manifestA), null);
});

test('L2 file entries support batch upsert and selective delete', { skip: !hasNodeSqlite }, (t) => {
  withTempCache(t);
  assert.equal(
    commitFileEntries('antigravity', 1, [
      { key: '/a.db', sig: 's1', payload: { project: 'p1' } },
      { key: '/b.db', sig: 's2', payload: { project: 'p2' } },
    ]),
    true,
  );

  let entries = loadFileEntries('antigravity', 1);
  assert.equal(entries.size, 2);
  assert.deepStrictEqual(JSON.parse(entries.get('/a.db').payload), { project: 'p1' });

  assert.equal(
    commitFileEntries(
      'antigravity',
      1,
      [{ key: '/a.db', sig: 's1-updated', payload: { project: 'p1b' } }],
      ['/b.db'],
    ),
    true,
  );
  entries = loadFileEntries('antigravity', 1);
  assert.equal(entries.size, 1);
  assert.equal(entries.get('/a.db').sig, 's1-updated');
  assert.equal(entries.has('/b.db'), false);
});

test('sqliteStatToken: an idle store is cacheable, an open WAL or a journal is not', (t) => {
  const dir = withTempCache(t);
  const dbPath = join(dir, 'sample.db');
  writeFileSync(dbPath, 'main-v1');
  const idle = sqliteStatToken(dbPath);
  assert.ok(idle, 'no -wal: every committed row is in the main file');

  writeFileSync(`${dbPath}-wal`, '');
  const emptyWal = sqliteStatToken(dbPath);
  assert.ok(emptyWal, 'an empty -wal (closed app, truncating checkpoint) is idle too');

  // Frames in the WAL may not be published in the wal-index yet: a read now
  // can return older rows than the files' stat describes.
  writeFileSync(`${dbPath}-wal`, 'frames');
  assert.equal(sqliteStatToken(dbPath), null);

  writeFileSync(`${dbPath}-wal`, '');
  writeFileSync(`${dbPath}-journal`, 'rollback journal');
  assert.equal(sqliteStatToken(dbPath), null, 'a rollback-mode write in progress');
  rmSync(`${dbPath}-journal`);

  writeFileSync(dbPath, 'main-v2 after a checkpoint');
  const checkpointed = sqliteStatToken(dbPath);
  assert.ok(checkpointed);
  assert.notEqual(checkpointed, emptyWal);
});

test('dirJsonStatToken detects in-place edits to cached json files', (t) => {
  const dir = withTempCache(t);
  const f = join(dir, 'entry.json');
  writeFileSync(f, '{"v":1}');
  const t1 = dirJsonStatToken(dir);
  writeFileSync(f, '{"v":12345}');
  const future = new Date(Date.now() + 2000);
  utimesSync(f, future, future);
  const t2 = dirJsonStatToken(dir);
  assert.notEqual(t2, t1);
});

test('magpieManifestToken: no whole-source snapshot where a Magpie ledger exists or was never checked', () => {
  assert.equal(magpieManifestToken(null), 'magpie:none');
  assert.equal(magpieManifestToken({ failed: true, ledgerExists: false }), null);
  // Attributed results depend on the ledger's contents, and a ledger read
  // failure must reach sync.js, which a snapshot hit would skip.
  assert.equal(magpieManifestToken({ startAt: 'none', ledgerExists: true, failed: false }), null);
  assert.equal(magpieManifestToken({ startAt: undefined, ledgerExists: undefined, failed: false }), null);
  const none = magpieManifestToken({ startAt: undefined, ledgerExists: false, failed: false });
  assert.ok(none);
  assert.notEqual(magpieManifestToken({ startAt: 'none', ledgerExists: false, failed: false }), none);
});

test('a cache written by another CLI version is never reused', { skip: !hasNodeSqlite }, (t) => {
  withTempCache(t);
  const manifest = hashManifest(['fileA|1:100:1:2']);
  const payload = { buckets: [{ source: 'dsh', totalTokens: 42 }], sessions: [] };
  process.env.VIBE_USAGE_PARSER_CACHE_VERSION = '1.0.0';
  assert.equal(saveSourceSnapshot('dsh', 1, manifest, payload), true);
  assert.equal(commitFileEntries('dsh', 1, [{ key: '/a', sig: 's1', payload: { project: 'p' } }]), true);
  assert.deepStrictEqual(loadSourceSnapshot('dsh', 1, manifest), payload);
  assert.equal(loadFileEntries('dsh', 1, ['/a']).get('/a')?.sig, 's1');

  process.env.VIBE_USAGE_PARSER_CACHE_VERSION = '1.0.1';
  assert.equal(loadSourceSnapshot('dsh', 1, manifest), null, 'snapshot of 1.0.0 ignored by 1.0.1');
  assert.equal(loadFileEntries('dsh', 1, ['/a']).size, 0, 'file entry of 1.0.0 ignored by 1.0.1');
  assert.equal(loadFileEntries('dsh', 1).size, 0);
  // The new version's writes replace the old rows.
  assert.equal(commitFileEntries('dsh', 1, [{ key: '/a', sig: 's1', payload: { project: 'q' } }]), true);
  assert.equal(JSON.parse(loadFileEntries('dsh', 1, ['/a']).get('/a').payload).project, 'q');
});

test('after an upgrade a parser recomputes instead of returning the older release\'s snapshot', { skip: !hasNodeSqlite }, async (t) => {
  const dir = withTempCache(t);
  const store = join(dir, 'opencode');
  mkdirSync(store);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(join(store, 'opencode.db'));
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)');
  const insert = db.prepare('INSERT INTO message VALUES (?, ?, ?)');
  insert.run('m1', 'ses_1', JSON.stringify({ role: 'user', time: { created: 1790000000000 }, path: { root: '/w/app' } }));
  insert.run('m2', 'ses_1', JSON.stringify({ role: 'assistant', time: { created: 1790000001000 }, modelID: 'test-model',
    tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } }, path: { root: '/w/app' } }));
  db.close();
  process.env.VIBE_USAGE_OPENCODE_DIRS = store;
  const { parse } = await import('../src/parsers/opencode.js');

  process.env.VIBE_USAGE_PARSER_CACHE_VERSION = '1.0.0';
  const fresh = await parse();
  assert.equal(fresh.buckets[0].inputTokens, 7);
  // Stand-in for "release 1.0.0 computed something a later release fixes".
  const cache = new DatabaseSync(parserCachePath());
  cache.prepare("UPDATE source_snapshots SET payload = ? WHERE source = 'opencode'")
    .run(JSON.stringify({ buckets: [{ stale: true }], sessions: [] }));
  cache.close();
  assert.deepStrictEqual((await parse()).buckets, [{ stale: true }], 'same release reuses its snapshot');

  process.env.VIBE_USAGE_PARSER_CACHE_VERSION = '1.0.1';
  assert.deepStrictEqual(await parse(), fresh, 'a new release recomputes from the store');
});

test('the cache database and its -wal / -shm are owner-only', { skip: !hasNodeSqlite || process.platform === 'win32' }, (t) => {
  withTempCache(t);
  assert.equal(saveSourceSnapshot('dsh', 1, hashManifest(['x']), { buckets: [], sessions: [] }), true);
  const path = parserCachePath();
  assert.equal(statSync(path).mode & 0o777, 0o600);
  // Another process (a second collector) holding the database open keeps its
  // -wal and -shm on disk; companions found wider than 0600 are narrowed.
  const { DatabaseSync } = require('node:sqlite');
  const other = new DatabaseSync(path);
  t.after(() => other.close());
  other.exec('PRAGMA wal_autocheckpoint = 0');
  other.prepare('INSERT OR REPLACE INTO source_snapshots VALUES (?, 1, ?, ?, 0)').run('other', 'm', '{}');
  for (const suffix of ['-wal', '-shm']) chmodSync(path + suffix, 0o644);
  assert.equal(saveSourceSnapshot('dsh', 1, hashManifest(['y']), { buckets: [], sessions: [] }), true);
  for (const suffix of ['', '-wal', '-shm']) {
    assert.ok(existsSync(path + suffix), `${suffix || 'db'} exists while another connection is open`);
    assert.equal(statSync(path + suffix).mode & 0o777, 0o600, `${suffix || 'db'} is 0600`);
  }
});

test('VIBE_USAGE_PARSER_CACHE=0 disables reads and writes cleanly', (t) => {
  withTempCache(t);
  const m = hashManifest(['x']);
  process.env.VIBE_USAGE_PARSER_CACHE = '0';
  assert.equal(saveSourceSnapshot('opencode', 1, m, { buckets: [], sessions: [] }), false);
  assert.equal(loadSourceSnapshot('opencode', 1, m), null);
  assert.equal(loadFileEntries('opencode', 1).size, 0);
  assert.equal(fileStatToken(join(tmpdir(), 'non-existent-file-xyz-12345')), null);
});
