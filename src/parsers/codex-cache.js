import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Parser caches are disposable derived data. Keep their schema/version fully
// separate from ~/.vibe-usage/state.json, whose hashes are the authoritative
// record of successful uploads and must remain backward-compatible.
export const CODEX_CACHE_SCHEMA_VERSION = 1;
export const CODEX_PARSER_ALGORITHM_VERSION = 7;
// Version 7 keeps Codex Ultrafast usage apart from the plain model's buckets
// (`result.ultrafastBuckets`, raw model name) so the per-machine cut can name it
// when results are assembled; a tail also carries the raw `ultrafast` tier.
//
// Version 7 writes into its own directory (`codexCacheDir()`, a `v7` folder
// inside the per-home directory older versions use) and never touches the files
// of an older version. One directory shared by two versions is how 0.14.8
// stopped Codex uploads: a daemon started before an upgrade keeps running the
// old parser for days, and when both wrote `<file>.json` each overwrote the
// other's entry and append tail, so a rollout that was still growing was read
// from the first byte by both, every run. With a few long sessions open neither
// side finished inside its work budget and Codex never uploaded. Now the old
// collector keeps resuming from its own tails, and this version reads a growing
// rollout from the start once and resumes from its own tail afterwards.
//
// Entries of the older versions are still *read*, from where those versions
// keep them, so upgrading does not re-read a large history:
//   - A version-6 summary folds Ultrafast usage into the plain model -- exactly
//     the merged format every window before the cut keeps -- so codex.js uses it
//     wherever it has no window at or after the cut and reads the rollout
//     otherwise (`summaryMatchesCut()`).
//   - A version-5 summary additionally requires that Magpie was never active.
//   - Only for the rollout's current stat signature. An older tail is never
//     resumed: it stored the Ultrafast tier as "no tier", so continuing from it
//     would file the rest of the session under the plain model.
const MERGED_ULTRAFAST_SUMMARY_ALGORITHM_VERSIONS = new Set([6]);
// Version 6 (#143) only started keeping raw Magpie attribution data (the
// session's model provider and per-response ids). Where Magpie has never been
// active (no ledger, no cut), attribution is a no-op and a version-5 entry
// yields exactly the same buckets and sessions.
const MAGPIE_FREE_COMPATIBLE_ALGORITHM_VERSIONS = new Set([5]);

function acceptedOlderSummaryAlgorithm(version, magpieFree) {
  return MERGED_ULTRAFAST_SUMMARY_ALGORITHM_VERSIONS.has(version)
    || (magpieFree === true && MAGPIE_FREE_COMPATIBLE_ALGORITHM_VERSIONS.has(version));
}

function hash(value, length = 24) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

export function codexCacheEnabled() {
  return process.env.VIBE_USAGE_CODEX_CACHE !== '0';
}

export function fileSignature(stat) {
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    dev: String(stat.dev),
    ino: String(stat.ino),
  };
}

function sameSignature(a, b) {
  return a?.size === b.size
    && a?.mtimeMs === b.mtimeMs
    && a?.dev === b.dev
    && a?.ino === b.ino;
}

/** Where versions up to 6 keep their entries. Read-only for this version. */
export function olderCodexCacheDir(codexHome) {
  const base = process.env.VIBE_USAGE_CACHE_DIR?.trim()
    || join(homedir(), '.vibe-usage', 'cache');
  return join(base, 'codex', `root-${hash(codexHome)}`);
}

/** Where this version reads and writes its own entries. */
export function codexCacheDir(codexHome) {
  return join(olderCodexCacheDir(codexHome), `v${CODEX_PARSER_ALGORITHM_VERSION}`);
}

function entryPath(codexHome, filePath) {
  return join(codexCacheDir(codexHome), `${hash(filePath, 32)}.json`);
}

function olderEntryPath(codexHome, filePath) {
  return join(olderCodexCacheDir(codexHome), `${hash(filePath, 32)}.json`);
}

function tailPath(codexHome, filePath) {
  return join(codexCacheDir(codexHome), `${hash(filePath, 32)}.tail.json`);
}

function readSummary(path, filePath, acceptsAlgorithm) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed.schemaVersion !== CODEX_CACHE_SCHEMA_VERSION) return null;
    if (!acceptsAlgorithm(parsed.algorithmVersion)) return null;
    if (parsed.filePath !== filePath) return null;
    return parsed;
  } catch {
    // Cache corruption is a performance miss, never a correctness failure.
    return null;
  }
}

/**
 * The summary for a rollout: this version's own entry, else -- only when the
 * caller asks for an exact stat signature -- an older version's entry for that
 * same signature. Without a signature (the "what did we know before this file
 * grew" lookup that pairs with `loadCodexFileTail()`), only this version's own
 * entry is returned: an older summary must never be continued from.
 */
export function loadCodexFileCache(codexHome, filePath, signature, { magpieFree = false } = {}) {
  if (!codexCacheEnabled()) return null;
  const own = readSummary(entryPath(codexHome, filePath), filePath,
    version => version === CODEX_PARSER_ALGORITHM_VERSION);
  if (!signature) return own;
  if (own && sameSignature(own.signature, signature)) return own;
  const older = readSummary(olderEntryPath(codexHome, filePath), filePath,
    version => acceptedOlderSummaryAlgorithm(version, magpieFree));
  return older && sameSignature(older.signature, signature) ? older : null;
}

export function saveCodexFileCache(codexHome, filePath, signature, data) {
  if (!codexCacheEnabled()) return;
  const dir = codexCacheDir(codexHome);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = entryPath(codexHome, filePath);
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const payload = {
    schemaVersion: CODEX_CACHE_SCHEMA_VERSION,
    algorithmVersion: CODEX_PARSER_ALGORITHM_VERSION,
    filePath,
    signature,
    ...data,
  };
  try {
    writeFileSync(tempPath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, path);
  } finally {
    // A killed writer can leave a unique temp file; a normal failed writer
    // should not. rmSync is safe here because the target is this call's exact,
    // random temporary path inside the versioned cache directory.
    rmSync(tempPath, { force: true });
  }
}

export function loadCodexFileTail(codexHome, filePath) {
  if (!codexCacheEnabled()) return null;
  const path = tailPath(codexHome, filePath);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed.schemaVersion !== CODEX_CACHE_SCHEMA_VERSION) return null;
    if (parsed.algorithmVersion !== CODEX_PARSER_ALGORITHM_VERSION) return null;
    if (parsed.filePath !== filePath || !parsed.signature || !parsed.tail) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCodexFileTail(codexHome, filePath, signature, tail) {
  if (!codexCacheEnabled() || !tail) return;
  const dir = codexCacheDir(codexHome);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = tailPath(codexHome, filePath);
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const payload = {
    schemaVersion: CODEX_CACHE_SCHEMA_VERSION,
    algorithmVersion: CODEX_PARSER_ALGORITHM_VERSION,
    filePath,
    signature,
    tail,
  };
  try {
    writeFileSync(tempPath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

/** Removes this version's entry only; an older collector's files are not ours to delete. */
export function removeCodexFileCache(codexHome, filePath) {
  if (!codexCacheEnabled()) return;
  rmSync(entryPath(codexHome, filePath), { force: true });
  rmSync(tailPath(codexHome, filePath), { force: true });
}
