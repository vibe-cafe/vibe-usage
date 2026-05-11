import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

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
export function queryDbJson(dbPath, sql, { timeout = 30000, maxBuffer = 100 * 1024 * 1024 } = {}) {
  const db = openNodeSqlite(dbPath);
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

function openNodeSqlite(dbPath) {
  const mod = getNodeSqlite();
  if (!mod || !mod.DatabaseSync) return null;
  try {
    return new mod.DatabaseSync(dbPath, { readOnly: true });
  } catch {
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
