import { normalizeUsageRecord } from './codex-usage-record.js';
import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  isZstdDecodeError, zstdDecoderAvailable, zstdFileChunks, zstdFileCopyOf, zstdFileHeadChunks,
} from './zstd-file.js';
import { mergeCodexSegments, codexSegmentSignature, planCodexSegments } from './codex-segments.js';
import { aggregateToBuckets } from './aggregate.js';
import { mergeCindyHarnessUsage, readCindyHarnessUsage } from './cindy-ledger.js';
import {
  codexSessionDirs,
  resolveCodexHomes,
  validateExtraCodexHome,
} from '../codex-roots.js';
import { discoverCodexHomes } from '../extra-roots.js';
import {
  CODEX_PARSER_ALGORITHM_VERSION,
  codexCacheEnabled,
  fileSignature,
  loadCodexFileCache,
  loadCodexFileTail,
  loadCodexManifest,
  loadOlderCodexFileCache,
  olderSummaryAccepted,
  sameSignature,
  saveCodexFileCache,
  saveCodexFileTail,
  saveCodexManifest,
} from './codex-cache.js';
import { codexUltrafastModel, codexUltrafastStartMs } from '../codex-ultrafast.js';

// Changing a model id changes its server-side bucket key. Keep pre-release
// history byte-for-byte stable so upgrading cannot re-upload the same tokens
// under tier-decorated keys and double-count them.
const CODEX_SERVICE_TIER_ATTRIBUTION_START_MS = Date.parse('2026-08-31T00:00:00.000Z');

const CODEX_ULTRAFAST_TIER = 'ultrafast';

function normalizeCodexServiceTier(value) {
  if (typeof value !== 'string') return null;
  const tier = value.trim().toLowerCase();
  if (tier === 'fast' || tier === 'priority') return tier;
  if (tier === 'flex' || tier === 'batch') return tier;
  // Recognized, but never appended here: Ultrafast has no fixed start date. It
  // is named from the machine's own cut when results are assembled (see
  // ../codex-ultrafast.js), so the caches below keep it as raw, undecorated
  // usage next to the plain model's buckets.
  if (tier === CODEX_ULTRAFAST_TIER) return tier;
  return null;
}

function decorateCodexModel(model, serviceTier, timestampMs) {
  const rawModel = model || 'unknown';
  if (
    rawModel === 'unknown'
    || !serviceTier
    || timestampMs < CODEX_SERVICE_TIER_ATTRIBUTION_START_MS
  ) {
    return rawModel;
  }
  return `${rawModel}-${serviceTier}`;
}

// Codex stores live sessions in $CODEX_HOME/sessions (default ~/.codex) and,
// once a session is "completed", moves its rollout file verbatim into
// $CODEX_HOME/archived_sessions. A session can be archived between two syncs,
// so scanning only the live dir loses that session's usage forever. We scan
// both, index them together so fork replay-skip works across directories, and
// select the most complete physical file when the same session briefly exists
// in both locations during an archive move.
//
// Codex Desktop also compresses every rollout that has not been modified for
// 7 days to `<name>.jsonl.zst` and deletes the plain file
// (codex-rs/rollout/src/compression.rs, run at startup). Reopening such a
// conversation restores the plain `.jsonl` and deletes the `.zst`. Both moves
// publish the new file before removing the old one, so for a moment both exist
// with the same records (the plain one possibly with more appended). Codex
// itself then reads the plain file and skips the compressed sibling
// (`should_skip_compressed_sibling`); so does this parser.
const COMPRESSED_SUFFIX = '.zst';

function isCompressedRollout(filePath) {
  return filePath.endsWith(`.jsonl${COMPRESSED_SUFFIX}`);
}

/**
 * Recursively find all rollout files under a directory: plain `.jsonl` and,
 * where no plain sibling exists, compressed `.jsonl.zst`.
 * Codex CLI stores sessions as: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 */
function findRolloutFiles(dir, strict = false) {
  const results = [];
  if (!existsSync(dir)) return results;
  try {
    const names = new Set();
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) if (!entry.isDirectory()) names.add(entry.name);
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        for (const nested of findRolloutFiles(fullPath, strict)) results.push(nested);
      } else if (entry.name.endsWith('.jsonl')) {
        results.push(fullPath);
      } else if (isCompressedRollout(entry.name)
          && !names.has(entry.name.slice(0, -COMPRESSED_SUFFIX.length))) {
        results.push(fullPath);
      }
    }
  } catch (err) {
    if (strict && err?.code !== 'ENOENT') throw err;
    // Default roots are best-effort; configured roots must never look empty
    // merely because a directory became unreadable between syncs.
  }
  return results;
}

/**
 * stat() a discovered rollout. When Codex compressed or restored it between
 * the directory listing and now, the other form is the same conversation.
 */
function statRollout(filePath) {
  try {
    return { filePath, stat: statSync(filePath) };
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    const other = isCompressedRollout(filePath)
      ? filePath.slice(0, -COMPRESSED_SUFFIX.length)
      : `${filePath}${COMPRESSED_SUFFIX}`;
    return { filePath: other, stat: statSync(other) };
  }
}

/**
 * Lines of a rollout, bounded to the size captured before parsing. A
 * compressed rollout is decompressed as a stream (never to disk, never whole
 * into memory) and always read from its first byte: compressed offsets do not
 * correspond to text offsets. `decodedBytes()` reports how much text it held.
 *
 * Leaving a `for await` over the lines early does not close the interface:
 * the input keeps flowing to its end in the background (a whole file read,
 * or decompressed, for one header line). A caller that stops early calls
 * `close()`, which also stops the input.
 *
 * `head`: the caller only reads the first records (see zstdFileHeadChunks()).
 */
function readLines(filePath, snapshotSize, start = 0, { head = false } = {}) {
  let input;
  let decoded = null;
  if (isCompressedRollout(filePath)) {
    if (start !== 0) throw new Error('a compressed Codex rollout is only read from its start');
    if (head) {
      input = Readable.from(zstdFileHeadChunks(filePath, snapshotSize), { objectMode: false });
    } else {
      decoded = { bytes: 0 };
      input = Readable.from(zstdFileChunks(filePath, snapshotSize, decoded), { objectMode: false });
    }
  } else {
    input = createReadStream(filePath, {
      encoding: 'utf-8',
      // Rollouts are append-only while Codex is working. Bound both parser
      // passes to the size captured before pass 1 so they see the same prefix
      // even when the live file grows between reads.
      ...(start > 0 ? { start } : {}),
      ...(snapshotSize == null ? {} : { end: snapshotSize - 1 }),
    });
  }
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.once('close', () => {
    // Nobody reads these lines any more: an error the decoder still raises
    // (damage past the header) must not become an uncaught exception.
    input.on('error', () => {});
    input.destroy();
  });
  if (decoded) lines.decodedBytes = () => decoded.bytes;
  return lines;
}

function extractProject(meta) {
  if (meta.git?.repository_url) {
    // e.g. https://github.com/org/repo.git → org/repo
    const match = meta.git.repository_url.match(/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  }
  // Windows reports cwd with backslashes, so splitting on '/' alone yields the
  // whole path as the "project".
  if (meta.cwd) return meta.cwd.split(/[\\/]/).pop() || 'unknown';
  return 'unknown';
}

/**
 * A sub-agent rollout (spawned thread / guardian / collab agent). Depending
 * on the Codex version the marker is `thread_source: "subagent"`, a
 * `source: { subagent: {...} }` object, or just a `parent_thread_id` — check
 * all three so no version's sub-agents slip through as normal sessions.
 */
function isSubagentMeta(meta) {
  if (meta.thread_source === 'subagent') return true;
  const src = meta.source;
  if (src === 'subagent') return true;
  if (src && typeof src === 'object' && 'subagent' in src) return true;
  return meta.parent_thread_id != null;
}

function extractParentThreadId(meta) {
  return meta.parent_thread_id
    || meta.source?.subagent?.thread_spawn?.parent_thread_id
    || null;
}

/**
 * Read only far enough to find the canonical (first) session_meta. This cheap
 * discovery pass lets ordinary sessions skip the old full-file index pass;
 * only forks, sub-agents, and parents referenced by them need replay indexes.
 */
async function readSessionHeader(filePath, snapshotSize) {
  const lines = readLines(filePath, snapshotSize, 0, { head: true });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = normalizeUsageRecord(JSON.parse(line));
        if (obj.type !== 'session_meta' || !obj.payload) continue;
        const meta = obj.payload;
        return {
          sessionId: meta.id || null,
          forkedFromId: meta.forked_from_id || null,
          parentThreadId: extractParentThreadId(meta),
          sessionProject: extractProject(meta),
          modelProvider: meta.model_provider,
          sessionStartedAtMs: timestampMs(meta.timestamp) ?? timestampMs(obj.timestamp),
          isSubagent: isSubagentMeta(meta),
        };
      } catch {
        continue;
      }
    }
  } finally {
    lines.close();
  }
  return {
    sessionId: null,
    forkedFromId: null,
    parentThreadId: null,
    sessionProject: 'unknown',
    sessionStartedAtMs: null,
    isSubagent: false,
  };
}

function cacheData(cache, changes = {}) {
  // A compressed rollout's proven plain twin (see indexFromCompressedCopy()).
  const copyOf = changes.copyOf ?? cache?.copyOf ?? null;
  return {
    header: changes.header ?? cache?.header ?? null,
    index: changes.index ?? cache?.index ?? null,
    result: changes.result ?? cache?.result ?? null,
    lastAuditedAt: changes.lastAuditedAt ?? cache?.lastAuditedAt ?? null,
    ...(copyOf ? { copyOf } : {}),
  };
}

const TAIL_GUARD_BYTES = 4096;

function snapshotGuard(filePath, size) {
  if (size <= 0) return { hash: null, endsWithNewline: false };
  const length = Math.min(size, TAIL_GUARD_BYTES);
  const buffer = Buffer.allocUnsafe(length);
  const fd = openSync(filePath, 'r');
  try {
    const read = readSync(fd, buffer, 0, length, size - length);
    const slice = buffer.subarray(0, read);
    return {
      hash: createHash('sha256').update(slice).digest('base64url').slice(0, 20),
      endsWithNewline: slice.at(-1) === 0x0a,
    };
  } finally {
    closeSync(fd);
  }
}

function tailStateFor(file) {
  // Compressed rollouts are summarized only as whole files (see readLines()).
  if (file.compressed) return null;
  const prior = file.priorTail;
  const tail = prior?.tail;
  if (!tail || !prior.signature) return null;
  if (prior.signature.size <= 0 || prior.signature.size >= file.signature.size) return null;
  if (prior.signature.dev !== file.signature.dev || prior.signature.ino !== file.signature.ino) return null;
  if (prior.signature.mtimeMs > file.signature.mtimeMs) return null;
  if (tail.parsedBytes !== prior.signature.size || !tail.endsWithNewline || !tail.guardHash) return null;
  try {
    const guard = snapshotGuard(file.filePath, prior.signature.size);
    return guard.hash === tail.guardHash ? tail : null;
  } catch {
    return null;
  }
}

function timestampMs(value) {
  if (value == null || value === '') return null;
  const n = new Date(value).getTime();
  return Number.isFinite(n) ? n : null;
}

function epochMs(value) {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value);
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value < 1e12 ? value * 1000 : value;
}

function isTaskStarted(payload) {
  return payload?.type === 'task_started' || payload?.type === 'turn_started';
}

function upperBound(sorted, target) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = lo + ((hi - lo) >> 1);
    if (sorted[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function tokenFingerprint(payload) {
  // Copied rollout items are re-serialized with a fresh outer timestamp, but
  // their token_count payload is unchanged. A compact payload hash therefore
  // identifies replayed records without retaining raw usage objects in memory.
  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('base64url')
    .slice(0, 16);
}

/**
 * Return the longest prefix of `child` that is also a suffix of `parent`.
 * Codex can fork full history or the last N turns, but the copied block always
 * reaches the source snapshot's end. Requiring the suffix prevents a child's
 * coincidentally repeated payload from matching an unrelated interior turn.
 * KMP keeps this linear even when many token payloads are identical.
 */
function longestReplayPrefix(child, parent) {
  // The parent first: without one, a child known only by its slim index
  // (see fillFullIndex()) has no per-record arrays to look at.
  if (parent.length === 0 || child.length === 0) return 0;

  const prefix = new Array(child.length).fill(0);
  for (let i = 1, matched = 0; i < child.length; i++) {
    while (matched > 0 && child[i] !== child[matched]) matched = prefix[matched - 1];
    if (child[i] === child[matched]) matched++;
    prefix[i] = matched;
  }

  let matched = 0;
  for (let i = 0; i < parent.length; i++) {
    const fingerprint = parent[i];
    while (matched > 0 && fingerprint !== child[matched]) matched = prefix[matched - 1];
    if (fingerprint === child[matched]) matched++;
    if (matched === child.length && i < parent.length - 1) matched = prefix[matched - 1];
  }
  return matched;
}

/**
 * Return the longest prefix of `child` found contiguously anywhere in
 * `parent`. A live sub-agent rollout can be observed while Codex is still
 * copying the parent block, before that copy reaches the parent snapshot's
 * end. In that state the exact records are inherited history even though the
 * stricter completed-replay suffix match above deliberately rejects them.
 */
function longestPartialReplayPrefix(child, parent) {
  if (parent.length === 0 || child.length === 0) return 0;

  const prefix = new Array(child.length).fill(0);
  for (let i = 1, matched = 0; i < child.length; i++) {
    while (matched > 0 && child[i] !== child[matched]) matched = prefix[matched - 1];
    if (child[i] === child[matched]) matched++;
    prefix[i] = matched;
  }

  let matched = 0;
  let longest = 0;
  for (const fingerprint of parent) {
    while (matched > 0 && fingerprint !== child[matched]) matched = prefix[matched - 1];
    if (fingerprint === child[matched]) matched++;
    longest = Math.max(longest, matched);
    if (matched === child.length) matched = prefix[matched - 1];
  }
  return longest;
}

// `task_started.started_at` is stored at one-second precision while the
// canonical session timestamp has milliseconds. Real Codex Desktop rollouts
// start the child task within a few seconds of creating the child session.
const OWN_TASK_START_WINDOW_MS = 5_000;

/**
 * Stream a rollout once and build a compact replay index. A fork/sub-agent
 * file starts with its own session_meta and can then contain the source
 * session's complete metadata and history. Only the first session_meta is
 * canonical; later ones are replayed records and must never overwrite it.
 *
 * tokenTimes preserves raw token_count ordinals (including malformed usage
 * records) on a monotonic timeline. tokenFingerprints identifies an exact
 * copied sequence even when Codex forks only the last N turns instead of a
 * full prefix. Together they bound matching to source records that existed at
 * spawn without over-skipping child work when the parent later grows.
 */
async function indexSessionFile(filePath, snapshotSize, lines = null) {
  let sessionId = null;
  let forkedFromId = null;
  let parentThreadId = null;
  let sessionProject = 'unknown';
  let modelProvider;
  let sessionStartedAtMs = null;
  let isSubagent = false;
  let sessionMetaCount = 0;
  let parsedRecordCount = 0;
  let rawTokenCount = 0;
  let logicalTimestamp = Number.NEGATIVE_INFINITY;
  const tokenTimes = [];
  const tokenFingerprints = [];
  let pendingTokenTimeIndexes = [];
  const taskBoundaries = [];
  let firstTaskBoundary = null;
  let ownTaskBoundary = null;

  for await (const line of (lines ?? readLines(filePath, snapshotSize))) {
    if (!line.trim()) continue;
    try {
      const obj = normalizeUsageRecord(JSON.parse(line));
      parsedRecordCount++;

      const recordTimestamp = timestampMs(obj.timestamp);
      if (recordTimestamp != null) {
        logicalTimestamp = Math.max(logicalTimestamp, recordTimestamp);
        // An invalid token_count timestamp is placed at the next valid record
        // time. If there is no next valid record it remains +Infinity, which
        // deliberately biases a parent-at-spawn boundary toward under-skip.
        for (const idx of pendingTokenTimeIndexes) tokenTimes[idx] = logicalTimestamp;
        pendingTokenTimeIndexes = [];
      }

      if (obj.type === 'session_meta' && obj.payload) {
        sessionMetaCount++;
        if (sessionMetaCount === 1) {
          const meta = obj.payload;
          sessionId = meta.id || null;
          forkedFromId = meta.forked_from_id || null;
          parentThreadId = extractParentThreadId(meta);
          isSubagent = isSubagentMeta(meta);
          sessionProject = extractProject(meta);
          modelProvider = meta.model_provider;
          sessionStartedAtMs = timestampMs(meta.timestamp) ?? recordTimestamp;
        }
      } else if (obj.type === 'event_msg' && obj.payload?.type === 'token_count') {
        rawTokenCount++;
        tokenFingerprints.push(lines ? obj._tokenFingerprint : tokenFingerprint(obj.payload));
        if (recordTimestamp == null) {
          tokenTimes.push(Number.POSITIVE_INFINITY);
          pendingTokenTimeIndexes.push(tokenTimes.length - 1);
        } else {
          tokenTimes.push(logicalTimestamp);
        }
      } else if (obj.type === 'event_msg' && isTaskStarted(obj.payload)) {
        const boundary = {
          recordIndex: parsedRecordCount,
          rawTokenCount,
          startedAtMs: epochMs(obj.payload.started_at),
        };
        taskBoundaries.push(boundary);
        firstTaskBoundary ??= boundary;

        const startedAtMs = boundary.startedAtMs;
        if (sessionStartedAtMs != null && startedAtMs != null
            && Math.abs(startedAtMs - sessionStartedAtMs) <= OWN_TASK_START_WINDOW_MS) {
          // Keep the last match so a copied parent task that happened to start
          // in the same second cannot win over the child's later own boundary.
          ownTaskBoundary = boundary;
        }
      }
    } catch {
      continue;
    }
  }

  return {
    filePath,
    sessionId,
    forkedFromId,
    parentThreadId,
    sessionProject,
    modelProvider,
    sessionStartedAtMs,
    isSubagent,
    sessionMetaCount,
    parsedRecordCount,
    rawTokenCount,
    tokenTimes,
    tokenFingerprints,
    taskBoundaries,
    firstTaskBoundary,
    ownTaskBoundary,
  };
}

function replayBoundary(meta, sessionById) {
  const parentId = meta.forkedFromId || (meta.isSubagent ? meta.parentThreadId : null);
  const parent = parentId ? sessionById.get(parentId) : null;
  const parentAtSpawn = parent && meta.sessionStartedAtMs != null
    ? upperBound(parent.tokenTimes, meta.sessionStartedAtMs)
    : null;
  const parentSnapshot = parentAtSpawn == null
    ? []
    : parent.tokenFingerprints.slice(0, parentAtSpawn);
  const replayTokenCount = longestReplayPrefix(meta.tokenFingerprints, parentSnapshot);
  const partialReplayTokenCount = meta.isSubagent
    ? longestPartialReplayPrefix(meta.tokenFingerprints, parentSnapshot)
    : 0;

  if (meta.isSubagent) {
    // Direct evidence inside the child wins. Legacy single-meta rollouts did
    // not replay task_started records, so their first task remains a safe
    // fallback. Double-meta files must not use their copied parent's first
    // task_started as the boundary.
    // Exact token matching also handles LastNTurns forks. When it identifies
    // the copied token suffix, the last task_started at that same raw ordinal
    // is the child's own task boundary (copied history is written first).
    const matchedTaskBoundaries = replayTokenCount > 0
      ? meta.taskBoundaries.filter(boundary => (
        boundary.rawTokenCount === replayTokenCount
        && boundary.startedAtMs != null
        && meta.sessionStartedAtMs != null
        && boundary.startedAtMs >= Math.floor(meta.sessionStartedAtMs / 1000) * 1000
      ))
      : [];
    const matchedTaskBoundary = matchedTaskBoundaries.at(-1) || null;
    const direct = matchedTaskBoundary
      || meta.ownTaskBoundary
      || (meta.sessionMetaCount === 1 && !meta.forkedFromId
        ? meta.firstTaskBoundary
        : null);
    if (direct) {
      return {
        rawTokenCount: Math.max(
          replayTokenCount,
          partialReplayTokenCount,
          direct.rawTokenCount
        ),
        recordIndex: direct.recordIndex,
      };
    }

    // A recognized sub-agent can be synced while Codex is only partway
    // through appending the copied parent block. The completed-replay matcher
    // correctly rejects that interior slice, but counting it would create a
    // temporary spike that disappears on the next sync. Exact payload overlap
    // with the known parent is sufficient evidence to defer those leading
    // records until the rollout reaches a stable suffix or task boundary.
    return {
      rawTokenCount: Math.max(replayTokenCount, partialReplayTokenCount),
      recordIndex: null,
    };
  }

  if (meta.forkedFromId) {
    return { rawTokenCount: replayTokenCount, recordIndex: null };
  }
  return { rawTokenCount: 0, recordIndex: null };
}

function boundaryKey(boundary) {
  return `${boundary.rawTokenCount}:${boundary.recordIndex ?? ''}`;
}

// Slim indexes. The manifest (codex-cache.js) keeps a replay index without its
// per-record arrays -- on the maintainer's Mac those arrays were 245 MB of the
// 290 MB a warm sync read, and are needed only to compute the replay boundary
// of a fork or sub-agent whose own or parent's file changed. A slim index
// carries where its full index is; fillFullIndex() reads it from that entry.
const HEAVY_INDEX_FIELDS = ['tokenTimes', 'tokenFingerprints', 'taskBoundaries'];
const SLIM_INDEX_SOURCE = Symbol('slim Codex index source');

function slimIndexFields(index) {
  if (!index) return null;
  const slim = {};
  for (const [key, value] of Object.entries(index)) if (!HEAVY_INDEX_FIELDS.includes(key)) slim[key] = value;
  return slim;
}

function isSlimIndex(index) {
  return !!index?.[SLIM_INDEX_SOURCE];
}

// What a parent's replay index contributes to a boundary: its per-record
// arrays, as a digest. A parent's file can stay the same while the index used
// for it changes -- an algorithm-5 entry, whose durable usage records were
// fingerprinted without their response id, is taken whole on a Magpie-free
// machine and gives way to an index built by this version once Magpie becomes
// active or the cut moves (and such an index can also have been copied into a
// version-7 entry). So the parent state a summary was checked against
// (replayParentState()) includes this digest. A slim index carries the one its
// record was written with.
const INDEX_DIGEST = Symbol('Codex replay index digest');

function replayIndexDigest(index) {
  if (!index) return null;
  if (HEAVY_INDEX_FIELDS.every(key => Array.isArray(index[key]))) {
    index[INDEX_DIGEST] ??= createHash('sha256')
      .update(JSON.stringify(HEAVY_INDEX_FIELDS.map(key => index[key])))
      .digest('base64url').slice(0, 22);
    return index[INDEX_DIGEST];
  }
  return typeof index.indexDigest === 'string' ? index.indexDigest : null;
}

/**
 * Fill a slim index, in place (every holder of the object sees it), from the
 * entry it was recorded from: this version's, or the older version's whose
 * entry the manifest record stands for (taken whole, as startingCache() takes
 * it). False when that entry no longer holds the same index.
 */
function fillFullIndex(index) {
  const source = index?.[SLIM_INDEX_SOURCE];
  if (!source) return true;
  const { codexHome, filePath, signature, src, cacheOptions } = source;
  let full = null;
  try {
    if (src === CODEX_PARSER_ALGORITHM_VERSION) {
      full = loadCodexFileCache(codexHome, filePath, signature)?.index;
    } else {
      const older = loadOlderCodexFileCache(codexHome, filePath, signature, cacheOptions);
      full = older?.entry?.index ?? older?.index;
    }
  } catch {
    full = null;
  }
  if (!full || !HEAVY_INDEX_FIELDS.every(key => Array.isArray(full[key]))
    || full.sessionId !== index.sessionId
    || full.parsedRecordCount !== index.parsedRecordCount
    || full.rawTokenCount !== index.rawTokenCount) return false;
  delete index[SLIM_INDEX_SOURCE];
  delete index.indexDigest;
  delete index[INDEX_DIGEST];
  Object.assign(index, full);
  return true;
}

/**
 * fillFullIndex(), or -- when the entry no longer has it -- the index built
 * again from the rollout (a group: from its merged members), as a miss would.
 */
async function ensureFullIndex(index, file, cacheStats) {
  if (!isSlimIndex(index) || fillFullIndex(index)) return;
  let full;
  if (file.members) {
    const lines = await mergeCodexSegments(file.members, readLines);
    cacheStats.filesRead += file.members.length;
    full = await indexSessionFile(file.filePath, null, lines);
  } else {
    full = await indexSessionFile(file.filePath, file.snapshotSize);
    cacheStats.filesRead++;
  }
  delete index[SLIM_INDEX_SOURCE];
  delete index.indexDigest;
  delete index[INDEX_DIGEST];
  Object.assign(index, full);
  updateFileCache(file, { index });
}

// A record keeps of a slim index only what its header and path do not already
// say: on the maintainer's Mac most of the manifest was those repeated fields.
// expandManifestIndex() puts them back; a field whose value differs from the
// header's is kept, and one the header has but the index lacks is kept as null
// (every reader treats null and undefined alike for these).
const INDEX_FIELDS_IN_HEADER = ['sessionId', 'forkedFromId', 'parentThreadId', 'sessionProject',
  'modelProvider', 'sessionStartedAtMs', 'isSubagent'];

function compactManifestIndex(index, header, filePath, withDigest = false) {
  const slim = slimIndexFields(index);
  if (!slim) return null;
  delete slim.indexDigest;
  const digest = withDigest ? replayIndexDigest(index) : null;
  if (digest) slim.indexDigest = digest;
  const compact = {};
  for (const [key, value] of Object.entries(slim)) {
    if (key === 'filePath' && value === filePath) continue;
    if (header && INDEX_FIELDS_IN_HEADER.includes(key) && JSON.stringify(header[key]) === JSON.stringify(value)) continue;
    compact[key] = value;
  }
  for (const key of INDEX_FIELDS_IN_HEADER) {
    if (header?.[key] != null && slim[key] == null && !(key in compact)) compact[key] = null;
  }
  return compact;
}

function expandManifestIndex(compact, header, filePath) {
  const index = { filePath };
  if (header) for (const key of INDEX_FIELDS_IN_HEADER) if (key in header) index[key] = header[key];
  return Object.assign(index, compact);
}

/** What a manifest record keeps of a cache state (never the per-record arrays). */
function manifestRecord(cache, signature, src, boundaryParent, filePath, withDigest = false) {
  return {
    signature,
    src,
    header: cache.header ?? null,
    index: compactManifestIndex(cache.index, cache.header ?? null, filePath, withDigest),
    ...(cache.copyOf ? { copyOf: cache.copyOf } : {}),
    result: cache.result ?? null,
    lastAuditedAt: cache.lastAuditedAt ?? null,
    ...(boundaryParent !== undefined ? { boundaryParent } : {}),
  };
}

/**
 * Whether a manifest record stands for what the lookup would find for this
 * exact file state. This version's: a summary, or (a file) a header and an
 * index -- startingCache() stops at either. An older version's: only a whole
 * entry, under the same rules olderEntryFor() applies.
 */
function manifestRecordUsable(record, signature, cacheOptions, ultrafastStartMs, { group = false } = {}) {
  if (!record || !sameSignature(record.signature, signature)) return false;
  if (record.src === CODEX_PARSER_ALGORITHM_VERSION) {
    return !!record.result || (!group && !!record.header && !!record.index);
  }
  return !!record.result && olderSummaryAccepted(record.src, cacheOptions)
    && summaryMatchesCut(record.result, ultrafastStartMs);
}

function cacheFromManifestRecord(record, codexHome, filePath, cacheOptions) {
  const index = record.index ? expandManifestIndex(record.index, record.header, filePath) : null;
  if (index) index[SLIM_INDEX_SOURCE] = { codexHome, filePath, signature: record.signature, src: record.src, cacheOptions };
  return {
    header: record.header,
    index,
    result: record.result,
    lastAuditedAt: record.lastAuditedAt,
    ...(record.copyOf ? { copyOf: record.copyOf } : {}),
  };
}

function sameManifestRecord(a, b) {
  return a === b || (!!a && !!b
    && a.src === b.src
    && sameSignature(a.signature, b.signature)
    && !!a.header === !!b.header
    && !!a.index === !!b.index
    && a.index?.indexDigest === b.index?.indexDigest
    && !!a.result === !!b.result
    && a.result?.boundaryKey === b.result?.boundaryKey
    && a.lastAuditedAt === b.lastAuditedAt
    && a.boundaryParent === b.boundaryParent
    && a.copyOf?.filePath === b.copyOf?.filePath
    && sameSignature(a.copyOf?.signature, b.copyOf?.signature));
}

function updateFileCache(file, changes) {
  // An entry always gets a full index or none: a slim one from the manifest is
  // filled from its entry first, and dropped when that is no longer possible.
  if (!changes.index && isSlimIndex(file.cache?.index) && !fillFullIndex(file.cache.index)) {
    file.cache = { ...file.cache, index: null };
  }
  const data = cacheData(file.cache, changes);
  if (isSlimIndex(data.index)) data.index = null;
  file.cacheWritten = true;
  file.cacheSource = CODEX_PARSER_ALGORITHM_VERSION;
  try {
    saveCodexFileCache(file.codexHome, file.filePath, file.signature, data);
  } catch {
    // A read-only home, full disk, or antivirus race must only disable the
    // optimization for this run. Raw-log parsing remains the source of truth.
  }
  file.cache = { ...(file.cache || {}), ...data };
}

// The share of the work budget a run may spend reading compressed history no
// run has read yet: the replay index or merge of a `.jsonl.zst`, and the usage
// of one. The rest of the budget stays for what changed since the last run --
// new and grown plain rollouts, i.e. the conversations in use -- so they are
// uploaded on the first sync after an upgrade that finds years of compressed
// history (see the partial-result rules in parseCodexHomes()).
const BACKLOG_SHARE = 2 / 3;

function workBudgetMs() {
  const configured = Number(process.env.VIBE_USAGE_CODEX_WORK_BUDGET_MS);
  if (Number.isFinite(configured) && configured > 0) return configured;
  // The macOS and Windows apps terminate their child after 120 seconds.
  // Cache-building work in a non-interactive child therefore checkpoints well
  // before that wall so the rest of the sync (other parsers sharing this event
  // loop, then the upload) still finishes, and the next invocation resumes
  // instead of starting from zero. 105s was not enough: on a maintainer's Mac
  // during the 0.14.8 rebuild, Claude Code parsing alone ran to 94s alongside
  // a 45s Codex budget, and a 105s budget made every app sync time out before
  // uploading anything. Interactive users can let a cold build finish in one
  // run (and can interrupt it safely).
  if (codexCacheEnabled() && !process.stdout.isTTY) return 45_000;
  return Number.POSITIVE_INFINITY;
}

function auditIntervalMs() {
  const configured = Number(process.env.VIBE_USAGE_CODEX_AUDIT_INTERVAL_MS);
  if (Number.isFinite(configured) && configured >= 0) return configured;
  return 30 * 24 * 60 * 60 * 1000;
}

function auditMaxBytes() {
  const configured = Number(process.env.VIBE_USAGE_CODEX_AUDIT_MAX_BYTES);
  if (Number.isFinite(configured) && configured > 0) return configured;
  // Keep the background audit bounded below the app's wall timeout. Larger
  // active files are still invalidated immediately by their stat signature,
  // and every cache generation is rebuilt after parser-algorithm changes.
  return 64 * 1024 * 1024;
}

// What re-reading a file costs: its text. For a compressed rollout that is the
// decompressed size its last full read recorded; without one it is not audited.
function auditSize(file) {
  if (!file.compressed) return file.snapshotSize;
  return file.cache?.result?.decodedBytes ?? Number.POSITIVE_INFINITY;
}

function applySessionEvent(acc, event) {
  const timestampMsValue = event.timestamp.getTime();
  if (acc.lastTimestampMs != null && timestampMsValue < acc.lastTimestampMs) return false;
  acc.firstTimestampMs ??= timestampMsValue;
  acc.lastTimestampMs = timestampMsValue;
  acc.messageCount++;

  if (event.role === 'user') {
    if (acc.turnStartMs != null && acc.turnEndMs != null && acc.turnEndMs > acc.turnStartMs) {
      acc.completedActiveSeconds += Math.round((acc.turnEndMs - acc.turnStartMs) / 1000);
    }
    acc.turnStartMs = null;
    acc.turnEndMs = null;
    acc.waitingForFirstResponse = true;
    acc.userMessageCount++;
    acc.userPromptHours[event.timestamp.getUTCHours()]++;
  } else if (acc.waitingForFirstResponse) {
    acc.turnStartMs = timestampMsValue;
    acc.turnEndMs = timestampMsValue;
    acc.waitingForFirstResponse = false;
  } else if (acc.turnStartMs != null) {
    acc.turnEndMs = timestampMsValue;
  }
  return true;
}

function buildSessionAccumulator(events, previous = null) {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const first = sorted[0];
  const acc = previous
    ? {
        ...previous,
        userPromptHours: [...previous.userPromptHours],
      }
    : {
        sessionId: first?.sessionId || null,
        source: first?.source || null,
        project: first?.project || 'unknown',
        firstTimestampMs: null,
        lastTimestampMs: null,
        completedActiveSeconds: 0,
        turnStartMs: null,
        turnEndMs: null,
        waitingForFirstResponse: false,
        messageCount: 0,
        userMessageCount: 0,
        userPromptHours: new Array(24).fill(0),
      };
  for (const event of sorted) {
    if (!applySessionEvent(acc, event)) return null;
  }
  return acc.sessionId ? acc : null;
}

function sessionFromAccumulator(acc) {
  if (!acc?.sessionId || acc.firstTimestampMs == null || acc.lastTimestampMs == null) return null;
  let activeSeconds = acc.completedActiveSeconds;
  if (acc.turnStartMs != null && acc.turnEndMs != null && acc.turnEndMs > acc.turnStartMs) {
    activeSeconds += Math.round((acc.turnEndMs - acc.turnStartMs) / 1000);
  }
  return {
    source: acc.source,
    project: acc.project || 'unknown',
    sessionHash: createHash('sha256').update(acc.sessionId).digest('hex').slice(0, 16),
    firstMessageAt: new Date(acc.firstTimestampMs).toISOString(),
    lastMessageAt: new Date(acc.lastTimestampMs).toISOString(),
    durationSeconds: Math.round((acc.lastTimestampMs - acc.firstTimestampMs) / 1000),
    activeSeconds,
    messageCount: acc.messageCount,
    userMessageCount: acc.userMessageCount,
    userPromptHours: acc.userPromptHours,
  };
}

function mergeBucketLists(lists) {
  const entries = [];
  for (const buckets of lists) {
    for (const bucket of buckets || []) {
      entries.push({
        source: bucket.source,
        model: bucket.model,
        project: bucket.project,
        ...(bucket.hostname ? { hostname: bucket.hostname } : {}),
        timestamp: new Date(bucket.bucketStart),
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        cachedInputTokens: bucket.cachedInputTokens,
        reasoningOutputTokens: bucket.reasoningOutputTokens,
      });
    }
  }
  return aggregateToBuckets(entries);
}

async function parseSessionFile(filePath, snapshotSize, fm, boundary, {
  previousTail = null,
  captureTail = false,
  lines = null,
} = {}) {
  const entries = [];
  const ultrafastEntries = [];
  const magpieEntries = [...(previousTail?.magpieEntries || [])];
  const sessionEvents = [];
  let rawTokenSeen = previousTail?.rawTokenSeen || 0;
  let parsedRecordIndex = previousTail?.parsedRecordIndex || 0;
  let firstSessionMetaSeen = previousTail?.firstSessionMetaSeen || false;

  const sessionProject = fm.sessionProject;
  // Group timing events by the real Codex session id, not the file path: the
  // same session can briefly exist in both sessions/ and archived_sessions/
  // (mid-archive, or a re-synced archive). Path-keyed grouping would emit it
  // as two different sessionHashes and double-count its session stats. Fall
  // back to the path only when the id is unknown (corrupt/missing meta) -- the
  // plain path, so compressing the file does not make it a new session.
  const sessionKey = fm.sessionId
    || (isCompressedRollout(filePath) ? filePath.slice(0, -COMPRESSED_SUFFIX.length) : filePath);

  let turnContextModel = previousTail?.turnContextModel || 'unknown';
  let serviceTier = previousTail?.serviceTier || null;
  let prevTotal = previousTail?.prevTotal || null;
  let prevCumulativeTotal = previousTail?.prevCumulativeTotal ?? null;
  // Durable records and UI counters are separate series whose cumulative totals
  // can diverge after an interrupted call, so each keeps its own baseline.
  let prevRecordTotal = previousTail?.prevRecordTotal ?? null;
  let pendingUsageMirror = previousTail?.pendingUsageMirror ?? null;
  const start = previousTail?.parsedBytes || 0;
  const reader = lines ?? readLines(filePath, snapshotSize, start);
  for await (const line of reader) {
    if (!line.trim()) continue;
    try {
      const obj = normalizeUsageRecord(JSON.parse(line));
      parsedRecordIndex++;
      // A resumed or new turn cannot be the delayed mirror of the preceding
      // request, so the marker must not survive a turn boundary.
      if (obj.type === 'session_meta' || obj.type === 'turn_context' || obj.type === 'token_usage_record'
          || (obj.type === 'event_msg' && isTaskStarted(obj.payload))) pendingUsageMirror = null;

        // A direct child task boundary covers every copied record, including
        // timing/meta events. The raw-token ordinal covers full-history and
        // last-N-turn forks whose exact payload sequence was matched in pass 1.
      const beforeOwnTask = boundary.recordIndex != null
        && parsedRecordIndex < boundary.recordIndex;
      const inReplayBlock = beforeOwnTask || rawTokenSeen < boundary.rawTokenCount;

      const isSessionMeta = obj.type === 'session_meta';
      const isCanonicalSessionMeta = isSessionMeta && !firstSessionMetaSeen;
      const isOwnSessionMeta = isSessionMeta
        && obj.payload?.id != null
        && obj.payload.id === fm.sessionId;
      if (isSessionMeta) firstSessionMetaSeen = true;

      if (obj.timestamp) {
        const evTs = new Date(obj.timestamp);
        if (!isNaN(evTs.getTime())) {
            // Repeated same-id metadata can be appended on resume/config
            // updates and belongs to this logical session. A different-id meta
            // is copied parent history and must not inflate timing stats.
          const keepSessionMeta = isCanonicalSessionMeta
            || (isOwnSessionMeta && !inReplayBlock);
          if (keepSessionMeta || (!isSessionMeta && !inReplayBlock)) {
            const isUserTurn = obj.type === 'turn_context' || obj.type === 'session_meta';
            sessionEvents.push({
              sessionId: sessionKey,
              source: 'codex',
              project: sessionProject,
              timestamp: evTs,
              role: isUserTurn ? 'user' : 'assistant',
            });
          }
        }
      }

      if (obj.type === 'turn_context') {
        if (obj.payload?.model) turnContextModel = obj.payload.model;
        if (Object.hasOwn(obj.payload || {}, 'service_tier')) {
          serviceTier = normalizeCodexServiceTier(obj.payload.service_tier);
        }
        continue;
      }

      if (obj.type !== 'event_msg') continue;

      const payload = obj.payload;
      if (!payload) continue;

      if (payload.type === 'thread_settings_applied') {
        const settings = payload.thread_settings;
        if (settings?.model) turnContextModel = settings.model;
        if (Object.hasOwn(settings || {}, 'service_tier')) {
          serviceTier = normalizeCodexServiceTier(settings.service_tier);
        }
        continue;
      }

      if (payload.type !== 'token_count') continue;

        // Raw ordinals advance before validating usage/timestamp so pass 1 and
        // pass 2 cannot drift on a malformed copied token_count record.
      const isReplayedHistory = inReplayBlock;
      rawTokenSeen++;

      const info = payload.info;
      if (!info) continue;

        // Codex sometimes writes the same token_count twice back-to-back:
        // identical last_token_usage with an unchanged cumulative total. A
        // real API call always advances the cumulative counter (its input
        // tokens alone are non-zero), so an unchanged positive total marks a
        // duplicate emission — or a zero-usage bookkeeping event such as
        // compaction — and must count as zero, not a second copy of
        // last_token_usage. Guarded to positive totals so builds that leave
        // total_token_usage all-zero can't suppress real usage.
      const isUsageRecord = payload.usage_record === true;
      // The durable record and the UI event describe the same request, but their
      // cumulative counters can diverge after an interrupted call, so the match
      // is on per-request usage. The marker survives appends because the mirror
      // can arrive in a later read.
      const isMirror = !isUsageRecord && pendingUsageMirror && sameRequestUsage(pendingUsageMirror, info.last_token_usage);
      pendingUsageMirror = isUsageRecord ? info.last_token_usage : null;
      const cumulativeTotal = info.total_token_usage?.total_tokens;
      const isDuplicateEmission = typeof cumulativeTotal === 'number'
        && cumulativeTotal > 0
        && cumulativeTotal === (isUsageRecord ? prevRecordTotal : prevCumulativeTotal);
      if (typeof cumulativeTotal === 'number') {
        if (isUsageRecord) prevRecordTotal = cumulativeTotal;
        else prevCumulativeTotal = cumulativeTotal;
      }

        // Prefer incremental per-request usage; compute delta from cumulative
        // totals as fallback. Always advance the cumulative baseline, even
        // when last_token_usage exists or the record belongs to a replay.
      const curr = info.total_token_usage;
      let usage = info.last_token_usage;
      if (!usage && curr) {
        if (prevTotal) {
          const delta = {
            input_tokens: (curr.input_tokens || 0) - (prevTotal.input_tokens || 0),
            output_tokens: (curr.output_tokens || 0) - (prevTotal.output_tokens || 0),
            cached_input_tokens: (curr.cached_input_tokens || 0) - (prevTotal.cached_input_tokens || 0),
            reasoning_output_tokens: (curr.reasoning_output_tokens || 0) - (prevTotal.reasoning_output_tokens || 0),
          };
            // Cumulative counters can reset after compaction or a new usage
            // window. Treat the first post-reset total as a fresh baseline;
            // allowing a negative delta would cancel legitimate bucket usage.
          usage = Object.values(delta).some(value => value < 0) ? curr : delta;
        } else {
            // First cumulative entry — use as-is (it's the first event's total)
          usage = curr;
        }
      }
        // total_token_usage is session-wide, not per model. A global baseline
        // avoids counting the full cumulative total again after a model switch.
      if (curr) prevTotal = { ...curr };
      if (!usage) continue;
      if (isReplayedHistory || isDuplicateEmission || isMirror) continue;

      const timestamp = obj.timestamp ? new Date(obj.timestamp) : null;
      if (!timestamp || isNaN(timestamp.getTime())) continue;

      const segmentContext = lines ? obj._segmentContext : null;
      const rawModel = info.model || payload.model || segmentContext?.model || turnContextModel || 'unknown';
      const effectiveTier = Object.hasOwn(segmentContext || {}, 'serviceTier')
        ? normalizeCodexServiceTier(segmentContext.serviceTier) : serviceTier;
      const isUltrafast = effectiveTier === CODEX_ULTRAFAST_TIER;
      const model = decorateCodexModel(rawModel, isUltrafast ? null : effectiveTier, timestamp.getTime());

        // OpenAI API: input_tokens INCLUDES cached, output_tokens INCLUDES reasoning.
        // Normalize to Anthropic-style semantics where each field is non-overlapping.
      const cachedInput = usage.cached_input_tokens || usage.cache_read_input_tokens || 0;
      const reasoningOutput = usage.reasoning_output_tokens || 0;
      const entry = {
        source: 'codex',
        model,
        project: sessionProject,
        timestamp,
        inputTokens: (usage.input_tokens || 0) - cachedInput,
        outputTokens: (usage.output_tokens || 0) - reasoningOutput,
        cachedInputTokens: cachedInput,
        reasoningOutputTokens: reasoningOutput,
      };
      if (fm.modelProvider === 'magpie') {
        // Keep raw attribution in both summary and append caches. The cut and
        // ledger are evaluated only after all cached/raw results are assembled.
        magpieEntries.push({ ...entry, magpie: { responseId: payload.response_id,
          counts: [usage.input_tokens || 0, usage.output_tokens || 0, cachedInput] } });
      } else if (isUltrafast && model !== 'unknown') ultrafastEntries.push(entry);
      else entries.push(entry);
    } catch {
      continue;
    }
  }

  // Indexed files must match both passes exactly. Ordinary sessions take the
  // single-pass fast path and have no expected counts; their byte-bounded
  // snapshot is still stable, and any append invalidates the stat signature on
  // the next sync.
  if (fm.parsedRecordCount != null && fm.rawTokenCount != null) {
    if (parsedRecordIndex !== fm.parsedRecordCount || rawTokenSeen !== fm.rawTokenCount) {
      throw new Error('Codex rollout changed while syncing; retry on the next sync');
    }
  }

  const buckets = mergeBucketLists([
    previousTail?.buckets || [],
    aggregateToBuckets(entries),
  ]);
  // Ultrafast usage under the raw model name, one bucket per window. Always an
  // array, even when empty: its presence is what marks a summary as written by
  // algorithm 7 (see summaryMatchesCut()).
  const ultrafastBuckets = mergeBucketLists([
    previousTail?.ultrafastBuckets || [],
    aggregateToBuckets(ultrafastEntries),
  ]);
  const sessionAccumulator = buildSessionAccumulator(
    sessionEvents,
    previousTail?.sessionAccumulator || null
  );
  // Appended records should be chronological. If an app version inserts an
  // older event into the tail, the compact accumulator cannot reproduce the
  // global sort exactly, so discard the optimization and rebuild this file.
  if (previousTail && sessionEvents.length > 0 && !sessionAccumulator) {
    return parseSessionFile(filePath, snapshotSize, fm, boundary, { captureTail });
  }
  const session = sessionFromAccumulator(sessionAccumulator);
  const result = { buckets, ultrafastBuckets, magpieEntries, sessions: session ? [session] : [] };
  // A compressed rollout's text size bounds the rolling audit (its file size
  // does not); see auditSize().
  if (typeof reader.decodedBytes === 'function') result.decodedBytes = reader.decodedBytes();
  if (captureTail) {
    const guard = snapshotGuard(filePath, snapshotSize);
    result.tail = {
      parsedBytes: snapshotSize,
      parsedRecordIndex,
      rawTokenSeen,
      firstSessionMetaSeen,
      turnContextModel,
      serviceTier,
      prevTotal,
      prevCumulativeTotal,
      prevRecordTotal,
      pendingUsageMirror,
      buckets,
      ultrafastBuckets,
      magpieEntries,
      sessionAccumulator,
      guardHash: guard.hash,
      endsWithNewline: guard.endsWithNewline,
    };
  }
  return result;
}

// A summary written before algorithm 7 has no `ultrafastBuckets`: its Ultrafast
// usage is folded into the plain model's buckets. That is the merged format,
// which is still the right output for every window before the cut -- all of
// them while the machine has no cut. Only a summary with a window at or after
// the cut has to be rebuilt from the rollout.
function summaryMatchesCut(result, ultrafastStartMs) {
  if (Array.isArray(result.ultrafastBuckets)) return true;
  if (ultrafastStartMs === null) return true;
  return (result.buckets || []).every(bucket => Date.parse(bucket.bucketStart) < ultrafastStartMs);
}

// What an older version left for exactly this file state (codex-cache.js
// decides, by algorithm version, which of it may be taken at all).
function olderEntryFor(codexHome, filePath, signature, cacheOptions, ultrafastStartMs) {
  const older = loadOlderCodexFileCache(codexHome, filePath, signature, cacheOptions);
  if (!older) return null;
  return {
    // Its summary may stand in only when it is exact under the cut.
    summary: older.entry?.result && summaryMatchesCut(older.entry.result, ultrafastStartMs) ? older.entry : null,
    header: older.header,
    index: older.index,
  };
}

/**
 * What a rollout's parse starts from. In this order, and the order matters:
 *
 *   1. this version's finished summary for exactly this file state;
 *   2. this version's append tail -- the file grew since we last read it;
 *   3. an older version's entry for exactly this file state: all of it if its
 *      summary is exact under the current cut, otherwise its header and replay
 *      index, to fill in what this version's own entry does not have yet;
 *   4. nothing: the rollout is read from the start.
 *
 * Our own state always comes first. An older collector that is still running
 * (a daemon not yet restarted, a desktop app on its cached CLI) rewrites its
 * summary after every append, so it nearly always has one for the current file
 * state. Looking there before step 2 let that summary shadow our tail; once the
 * machine has a cut the summary is then rejected (it folds Ultrafast into the
 * plain model in post-cut windows), and with the tail never loaded the rollout
 * was parsed from the first byte on every run.
 *
 * The header and index of step 3 are what an upgrade needs for a session that
 * exists in several homes. Its usage is summarized once, on the group's entry
 * (see the duplicate-id loop in parseNativeCodex()); the entry of each physical
 * file never has a summary, only a header and an index. Requiring a summary, as
 * 0.15.0 did, read every such file from the first byte for its header and again
 * for its index. The same applies to a rebuild that was interrupted half-way:
 * our own entry then has the header but not yet the index.
 *
 * The rolling audit is unaffected. Its per-file half only runs when every file
 * has a summary, and a file that took just a header and index here has none;
 * the group audit in parseNativeCodex() does not depend on that and runs as
 * before. (The members of a duplicate group never have a summary of their own,
 * so a machine with such groups only ever gets the group audit -- unchanged.)
 *
 * The lookup also ends after step 1 when our own entry for exactly this file
 * state has no summary but already holds a header and a replay index. That is
 * every member of a session kept in several homes: the member never gets a
 * summary of its own (the group's entry holds it), so steps 2 and 3 ran on
 * every sync and found nothing to use -- step 3 takes our own header and index
 * before an older one, and a member needs no file summary. On the maintainer's
 * Mac (2026-11-19, 25,628 rollouts, 11,500 shared sessions) that was 23,957
 * tail lookups and 20,222 older entries (102 MB) read and thrown away per sync,
 * about 0.95 s of a 3.45 s warm sync. Outside that case two things are given
 * up, each costing one read of the rollout and never a different result (the
 * cache is never authoritative): an older summary for this exact state --
 * there is normally none to be had, since our entry got its index from the
 * rollout, a hard-linked twin or an older entry whose summary was not usable --
 * and the append tail of a file that has an index but no longer needs one (its
 * duplicate or its fork disappeared).
 */
function startingCache(file, cacheOptions, ultrafastStartMs, manifest = null) {
  // A manifest record for exactly this file state is what one of the stops
  // below found last time (manifestRecordUsable()); its index is slim.
  const record = manifest?.get(file.filePath);
  if (manifestRecordUsable(record, file.signature, cacheOptions, ultrafastStartMs)) {
    file.cache = cacheFromManifestRecord(record, file.codexHome, file.filePath, cacheOptions);
    file.priorCache = file.cache;
    file.cacheSource = record.src;
    file.manifestRecord = record;
    return;
  }
  const own = loadCodexFileCache(file.codexHome, file.filePath, file.signature);
  file.cache = own;
  file.priorCache = own;
  if (own) file.cacheSource = CODEX_PARSER_ALGORITHM_VERSION;
  if (own?.result) return;
  if (own?.header && own?.index) return;
  file.cacheSource = null;
  file.priorCache = own || loadCodexFileCache(file.codexHome, file.filePath);
  file.priorTail = loadCodexFileTail(file.codexHome, file.filePath);
  if (file.priorCache) file.appendTail = tailStateFor(file);
  if (file.appendTail) return;
  const older = olderEntryFor(file.codexHome, file.filePath, file.signature, cacheOptions, ultrafastStartMs);
  if (!older) return;
  if (older.summary) {
    file.cache = older.summary;
    file.cacheSource = older.summary.algorithmVersion;
    return;
  }
  const header = own?.header ?? older.header;
  const index = own?.index ?? older.index;
  if (header || index) file.cache = { ...own, header, index };
}

function mergeFileResults(results, magpie, ultrafastStartMs = null) {
  const entries = [];
  const magpieEntries = [];
  const sessions = [];
  const toEntry = (bucket, model) => ({
    source: bucket.source,
    model,
    project: bucket.project,
    ...(bucket.hostname ? { hostname: bucket.hostname } : {}),
    timestamp: new Date(bucket.bucketStart),
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cachedInputTokens: bucket.cachedInputTokens,
    reasoningOutputTokens: bucket.reasoningOutputTokens,
  });
  for (const result of results) {
    for (const entry of result.magpieEntries || []) magpieEntries.push(entry);
    for (const bucket of result.buckets || []) entries.push(toEntry(bucket, bucket.model));
    // Before the cut the name is unchanged, so these tokens sum into the plain
    // model's bucket exactly as they did when the parser never told them apart.
    for (const bucket of result.ultrafastBuckets || []) {
      entries.push(toEntry(bucket, codexUltrafastModel(bucket.model, bucket.bucketStart, ultrafastStartMs)));
    }
    for (const session of result.sessions || []) sessions.push(session);
  }
  for (const entry of magpie ? magpie.attribute(magpieEntries, 'codex') : magpieEntries) entries.push(entry);
  return { buckets: aggregateToBuckets(entries), sessions };
}

// A compressed rollout that cannot be decompressed is never counted in part:
// the source is skipped, which keeps its upload state, and the file is named.
// Codex verifies a compressed file before publishing it, so this means damage
// on disk; it repeats every sync until the file is repaired or removed.
function undecodableRollout(err, cacheStats) {
  return {
    buckets: [], sessions: [], skipped: true,
    warnings: [`codex: 压缩记录解压失败，已保留上次同步数据: ${err.filePath}（${err.message}）`],
    ...(cacheStats ? { cache: cacheStats } : {}),
  };
}

async function parseNativeCodex(options = {}) {
  const discovery = { undecodable: 0 };
  const result = await parseCodexHomes(options, discovery);
  if (discovery.undecodable === 0) return result;
  // Node without node:zlib zstd (before 22.15): these rollouts stay unread as
  // in every earlier release, and the rest of Codex still syncs. Said on every
  // run, since the usage they hold is missing from the upload.
  return {
    ...result,
    warnings: [
      ...(result.warnings || []),
      `codex: ${discovery.undecodable} 个压缩的旧对话（.jsonl.zst）没有统计：当前 Node ${process.version} 没有 zstd 解压，需要 Node 22.15 或更高版本`,
    ],
  };
}

/**
 * The replay index of a rollout that holds exactly the bytes of another file
 * of its session whose index is already known. An index is a function of the
 * bytes alone (its `filePath` aside), so the other file's index is this one's.
 *
 * linkedIndex(): a hard link of that file (the same stat signature; Orca links
 * each rollout into every account's home). Costs no read.
 */
function linkedIndex(file, sameSession, fileMeta, needsIndex) {
  const link = sameSession.find(other => other !== file && needsIndex.has(other.filePath)
    && fileMeta.has(other.filePath) && sameSignature(other.signature, file.signature));
  if (!link || !fillFullIndex(fileMeta.get(link.filePath))) return null;
  return { ...fileMeta.get(link.filePath), filePath: file.filePath };
}

/**
 * indexFromCompressedCopy(): a compressed rollout that decompresses to exactly
 * a plain copy's bytes. Proving it still decompresses the file, but skips
 * parsing every record -- on a machine whose Codex homes share conversations
 * (and Codex then compresses its own copy), that is what reading `.jsonl.zst`
 * for the first time spends its time on. It is compared with the plain file of
 * its session that the duplicate-id loop sorts first among those of its
 * decompressed size, so the proven copy joins that file's class
 * (planCodexSegments()). Returns `{ meta, copyOf }` (the plain file's path and
 * signature) or null when the file must be parsed.
 */
async function indexFromCompressedCopy(file, sameSession, fileMeta, needsIndex) {
  if (!file.compressed) return null;
  const plain = sameSession.filter(other => other !== file && !other.compressed
    && needsIndex.has(other.filePath) && fileMeta.has(other.filePath))
    .sort((a, b) => (fileMeta.get(b.filePath).parsedRecordCount || 0)
      - (fileMeta.get(a.filePath).parsedRecordCount || 0) || a.filePath.localeCompare(b.filePath));
  if (plain.length === 0) return null;
  const twin = await zstdFileCopyOf(file.filePath, file.snapshotSize,
    plain.map(other => ({ filePath: other.filePath, size: other.snapshotSize, file: other })));
  if (!twin || !fillFullIndex(fileMeta.get(twin.file.filePath))) return null;
  return {
    meta: { ...fileMeta.get(twin.file.filePath), filePath: file.filePath },
    copyOf: { filePath: twin.file.filePath, signature: twin.file.signature },
  };
}

/**
 * Bring each home's manifest up to what this run found, and write it only
 * when that changed. A rollout or group is recorded as its cache stands at the
 * end of the run, when that is one of the stops manifestRecordUsable() accepts.
 * The exception is one whose file changed since its record was written and
 * whose entry this run rewrote: it keeps its old record, which no longer
 * matches its stat signature, so the next run reads its entry and records it
 * once it holds still -- a conversation in use does not make every sync
 * rewrite the manifest. (An entry rewritten for an unchanged file -- the
 * rolling audit -- is recorded at once: its record has to carry the new audit
 * time, or the audit would pick the same file again on every run.) A run that
 * leaves work for the next one keeps the records it did not get to.
 */
function writeCodexManifests(manifests, files, complete, parentIds = new Set()) {
  if (!codexCacheEnabled()) return;
  const next = new Map([...manifests.keys()].map(codexHome => [codexHome, new Map()]));
  for (const file of files) {
    const records = next.get(file.codexHome);
    if (!records) continue;
    const previous = manifests.get(file.codexHome).get(file.filePath);
    const usable = !!file.cache && file.cacheSource != null && (file.cache.result
      || (!file.members && file.cacheSource === CODEX_PARSER_ALGORITHM_VERSION && file.cache.header && file.cache.index));
    const changedSinceRecorded = file.cacheWritten && previous && !sameSignature(previous.signature, file.signature);
    if (usable && !changedSinceRecorded) {
      const boundaryParent = 'boundaryParent' in file ? file.boundaryParent : file.manifestRecord?.boundaryParent;
      records.set(file.filePath, manifestRecord(file.cache, file.signature, file.cacheSource, boundaryParent ?? undefined,
        file.filePath, parentIds.has(file.cache.header?.sessionId)));
    } else if (previous) {
      records.set(file.filePath, previous);
    }
  }
  for (const [codexHome, records] of next) {
    const previous = manifests.get(codexHome);
    if (!complete) for (const [path, record] of previous) if (!records.has(path)) records.set(path, record);
    let changed = records.size !== previous.size;
    if (!changed) {
      for (const [path, record] of records) {
        if (!sameManifestRecord(record, previous.get(path))) { changed = true; break; }
      }
    }
    if (changed) saveCodexManifest(codexHome, records);
  }
}

async function parseCodexHomes({ codexExtraHome, extraRoots = [], magpie, codexUltrafastStartAt } = {}, discovery) {
  // null: this machine has no Ultrafast cut, every window keeps the merged format.
  const ultrafastStartMs = codexUltrafastStartMs(codexUltrafastStartAt);
  let extraCodexHomePath = null;
  if (codexExtraHome?.trim()) {
    const validation = validateExtraCodexHome(codexExtraHome);
    if (!validation.ok) {
      return {
        buckets: [],
        sessions: [],
        skipped: true,
        warnings: [`codex: 额外 Codex Home 不可用，已跳过本次 Codex 同步: ${validation.path}`],
      };
    }
    extraCodexHomePath = validation.path;
  }

  const configuredHomes = [];
  for (const root of extraRoots) {
    const discovered = discoverCodexHomes(root);
    if (!discovered.readable || discovered.homes.length === 0) {
      return {
        buckets: [],
        sessions: [],
        skipped: true,
        warnings: [`codex: 额外根目录不可用，已跳过本次 Codex 同步: ${discovered.root}`],
      };
    }
    configuredHomes.push(...discovered.homes);
  }

  const strictHomes = new Set(configuredHomes);
  if (extraCodexHomePath) strictHomes.add(extraCodexHomePath);
  const codexHomes = [...new Set([
    ...resolveCodexHomes(codexExtraHome),
    ...configuredHomes,
  ])];
  const dirs = codexHomes.flatMap(codexHome => (
    codexSessionDirs(codexHome).map(dir => ({ codexHome, dir, strict: strictHomes.has(codexHome) }))
  ));
  if (!dirs.some(({ dir }) => existsSync(dir))) return { buckets: [], sessions: [] };

  // Without a Magpie ledger or cut, attribution leaves every entry unchanged,
  // so pre-#143 cache entries are still exact (see codex-cache.js). A context
  // whose ledger was never checked counts as Magpie-active.
  const cacheOptions = {
    magpieFree: !magpie || (magpie.startAt === undefined
      && magpie.ledgerExists === false && !magpie.failed),
  };
  const startedAt = Date.now();
  const budget = workBudgetMs();
  const overBudget = () => Date.now() - startedAt >= budget;
  const cacheStats = {
    headerHits: 0,
    indexHits: 0,
    resultHits: 0,
    tailHits: 0,
    filesRead: 0,
    audited: 0,
    manifestHits: 0,
  };
  // One manifest per home, read once (see codex-cache.js); written back at the
  // end of the run when what it should hold changed (writeCodexManifests()).
  const manifests = new Map(codexHomes.map(codexHome => [codexHome, loadCodexManifest(codexHome)]));
  const files = [];
  const canDecompress = zstdDecoderAvailable();
  for (const { codexHome, dir, strict } of dirs) {
    let filePaths;
    try {
      filePaths = findRolloutFiles(dir, strict);
    } catch {
      return {
        buckets: [], sessions: [], skipped: true,
        warnings: [`codex: 额外根目录读取失败，已保留上次同步数据: ${codexHome}`],
      };
    }
    const seen = new Set();
    for (const listedPath of filePaths) {
      try {
        const { filePath, stat } = statRollout(listedPath);
        if (seen.has(filePath)) continue;
        seen.add(filePath);
        if (stat.size <= 0) continue;
        const compressed = isCompressedRollout(filePath);
        if (compressed && !canDecompress) {
          // Exactly what every release before this one did with these files.
          // Reported on every run (see parseNativeCodex()).
          discovery.undecodable++;
          continue;
        }
        const signature = fileSignature(stat);
        const file = {
          codexHome,
          filePath,
          strict,
          compressed,
          snapshotSize: stat.size,
          signature,
          cache: null,
          priorCache: null,
          priorTail: null,
          header: null,
          appendTail: null,
        };
        startingCache(file, cacheOptions, ultrafastStartMs, manifests.get(codexHome));
        if (file.manifestRecord) cacheStats.manifestHits++;
        files.push(file);
      } catch (err) {
        // The file may move to archived_sessions between discovery and stat.
        if (strict && err?.code !== 'ENOENT') {
          return {
            buckets: [], sessions: [], skipped: true,
            warnings: [`codex: 额外根目录读取失败，已保留上次同步数据: ${codexHome}`],
          };
        }
      }
    }
  }
  if (files.length === 0) return { buckets: [], sessions: [] };

  // A warm cache gets a tiny rolling correctness audit. Never mix this into a
  // cold/resumed build: all files must already have complete results, and at
  // most one bounded file is re-read per invocation.
  const auditPaths = new Set();
  if (files.every(file => file.cache?.header && file.cache?.result)) {
    const cutoff = Date.now() - auditIntervalMs();
    const candidate = files
      .filter(file => auditSize(file) <= auditMaxBytes())
      .filter(file => (file.cache.lastAuditedAt || 0) <= cutoff)
      .sort((a, b) => (a.cache.lastAuditedAt || 0) - (b.cache.lastAuditedAt || 0))[0];
    if (candidate) auditPaths.add(candidate.filePath);
  }

  // Cheap discovery: cached headers require no rollout read. On a cold build,
  // read only through the first session_meta so ordinary sessions can avoid
  // the former all-files replay-index pass.
  const candidatesById = new Map();
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const reusableHeader = file.cache?.header || (file.appendTail ? file.priorCache?.header : null);
    if (reusableHeader && !auditPaths.has(file.filePath)) {
      file.header = reusableHeader;
      if (!file.cache) file.cache = { header: reusableHeader };
      cacheStats.headerHits++;
    } else {
      try {
        file.header = await readSessionHeader(file.filePath, file.snapshotSize);
        cacheStats.filesRead++;
        updateFileCache(file, { header: file.header });
      } catch (err) {
        if (isZstdDecodeError(err)) return undecodableRollout(err);
        // An unreadable header may hide another segment of a known session.
        // Never upload the remaining readable segment as its complete total.
        return {
          buckets: [], sessions: [], skipped: true,
          warnings: ['codex: 会话文件读取失败，已保留上次同步数据'],
        };
      }
    }
    if (file.header.sessionId) {
      if (!candidatesById.has(file.header.sessionId)) candidatesById.set(file.header.sessionId, []);
      candidatesById.get(file.header.sessionId).push(file);
    }
    if (overBudget() && i < files.length - 1) {
      return {
        buckets: [], sessions: [], skipped: true,
        indexing: { phase: 'discovery', completed: i + 1, total: files.length },
        cache: cacheStats,
      };
    }
  }

  const duplicateIds = new Set(
    [...candidatesById].filter(([, candidates]) => candidates.length > 1).map(([id]) => id)
  );
  const referencedParentIds = new Set();
  for (const file of files) {
    const parentId = file.header?.forkedFromId
      || (file.header?.isSubagent ? file.header.parentThreadId : null);
    if (parentId) referencedParentIds.add(parentId);
  }

  // From here on running out of budget no longer skips the source. What is
  // not read yet is left for the next run, and every session that depends on
  // it is left out of this one: its own usage, a group with a member not read
  // yet, and a fork or sub-agent whose parent is not read yet (without the
  // parent its copied history would count). Everything else is exact and is
  // uploaded. Leaving a session out only delays it: the server keeps the larger
  // of two values for a key, so a window that is low for now changes nothing
  // there, while counting copied history would be permanent.
  //
  // Reading compressed history no run has read yet (the first sync after
  // Codex compressed a long history: tens of gigabytes on a heavy user's
  // machine) only gets BACKLOG_SHARE of the budget, so the conversations in
  // use still get their new records read and uploaded in the same run.
  const backlogBudget = budget * BACKLOG_SHARE;
  const canRead = backlog => Date.now() - startedAt < (backlog ? backlogBudget : budget);
  const pendingPaths = new Set();
  const pendingIds = new Set();
  const leaveForNextRun = file => {
    pendingPaths.add(file.filePath);
    if (file.header?.sessionId) pendingIds.add(file.header.sessionId);
  };
  let pendingPhase = null;

  // Only replay participants, their parents, corrupt-header files, and
  // duplicate physical copies need the full compact token index.
  const fileMeta = new Map();
  const needsIndex = new Set();
  // Plain rollouts first, so a compressed copy of one can take its index.
  const indexOrder = [...files.filter(file => !file.compressed), ...files.filter(file => file.compressed)];
  for (const file of indexOrder) {
    const header = file.header;
    const required = !header
      || !header.sessionId
      || header.isSubagent
      || header.forkedFromId != null
      || header.parentThreadId != null
      || referencedParentIds.has(header.sessionId)
      || duplicateIds.has(header.sessionId);
    if (!required) {
      fileMeta.set(file.filePath, { ...header, filePath: file.filePath });
      continue;
    }
    needsIndex.add(file.filePath);
    const sameSession = header?.sessionId ? candidatesById.get(header.sessionId) : [];
    let meta = auditPaths.has(file.filePath) ? null : file.cache?.index;
    if (meta) {
      cacheStats.indexHits++;
    } else if (!auditPaths.has(file.filePath) && (meta = linkedIndex(file, sameSession, fileMeta, needsIndex))) {
      // A hard link of a file already indexed: no read.
      updateFileCache(file, { index: meta });
    } else if (!canRead(file.compressed)) {
      leaveForNextRun(file);
      pendingPhase ??= 'replay-index';
      continue;
    } else {
      try {
        const copy = auditPaths.has(file.filePath) ? null
          : await indexFromCompressedCopy(file, sameSession, fileMeta, needsIndex);
        if (copy) {
          meta = copy.meta;
          updateFileCache(file, { index: meta, copyOf: copy.copyOf });
        } else {
          meta = await indexSessionFile(file.filePath, file.snapshotSize);
          updateFileCache(file, { index: meta });
        }
        cacheStats.filesRead++;
      } catch (err) {
        // Dropping it would also lose a fork's replay boundary, if it is a parent.
        if (isZstdDecodeError(err)) return undecodableRollout(err, cacheStats);
        // Gone since its header was read: Codex compressed, restored or
        // archived it, i.e. published it under another name. Dropping it here
        // made a fork of it count the copied history again; the next run finds
        // the new name.
        if (err?.code === 'ENOENT') {
          return {
            buckets: [], sessions: [], skipped: true,
            warnings: ['codex: 会话文件读取失败（同步期间被 Codex 压缩、还原或归档），已保留上次同步数据'],
            cache: cacheStats,
          };
        }
        if (file.strict) {
          return {
            buckets: [], sessions: [], skipped: true,
            warnings: [`codex: 额外根目录读取失败，已保留上次同步数据: ${file.codexHome}`],
          };
        }
        continue;
      }
    }
    fileMeta.set(file.filePath, meta);
  }

  // Duplicate ids can be disjoint continuation segments, not just archives.
  // Keep physical caches intact and give each combined session its own cache.
  const groups = new Map();
  const plans = [];
  for (const id of duplicateIds) {
    const members = candidatesById.get(id);
    if (members.some(file => pendingPaths.has(file.filePath))) {
      for (const member of members) fileMeta.delete(member.filePath);
      continue;
    }
    if (members.some(file => !fileMeta.has(file.filePath))) {
      return { buckets: [], sessions: [], skipped: true,
        warnings: ['codex: 同一会话的部分文件读取失败，已保留上次同步数据'] };
    }
    members.sort((a, b) => (fileMeta.get(b.filePath).parsedRecordCount || 0)
      - (fileMeta.get(a.filePath).parsedRecordCount || 0) || a.filePath.localeCompare(b.filePath));
    // `identity` names the group's cache entry, `read` is what the merge reads.
    plans.push({ id, members, ...planCodexSegments(members) });
  }
  // Groups merged from plain files only come first (see BACKLOG_SHARE); the
  // output keeps the order of duplicateIds.
  plans.sort((a, b) => a.read.some(file => file.compressed) - b.read.some(file => file.compressed));
  let groupAudited = false;
  for (const { id, members, identity, read } of plans) {
    const selected = identity[0];
    const filePath = `${selected.codexHome}/.vibe-usage-session-${createHash('sha256').update(id).digest('hex')}`;
    const signature = codexSegmentSignature(identity);
    // Same order as startingCache(), without step 2: a group has no append tail.
    // An older group entry is taken whole or not at all: when its summary is not
    // exact under the cut the members are merged again anyway, and indexing the
    // merged records costs no further read.
    // A manifest record for exactly this group state stands for either stop.
    let cache = null;
    let cacheSource = null;
    let manifestRecord = null;
    if (!members.some(file => auditPaths.has(file.filePath))) {
      const record = manifests.get(selected.codexHome)?.get(filePath);
      if (manifestRecordUsable(record, signature, cacheOptions, ultrafastStartMs, { group: true })) {
        cache = cacheFromManifestRecord(record, selected.codexHome, filePath, cacheOptions);
        cacheSource = record.src;
        manifestRecord = record;
        cacheStats.manifestHits++;
      } else {
        const own = loadCodexFileCache(selected.codexHome, filePath, signature);
        const older = own?.result ? null
          : olderEntryFor(selected.codexHome, filePath, signature, cacheOptions, ultrafastStartMs)?.summary;
        cache = own?.result ? own : older || own;
        cacheSource = own?.result ? CODEX_PARSER_ALGORITHM_VERSION : older ? older.algorithmVersion : null;
      }
    }
    // A compressed member's file size says nothing about the text it holds, so
    // a group with one is not audited (see auditSize()).
    if (cache?.result && !groupAudited && auditPaths.size === 0
      && !read.some(file => file.compressed)
      && signature.size <= auditMaxBytes()
      && (cache.lastAuditedAt || 0) <= Date.now() - auditIntervalMs()) {
      cache = null;
      cacheSource = null;
      manifestRecord = null;
      groupAudited = true;
      cacheStats.audited++;
    }
    const group = { ...selected, filePath, signature, snapshotSize: signature.size,
      compressed: false, cache, members: read, lines: null, appendTail: null, priorTail: null,
      cacheSource, manifestRecord, cacheWritten: false };
    delete group.boundaryParent;
    for (const member of members) fileMeta.delete(member.filePath);
    let meta = cache?.index;
    if (meta) {
      cacheStats.indexHits++;
    } else if (!canRead(read.some(file => file.compressed))) {
      pendingIds.add(id);
      for (const member of members) pendingPaths.add(member.filePath);
      pendingPhase ??= 'segments';
      continue;
    } else {
      try {
        group.lines = await mergeCodexSegments(read, readLines);
        cacheStats.filesRead += read.length;
        meta = await indexSessionFile(filePath, null, group.lines);
      } catch (err) {
        if (isZstdDecodeError(err)) return undecodableRollout(err, cacheStats);
        return { buckets: [], sessions: [], skipped: true,
          warnings: [`codex: 无法合并会话分段，已保留上次同步数据: ${err.message}`] };
      }
      const changes = { header: group.header, index: meta };
      // Neither a fork nor a sub-agent: its replay boundary is empty whatever
      // the other sessions hold (replayBoundary()), so it is summarized from
      // these merged records now, exactly as the usage pass would. Otherwise a
      // build that runs out of budget before the usage pass merges every such
      // group a second time.
      if (!meta.isSubagent && !meta.forkedFromId) {
        const boundary = { rawTokenCount: 0, recordIndex: null };
        const { tail, ...summary } = await parseSessionFile(filePath, group.snapshotSize, meta, boundary, {
          previousTail: null, captureTail: false, lines: group.lines,
        });
        changes.result = { boundaryKey: boundaryKey(boundary), ...summary };
        changes.lastAuditedAt = Date.now();
        group.lines = null;
        group.summarizedThisRun = true;
      }
      updateFileCache(group, changes);
    }
    fileMeta.set(filePath, meta);
    needsIndex.add(filePath);
    groups.set(id, group);
  }
  for (const id of duplicateIds) if (groups.has(id)) files.push(groups.get(id));

  // One index per logical session, including all continuation segments, feeds
  // the unchanged fork/subagent replay boundary logic.
  const sessionById = new Map();
  for (const file of files) {
    const meta = fileMeta.get(file.filePath);
    if (!meta?.sessionId) continue;
    const existing = sessionById.get(meta.sessionId);
    const count = meta.parsedRecordCount ?? 0;
    const existingCount = existing?.parsedRecordCount ?? 0;
    if (!existing || count > existingCount) sessionById.set(meta.sessionId, meta);
  }

  // Where each rollout and group is, for a parent's full index and its state.
  const filesByPath = new Map(files.map(file => [file.filePath, file]));
  const replayParentState = parent => {
    const signature = filesByPath.get(parent.filePath)?.signature;
    const digest = replayIndexDigest(parent);
    return signature && digest
      ? `${parent.filePath}\u0000${signature.size}:${signature.mtimeMs}:${signature.dev}:${signature.ino}\u0000${digest}`
      : null;
  };
  const results = [];
  const leftOut = file => {
    // A group stands for its members; a physical file for itself.
    for (const path of (file.members ? candidatesById.get(file.header.sessionId) : [file]).map(f => f.filePath)) {
      pendingPaths.add(path);
    }
    pendingPhase ??= 'usage';
  };
  for (const file of files) {
    const fm = fileMeta.get(file.filePath);
    if (!fm) continue;
    if (fm.sessionId && sessionById.get(fm.sessionId)?.filePath !== file.filePath) continue;

    if (needsIndex.has(file.filePath)) {
      const parentId = fm.forkedFromId || (fm.isSubagent ? fm.parentThreadId : null);
      if (parentId && pendingIds.has(parentId)) {
        leftOut(file);
        continue;
      }
    }
    // The replay boundary of a fork or sub-agent whose parent session is known
    // needs both full indexes. Not when the manifest record (for exactly this
    // file state) says its summary was checked against exactly this parent
    // state -- the parent's file and the index used for it (replayIndexDigest()):
    // the boundary is a function of the two indexes. Without a parent no array
    // is needed.
    const parentId = needsIndex.has(file.filePath)
      ? (fm.forkedFromId || (fm.isSubagent ? fm.parentThreadId : null))
      : null;
    const parent = parentId ? sessionById.get(parentId) : null;
    let parentState = parent ? replayParentState(parent) : null;
    let boundary = null;
    let key;
    if (parent && parentState && !auditPaths.has(file.filePath)
      && file.manifestRecord?.boundaryParent === parentState
      && file.cache?.result && summaryMatchesCut(file.cache.result, ultrafastStartMs)) {
      key = file.cache.result.boundaryKey;
    } else {
      if (parent) {
        // Filled from their entries if possible; a full index that has to be
        // built from the rollout again counts against the budget like any read.
        const parentFile = filesByPath.get(parent.filePath);
        if ((!fillFullIndex(fm) || !fillFullIndex(parent))
          && !canRead([file, parentFile].some(f => f?.compressed || !!f?.members?.some(member => member.compressed)))) {
          leftOut(file);
          continue;
        }
        await ensureFullIndex(fm, file, cacheStats);
        await ensureFullIndex(parent, parentFile, cacheStats);
        // The state of the index actually used, which its entry may have
        // changed since the manifest recorded it.
        parentState = replayParentState(parent);
      }
      boundary = needsIndex.has(file.filePath)
        ? replayBoundary(fm, sessionById)
        : { rawTokenCount: 0, recordIndex: null };
      key = boundaryKey(boundary);
    }
    let result = !auditPaths.has(file.filePath) && file.cache?.result?.boundaryKey === key
      && summaryMatchesCut(file.cache.result, ultrafastStartMs)
      ? file.cache.result
      : null;
    if (result) {
      // Summarized in this run's duplicate-id loop: not taken from the cache.
      if (!file.summarizedThisRun) cacheStats.resultHits++;
    } else if (!canRead(file.compressed || !!file.members?.some(member => member.compressed))) {
      leftOut(file);
      continue;
    } else {
      const previousTail = !needsIndex.has(file.filePath) && !auditPaths.has(file.filePath)
        ? file.appendTail
        : null;
      let parsed;
      try {
        if (file.members && !file.lines) {
          file.lines = await mergeCodexSegments(file.members, readLines);
          cacheStats.filesRead += file.members.length;
        }
        parsed = await parseSessionFile(file.filePath, file.snapshotSize, fm, boundary, {
          previousTail,
          captureTail: !needsIndex.has(file.filePath) && !file.compressed,
          lines: file.lines,
        });
      } catch (err) {
        if (isZstdDecodeError(err)) return undecodableRollout(err, cacheStats);
        throw err;
      }
      if (!file.members) cacheStats.filesRead++;
      if (previousTail) cacheStats.tailHits++;
      const { tail, ...summary } = parsed;
      if (tail) {
        try {
          saveCodexFileTail(file.codexHome, file.filePath, file.signature, tail);
        } catch {
          // Same fail-open rule as the summary cache: tail acceleration is
          // optional and a write failure must not fail the parser.
        }
      }
      result = { boundaryKey: key, ...summary };
      updateFileCache(file, { result, lastAuditedAt: Date.now() });
      file.appendTail = null;
      file.priorTail = null;
      if (auditPaths.has(file.filePath)) cacheStats.audited++;
    }
    file.lines = null; // Never retain the transient combined transcript after parsing.
    // Only now is the summary known to belong to this parent state: one left
    // for the next run above keeps the parent state its record already had.
    file.boundaryParent = parentState;
    results.push(result);
  }

  const merged = { ...mergeFileResults(results, magpie, ultrafastStartMs), cache: cacheStats };
  try {
    writeCodexManifests(manifests, files, pendingPaths.size === 0, referencedParentIds);
  } catch {
    // An accelerator only: a write failure costs the next run its entry reads.
  }
  if (pendingPaths.size === 0) return merged;
  // Rollouts whose session waits for the next run, of all physical rollouts.
  const physical = files.filter(file => !file.members);
  const waiting = physical.filter(file => pendingPaths.has(file.filePath)
    || (file.header?.sessionId && pendingIds.has(file.header.sessionId))).length;
  return {
    ...merged,
    indexing: { phase: pendingPhase, completed: physical.length - waiting, total: physical.length },
  };
}

function sameRequestUsage(left, right) {
  if (!left || !right) return false;
  return ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']
    .every(key => (left[key] || 0) === (right[key] || 0));
}

export async function parse(options = {}) {
  const nativeResult = await parseNativeCodex(options);
  return mergeCindyHarnessUsage(nativeResult, readCindyHarnessUsage('codex'));
}
