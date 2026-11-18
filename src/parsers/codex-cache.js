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
// A version-6 *summary* is still read. It folds Ultrafast usage into the plain
// model -- exactly the merged format every window before the cut keeps -- so
// codex.js uses it wherever it has no window at or after the cut, and re-reads
// the rollout otherwise (`summaryMatchesCut()`). Discarding every version-6
// entry instead is what 0.14.8 did to version 5: on a large history neither a
// desktop app (killed at 120s) nor an older daemon sharing this directory ever
// finished rebuilding, and Codex stopped uploading. For the same reason an
// accepted older entry is never rewritten just to restamp it: a daemon still
// running version-6 code rejects version-7 entries, re-reads those rollouts and
// writes version 6 back, which stays cheap only while version-7 entries are
// limited to the rollouts this version actually had to parse.
//
// A version-6 *tail* is not read: it stored the Ultrafast tier as "no tier", so
// continuing from it would file the rest of the session under the plain model.
const MERGED_ULTRAFAST_SUMMARY_ALGORITHM_VERSIONS = new Set([6]);
// Version 6 (#143) only started keeping raw Magpie attribution data (the
// session's model provider and per-response ids). Where Magpie has never been
// active (no ledger, no cut), attribution is a no-op and a version-5 entry
// yields exactly the same buckets and sessions. Accepting it there avoids
// re-reading every rollout: 0.14.8 discarded all version-5 entries, and on a
// large history the desktop apps killed sync at 120s on every run until the
// rebuild finished. Magpie machines still rebuild so attribution stays exact.
const MAGPIE_FREE_COMPATIBLE_ALGORITHM_VERSIONS = new Set([5]);

function acceptedSummaryAlgorithm(version, magpieFree) {
  return version === CODEX_PARSER_ALGORITHM_VERSION
    || MERGED_ULTRAFAST_SUMMARY_ALGORITHM_VERSIONS.has(version)
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

export function codexCacheDir(codexHome) {
  const base = process.env.VIBE_USAGE_CACHE_DIR?.trim()
    || join(homedir(), '.vibe-usage', 'cache');
  return join(base, 'codex', `root-${hash(codexHome)}`);
}

function entryPath(codexHome, filePath) {
  return join(codexCacheDir(codexHome), `${hash(filePath, 32)}.json`);
}

function tailPath(codexHome, filePath) {
  return join(codexCacheDir(codexHome), `${hash(filePath, 32)}.tail.json`);
}

export function loadCodexFileCache(codexHome, filePath, signature, { magpieFree = false } = {}) {
  if (!codexCacheEnabled()) return null;
  const path = entryPath(codexHome, filePath);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed.schemaVersion !== CODEX_CACHE_SCHEMA_VERSION) return null;
    if (!acceptedSummaryAlgorithm(parsed.algorithmVersion, magpieFree)) return null;
    if (parsed.filePath !== filePath) return null;
    if (signature && !sameSignature(parsed.signature, signature)) return null;
    return parsed;
  } catch {
    // Cache corruption is a performance miss, never a correctness failure.
    return null;
  }
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

export function removeCodexFileCache(codexHome, filePath) {
  if (!codexCacheEnabled()) return;
  rmSync(entryPath(codexHome, filePath), { force: true });
  rmSync(tailPath(codexHome, filePath), { force: true });
}
