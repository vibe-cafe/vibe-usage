import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

// Unified disposable parser index cache backed by Node's built-in node:sqlite.
// All entries are derived data kept separate from ~/.vibe-usage/state.json:
// any miss, corruption, lock failure, or older Node runtime without node:sqlite
// falls back cleanly to raw parsing with identical output.
const SCHEMA_VERSION = 2;

let nodeSqlite; // undefined = not tried, null = unavailable

function getNodeSqlite() {
  if (nodeSqlite !== undefined) return nodeSqlite;
  try {
    const prevEmit = process.emitWarning;
    process.emitWarning = (warning, ...rest) => {
      const opts = rest[0];
      const type = typeof opts === 'object' && opts ? opts.type : opts;
      const name = typeof warning === 'object' && warning ? warning.name : undefined;
      if ((type === 'ExperimentalWarning' || name === 'ExperimentalWarning') && String(warning).includes('SQLite')) {
        return;
      }
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

export function parserCacheEnabled() {
  return process.env.VIBE_USAGE_PARSER_CACHE !== '0';
}

export function parserCachePath() {
  const base = process.env.VIBE_USAGE_CACHE_DIR?.trim()
    || join(homedir(), '.vibe-usage', 'cache');
  return join(base, `parser-index-v${SCHEMA_VERSION}.sqlite`);
}

function ensureSchema(db) {
  db.exec(`
    PRAGMA busy_timeout = 0;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS source_snapshots (
      source TEXT NOT NULL,
      algo_version INTEGER NOT NULL,
      manifest TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (source, algo_version)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS file_entries (
      source TEXT NOT NULL,
      algo_version INTEGER NOT NULL,
      entry_key TEXT NOT NULL,
      sig TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (source, algo_version, entry_key)
    ) WITHOUT ROWID;
  `);
}

function withCacheDb(fn) {
  if (!parserCacheEnabled()) return undefined;
  const mod = getNodeSqlite();
  if (!mod?.DatabaseSync) return undefined;
  const dbPath = parserCachePath();
  let db;
  try {
    mkdirSync(join(dbPath, '..'), { recursive: true, mode: 0o700 });
    db = new mod.DatabaseSync(dbPath);
    ensureSchema(db);
    return fn(db);
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // Best effort cleanup.
    }
  }
}

/** Build a deterministic stat signature token for a regular file. */
export function statToken(stat) {
  return `${stat.size}:${stat.mtimeMs}:${stat.dev}:${stat.ino}`;
}

export function fileStatToken(filePath) {
  try {
    return statToken(statSync(filePath));
  } catch {
    return null;
  }
}

/**
 * Build a compact stat digest of all `.json` entries inside a directory
 * (excluding an optional filename such as `_snapshot.json`). Lets an L1
 * manifest invalidate immediately if an external tool or test edits, corrupts,
 * or downgrades an L2 per-file cache entry in place.
 */
export function dirJsonStatToken(dir, excludeName = null) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return 'missing';
  }
  const jsonNames = names.filter((n) => n.endsWith('.json') && n !== excludeName).sort();
  if (jsonNames.length === 0) return 'empty';
  const h = createHash('sha256');
  for (const name of jsonNames) {
    try {
      const s = statSync(join(dir, name));
      h.update(`${name}|${s.size}:${s.mtimeMs}:${s.ino}\n`);
    } catch {
      h.update(`${name}|err\n`);
    }
  }
  return h.digest('hex').slice(0, 24);
}

/**
 * Build a stat signature for a SQLite database including its -wal companion.
 * Under WAL mode, active writes update the -wal file before checkpointing the
 * main .db file, so including -wal guarantees cache invalidation on every write.
 */
export function sqliteStatToken(dbPath) {
  const main = fileStatToken(dbPath);
  if (!main) return null;
  const wal = fileStatToken(`${dbPath}-wal`) || '0';
  return `${main}|w:${wal}`;
}

/** Include the process-local wall-clock environment in bucket snapshots. */
export function localTimeZoneToken() {
  try {
    return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'default';
  } catch {
    return process.env.TZ || 'default';
  }
}

/**
 * Build a deterministic manifest token for a Magpie context so L1 snapshots
 * remain valid even on machines with an active Magpie ledger, invalidating
 * whenever the ledger file or cut changes. Returns null when Magpie failed.
 */
export function magpieManifestToken(magpie) {
  if (!magpie) return 'magpie:none';
  if (magpie.failed) return null;
  const start = magpie.startAt === undefined ? 'undef' : String(magpie.startAt);
  if (!magpie.ledgerExists) return `magpie:${start}|exists:0`;
  const sig = magpie.ledgerFile ? fileStatToken(magpie.ledgerFile) : null;
  if (!sig) return null;
  return `magpie:${start}|exists:1|${sig}`;
}

/** Hash an ordered array of manifest lines into a compact hex digest. */
export function hashManifest(parts) {
  const h = createHash('sha256');
  for (const part of parts) {
    h.update(String(part));
    h.update('\n');
  }
  return h.digest('hex');
}

/** L1: Load a whole-source pre-aggregated snapshot if the manifest matches. */
export function loadSourceSnapshot(source, algoVersion, manifest) {
  if (!manifest) return null;
  const raw = withCacheDb((db) => {
    return db.prepare('SELECT payload FROM source_snapshots WHERE source = ? AND algo_version = ? AND manifest = ?')
      .get(source, algoVersion, manifest)?.payload;
  });
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** L1: Persist a whole-source pre-aggregated snapshot. */
export function saveSourceSnapshot(source, algoVersion, manifest, payload) {
  if (!manifest) return false;
  let serialized;
  try {
    if (!parserCacheEnabled() || !getNodeSqlite()?.DatabaseSync) return false;
    serialized = JSON.stringify(payload);
  } catch {
    return false;
  }
  return Boolean(withCacheDb((db) => {
    db.prepare(
      `INSERT OR REPLACE INTO source_snapshots (source, algo_version, manifest, payload, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(source, algoVersion, manifest, serialized, Date.now());
    return true;
  }));
}

/** L2: Bind the live paths as one JSON array, independent of SQLite’s variable limit. */
export function loadFileEntries(source, algoVersion, keys = null) {
  const map = new Map();
  if (Array.isArray(keys) && keys.length === 0) return map;
  withCacheDb((db) => {
    const select = 'SELECT entry_key, sig, payload FROM file_entries WHERE source = ? AND algo_version = ?';
    const rows = keys === null
      ? db.prepare(select).all(source, algoVersion)
      : db.prepare(select + ' AND entry_key IN (SELECT value FROM json_each(?))')
        .all(source, algoVersion, JSON.stringify(keys));
    for (const row of rows) map.set(row.entry_key, { sig: row.sig, payload: row.payload });
  });
  return map;
}

/** L2: Atomically upsert updated entries and optionally prune dead keys. */
export function commitFileEntries(source, algoVersion, updates = [], deleteKeys = []) {
  if (updates.length === 0 && deleteKeys.length === 0) return true;
  return Boolean(withCacheDb((db) => {
    const now = Date.now();
    const upsert = db.prepare(
      `INSERT OR REPLACE INTO file_entries (source, algo_version, entry_key, sig, payload, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const del = db.prepare(
      'DELETE FROM file_entries WHERE source = ? AND algo_version = ? AND entry_key = ?',
    );
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const { key, sig, payload } of updates) {
        const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
        upsert.run(source, algoVersion, key, sig, serialized, now);
      }
      for (const key of deleteKeys) {
        del.run(source, algoVersion, key);
      }
      db.exec('COMMIT');
      return true;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failure.
      }
      throw err;
    }
  }));
}

/** Remove entries below directories that were completely enumerated this run. */
export function pruneFileEntries(source, algoVersion, roots = [], liveKeys = []) {
  if (roots.length === 0) return true;
  return Boolean(withCacheDb((db) => {
    const live = new Set(liveKeys);
    const rows = db.prepare(
      'SELECT entry_key FROM file_entries WHERE source = ? AND algo_version = ?',
    ).all(source, algoVersion);
    const stale = rows
      .map(row => row.entry_key)
      .filter(key => roots.some(root => key === root || key.startsWith(`${root}/`) || key.startsWith(`${root}\\`)))
      .filter(key => !live.has(key));
    if (stale.length === 0) return true;
    db.exec('BEGIN IMMEDIATE');
    try {
      const del = db.prepare(
        'DELETE FROM file_entries WHERE source = ? AND algo_version = ? AND entry_key = ?',
      );
      for (const key of stale) del.run(source, algoVersion, key);
      db.exec('COMMIT');
      return true;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }));
}
