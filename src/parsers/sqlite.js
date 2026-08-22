import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Run a SQL query against a SQLite database and return rows as plain objects
 * (column name → value), mirroring the shape of `sqlite3 -json` output.
 *
 * Prefers Node's built-in `node:sqlite` (available on Node >= 22.5, no external
 * binary needed — important on Windows where the `sqlite3` CLI is rarely on
 * PATH). Falls back to shelling out to the `sqlite3` CLI on older Node.
 *
 * If neither is available, throws an Error whose message contains "ENOENT" so
 * callers can surface an "Install sqlite3" hint, matching the previous behavior.
 */
export function queryDbJson(
  dbPath,
  sql,
  { timeout = 30000, maxBuffer = 100 * 1024 * 1024, readOnly = true } = {},
) {
  const db = openNodeSqlite(dbPath, readOnly);
  if (db) {
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  }
  return queryViaCli(dbPath, sql, { timeout, maxBuffer });
}

let nodeSqlite; // undefined = not tried, null = unavailable

function getNodeSqlite() {
  if (nodeSqlite !== undefined) return nodeSqlite;
  try {
    // Suppress the one-time "SQLite is an experimental feature" ExperimentalWarning
    // on Node versions where node:sqlite is still flagged experimental.
    const prevEmit = process.emitWarning;
    process.emitWarning = (warning, ...rest) => {
      const opts = rest[0];
      const type = typeof opts === 'object' && opts ? opts.type : opts;
      const name = typeof warning === 'object' && warning ? warning.name : undefined;
      if ((type === 'ExperimentalWarning' || name === 'ExperimentalWarning') && String(warning).includes('SQLite')) return;
      return prevEmit.call(process, warning, ...rest);
    };
    try {
      nodeSqlite = require('node:sqlite');
    } finally {
      process.emitWarning = prevEmit;
    }
  } catch {
    nodeSqlite = null;
  }
  return nodeSqlite;
}

function openNodeSqlite(dbPath, readOnly = true) {
  const mod = getNodeSqlite();
  if (!mod || !mod.DatabaseSync) return null;
  let db;
  try {
    db = new mod.DatabaseSync(dbPath, { readOnly });
    // Writable access is used only for disposable snapshots whose WAL metadata
    // may need initialization. Keep the SQL connection itself read-only.
    if (!readOnly) db.exec('PRAGMA query_only = ON');
    return db;
  } catch {
    try {
      db?.close();
    } catch {
      // Ignore cleanup failure while falling back to the sqlite3 CLI.
    }
    return null;
  }
}

function queryViaCli(dbPath, sql, { timeout, maxBuffer }) {
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], {
    encoding: 'utf-8',
    maxBuffer,
    timeout,
  });
  const trimmed = out.trim();
  if (!trimmed || trimmed === '[]') return [];
  return JSON.parse(trimmed);
}

/** Standard "sqlite3 unavailable" hint, reused by every SQLite-backed parser. */
export function sqliteUnavailableError(label) {
  return new Error(`sqlite3 CLI not found. Install sqlite3 (or use Node >= 22.5) to sync ${label} data.`);
}

/** True when the error is the "no sqlite3" hint (node:sqlite absent + CLI absent). */
export function isSqliteUnavailableError(err) {
  return !!err && (
    err.code === 'ENOENT'
    || err.status === 127
    || /ENOENT|sqlite3.*not found/i.test(err?.message || '')
  );
}

export function isLockError(err) {
  return !!err && typeof err.message === 'string' && /database is locked/i.test(err.message);
}

function querySnapshot(dbPath, sql, { tempPrefix, opts } = {}) {
  const snapshotDir = mkdtempSync(join(tmpdir(), tempPrefix || 'vibe-usage-sqlite-'));
  const queryPath = join(snapshotDir, basename(dbPath));
  try {
    copyFileSync(dbPath, queryPath);
    for (const suffix of ['-shm', '-wal']) {
      const companion = `${dbPath}${suffix}`;
      if (existsSync(companion)) copyFileSync(companion, `${queryPath}${suffix}`);
    }
    return queryDbJson(queryPath, sql, { ...opts, readOnly: false });
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true });
  }
}

/**
 * Query a disposable writable snapshot. Some WAL-mode databases cannot be
 * opened read-only until SQLite has initialized their shared-memory metadata;
 * doing that only in the temp copy keeps the source application database
 * untouched and works without a sqlite3 binary on Node >= 22.5.
 */
export function queryDbJsonSnapshot(dbPath, sql, options = {}) {
  return querySnapshot(dbPath, sql, options);
}

/**
 * Run a query, and if the source app holds a write lock on the database, copy
 * the DB (plus its -wal/-shm companions) to a temp dir and re-query the
 * snapshot. Shared by Cursor / Antigravity / Kiro.
 */
export function queryDbJsonSnapshotOnLock(dbPath, sql, { tempPrefix = 'vibe-usage-sqlite', opts } = {}) {
  try {
    return queryDbJson(dbPath, sql, opts);
  } catch (err) {
    if (!isLockError(err)) throw err;
    return querySnapshot(dbPath, sql, { tempPrefix, opts });
  }
}
