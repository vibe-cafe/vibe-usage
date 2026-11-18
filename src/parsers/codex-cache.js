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
// keep them, so upgrading does not re-read a large history. Only for the
// rollout's current stat signature, and only when this version has nothing of
// its own to start from (codex.js `startingCache()`). Two things can be taken
// from such an entry, each with its own rule:
//
// The summary (`result`), and with it the whole entry:
//   - A version-6 summary folds Ultrafast usage into the plain model -- exactly
//     the merged format every window before the cut keeps -- so codex.js uses it
//     wherever it has no window at or after the cut and reads the rollout
//     otherwise (`summaryMatchesCut()`).
//   - A version-5 summary additionally requires that Magpie was never active.
// An older tail is never resumed: it stored the Ultrafast tier as "no tier", so
// continuing from it would file the rest of the session under the plain model.
const MERGED_ULTRAFAST_SUMMARY_ALGORITHM_VERSIONS = new Set([6]);
// Version 6 (#143) only started keeping raw Magpie attribution data (the
// session's model provider and per-response ids). Where Magpie has never been
// active (no ledger, no cut), attribution is a no-op and a version-5 entry
// yields exactly the same buckets and sessions.
const MAGPIE_FREE_COMPATIBLE_ALGORITHM_VERSIONS = new Set([5]);
// The `header` and `index` alone, when the entry has no summary or its summary
// is not exact under the cut. Neither depends on the tier or the cut, so they
// are valid wherever the listed version computes them exactly as this one does.
// This is what keeps an upgrade cheap for a session that exists in several
// homes: its usage is summarized on the group's entry, and the entry of each
// physical file holds only a header and an index. 0.15.0 required a summary
// and read every such file twice from the first byte after the upgrade.
//
// EMPTY THIS SET when the output of `readSessionHeader()` or
// `indexSessionFile()` in codex.js changes -- including through
// `normalizeUsageRecord()`, which decides what a token record's fingerprint is
// made of. Version 5 is not listed for exactly that reason: its headers and
// indexes carry no model provider, and it fingerprinted durable usage records
// without their response id.
const SAME_HEADER_AND_INDEX_ALGORITHM_VERSIONS = new Set([6]);

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
 * This version's own summary for a rollout. With a signature, only the entry
 * for exactly that file state; without one, whatever state was summarized last
 * (the "what did we know before this file grew" lookup that pairs with
 * `loadCodexFileTail()`).
 */
export function loadCodexFileCache(codexHome, filePath, signature) {
  if (!codexCacheEnabled()) return null;
  const own = readSummary(entryPath(codexHome, filePath), filePath,
    version => version === CODEX_PARSER_ALGORITHM_VERSION);
  return own && (!signature || sameSignature(own.signature, signature)) ? own : null;
}

/**
 * What an older version left for exactly this file state, from where that
 * version keeps it, reduced to what its algorithm version allows to be taken:
 *
 *   - `entry`: the whole entry, where that version's summaries are accepted.
 *     The caller still has to check that the summary is exact under the
 *     current Ultrafast cut.
 *   - `header` / `index`: where that version computes them as this one does.
 *
 * A fallback only. The caller must look at its own entries first -- an older
 * collector that is still running refreshes this file after every append, so
 * preferring it would shadow this version's own append tail.
 */
export function loadOlderCodexFileCache(codexHome, filePath, signature, { magpieFree = false } = {}) {
  if (!codexCacheEnabled() || !signature) return null;
  const summaryAccepted = version => acceptedOlderSummaryAlgorithm(version, magpieFree);
  const partsAccepted = version => SAME_HEADER_AND_INDEX_ALGORITHM_VERSIONS.has(version);
  const older = readSummary(olderEntryPath(codexHome, filePath), filePath,
    version => summaryAccepted(version) || partsAccepted(version));
  if (!older || !sameSignature(older.signature, signature)) return null;
  const parts = partsAccepted(older.algorithmVersion);
  return {
    entry: summaryAccepted(older.algorithmVersion) ? older : null,
    header: (parts && older.header) || null,
    index: (parts && older.index) || null,
  };
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
