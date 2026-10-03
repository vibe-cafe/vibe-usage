import { accessSync, constants, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

// Match the Hermes CLI/Desktop layout. Windows installers use LOCALAPPDATA;
// Desktop falls back to an existing ~/.hermes only before that native root exists.
export function getHermesHome({ onError = () => {} } = {}) {
  const explicit = process.env.HERMES_HOME?.trim();
  if (explicit) return explicit;

  const legacy = join(homedir(), '.hermes');
  if (process.platform !== 'win32') return legacy;

  const localAppData = process.env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local');
  const native = join(localAppData, 'hermes');
  return !statIfPresent(native, onError)?.isDirectory()
    && statIfPresent(legacy, onError)?.isDirectory() ? legacy : native;
}

function statIfPresent(path, onError) {
  try {
    return statSync(path);
  } catch (err) {
    if (err.code !== 'ENOENT') onError(err);
    return null;
  }
}

function isReadableFile(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// Identity for dedup: symlinks and relative spellings of one database are one store.
export function hermesPathKey(path) {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function collectHermesDatabases(home, onError) {
  const dbs = [];

  const defaultDb = join(home, 'state.db');
  if (statIfPresent(defaultDb, onError)) dbs.push({ path: defaultDb, profile: 'default' });

  const profilesDir = join(home, 'profiles');
  let entries;
  try {
    entries = readdirSync(profilesDir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') onError(err);
    return dbs;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const profileDb = join(profilesDir, entry.name, 'state.db');
    if (statIfPresent(profileDb, onError)?.isFile()) {
      dbs.push({ path: profileDb, profile: entry.name });
    }
  }

  return dbs;
}

// Parsing must fail on unreadable stores: a partial result would allow sync
// to prune that profile's previous state. Detection alone is best-effort.
export function discoverHermesDatabases({ onError = err => { throw err; } } = {}) {
  return collectHermesDatabases(getHermesHome({ onError }), onError);
}

// Scoped to the given home, not getHermesHome(). `ok` requires a readable
// state.db or profiles/<name>/state.db. `error` means the read could not be
// finished (anything other than a missing path); callers must skip the source
// instead of reporting an empty success.
export function inspectHermesHome(home) {
  let error = null;
  const dbs = collectHermesDatabases(home, (err) => {
    error = error || err;
  });
  return {
    dbs,
    error,
    ok: error == null && dbs.some(db => isReadableFile(db.path)),
  };
}

export function findHermesDataDirs(extraHomes = []) {
  const dbs = discoverHermesDatabases({ onError: () => {} });
  const seen = new Set(dbs.map(db => hermesPathKey(db.path)));
  for (const home of extraHomes) {
    if (typeof home !== 'string' || !home.trim()) continue;
    const inspected = inspectHermesHome(home);
    // Detection is best-effort. The parser reports an unreadable extra home
    // as skipped so a failed stat cannot be uploaded as "no data".
    if (!inspected.ok) continue;
    for (const db of inspected.dbs) {
      const key = hermesPathKey(db.path);
      if (seen.has(key)) continue;
      seen.add(key);
      dbs.push(db);
    }
  }
  return dbs.map(db => db.path);
}
