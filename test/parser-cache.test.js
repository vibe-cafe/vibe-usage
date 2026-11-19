import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
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
  saveSourceSnapshot,
  sqliteStatToken,
} from '../src/parsers/parser-cache.js';

const require = createRequire(import.meta.url);
const hasNodeSqlite = (() => {
  try { return Boolean(require('node:sqlite')?.DatabaseSync); } catch { return false; }
})();

function withTempCache(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-usage-parser-cache-test-'));
  const prevCache = process.env.VIBE_USAGE_CACHE_DIR;
  const prevFlag = process.env.VIBE_USAGE_PARSER_CACHE;
  process.env.VIBE_USAGE_CACHE_DIR = dir;
  delete process.env.VIBE_USAGE_PARSER_CACHE;
  t.after(() => {
    if (prevCache === undefined) delete process.env.VIBE_USAGE_CACHE_DIR;
    else process.env.VIBE_USAGE_CACHE_DIR = prevCache;
    if (prevFlag === undefined) delete process.env.VIBE_USAGE_PARSER_CACHE;
    else process.env.VIBE_USAGE_PARSER_CACHE = prevFlag;
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

test('sqliteStatToken detects changes in both main .db and -wal companion', (t) => {
  const dir = withTempCache(t);
  const dbPath = join(dir, 'sample.db');
  const walPath = `${dbPath}-wal`;
  writeFileSync(dbPath, 'main-v1');
  const tok1 = sqliteStatToken(dbPath);
  assert.ok(tok1);

  writeFileSync(walPath, 'wal-append-1');
  const tok2 = sqliteStatToken(dbPath);
  assert.notEqual(tok2, tok1);

  writeFileSync(walPath, 'wal-append-1-and-more');
  const tok3 = sqliteStatToken(dbPath);
  assert.notEqual(tok3, tok2);
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

test('VIBE_USAGE_PARSER_CACHE=0 disables reads and writes cleanly', (t) => {
  withTempCache(t);
  const m = hashManifest(['x']);
  process.env.VIBE_USAGE_PARSER_CACHE = '0';
  assert.equal(saveSourceSnapshot('opencode', 1, m, { buckets: [], sessions: [] }), false);
  assert.equal(loadSourceSnapshot('opencode', 1, m), null);
  assert.equal(loadFileEntries('opencode', 1).size, 0);
  assert.equal(fileStatToken(join(tmpdir(), 'non-existent-file-xyz-12345')), null);
});
