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
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  isZstdDecodeError, zstdDecoderAvailable, zstdFileChunks, zstdFileCopyOf, zstdFileHeadChunks,
} from './zstd-file.js';
import {
  codexSegmentSignature, legacyCodexSegmentSignature, mergeCodexSegments, planCodexSegments,
} from './codex-segments.js';
import {
  addModelTimeSpan,
  aggregateToBuckets,
  modelTimeFields,
  replySpan,
  restoreModelTime,
  serializeModelTime,
} from './aggregate.js';
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
  olderEntryRecordable,
  olderSummaryAccepted,
  sameFile,
  sameSignature,
  saveCodexFileCache,
  saveCodexFileTail,
  saveCodexManifest,
  signatureMatches,
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
 * Leaving a `for await` over the lines early stops the input (the reader's
 * `finally`); `close()` does the same for a caller that reads none of them.
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
      // Rollouts are append-only while Codex is working. Bound both parser
      // passes to the size captured before pass 1 so they see the same prefix
      // even when the live file grows between reads.
      ...(start > 0 ? { start } : {}),
      ...(snapshotSize == null ? {} : { end: snapshotSize - 1 }),
    });
  }
  const lines = jsonlLines(input);
  lines.close = () => input.destroy();
  if (decoded) lines.decodedBytes = () => decoded.bytes;
  return lines;
}

/**
 * The lines of a JSONL byte stream. A record ends at a 0x0a byte and nowhere
 * else: Codex writes U+2028 and U+2029 raw inside JSON strings (pasted text, a
 * model's formatted answer), and `node:readline` ends a line at each of them
 * too (on Node 24.22; Node 22.23 does not), which cut such a record in two --
 * neither half parsed, the replay pass saw fewer records than the index had
 * counted, and the whole tool failed with "Codex rollout changed while
 * syncing". Bytes are split before they are decoded, as claude-code.js does.
 * A trailing 0x0d is dropped; a final segment without a newline is a line.
 */
async function* jsonlLines(input) {
  const pending = [];
  let pendingBytes = 0;
  try {
    for await (const chunk of input) {
      let lineStart = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, lineStart);
        if (newline === -1) break;
        let line;
        if (pendingBytes) {
          pending.push(chunk.subarray(lineStart, newline));
          line = Buffer.concat(pending).toString('utf8');
          pending.length = 0;
          pendingBytes = 0;
        } else {
          line = chunk.toString('utf8', lineStart, newline);
        }
        yield line.endsWith('\r') ? line.slice(0, -1) : line;
        lineStart = newline + 1;
      }
      if (lineStart < chunk.length) {
        pending.push(chunk.subarray(lineStart));
        pendingBytes += chunk.length - lineStart;
      }
    }
    if (pendingBytes) {
      const line = Buffer.concat(pending).toString('utf8');
      yield line.endsWith('\r') ? line.slice(0, -1) : line;
    }
  } finally {
    // Nobody reads these lines any more: an error the decoder still raises
    // (damage past the header) must not become an uncaught exception.
    input.on('error', () => {});
    input.destroy();
  }
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
  // The same inode; the device number is not compared (see sameSignature()).
  if (prior.signature.ino !== file.signature.ino) return null;
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

// Where a model call can start: a task start, the user's message, or a tool's
// result (every response item whose type ends in `_output`), and the session's
// own start.
function isReplyBoundary(obj) {
  const payload = obj.payload;
  if (obj.type === 'session_meta') return true;
  if (obj.type === 'event_msg') return isTaskStarted(payload) || payload?.type === 'user_message';
  if (obj.type !== 'response_item' || typeof payload?.type !== 'string') return false;
  return (payload.type === 'message' && payload.role === 'user') || payload.type.endsWith('_output');
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
 * Fill a slim index, in place (every holder of the object sees it), in the
 * order the lookup takes: this version's entry for exactly this file state
 * first, whatever the record was written from -- a collector of this version
 * that is still running (0.15.x) may have rebuilt it since, and an older
 * entry's index can itself be one an earlier algorithm computed (GPT-6.2-Astra
 * review, 2026-11-20) -- and only then the older version's entry the record
 * stands for (taken whole, as startingCache() takes it). False when neither
 * holds the same index.
 */
function fillFullIndex(index) {
  const source = index?.[SLIM_INDEX_SOURCE];
  if (!source) return true;
  const { codexHome, filePath, src, cacheOptions } = source;
  // One key or several; for a group, computed only when a fill is needed.
  const signature = typeof source.signature === 'function' ? source.signature() : source.signature;
  const sameIndex = full => !!full && HEAVY_INDEX_FIELDS.every(key => Array.isArray(full[key]))
    && full.sessionId === index.sessionId
    && full.parsedRecordCount === index.parsedRecordCount
    && full.rawTokenCount === index.rawTokenCount;
  let full = null;
  try {
    const own = loadCodexFileCache(codexHome, filePath, signature)?.index;
    if (sameIndex(own)) {
      full = own;
    } else if (src !== CODEX_PARSER_ALGORITHM_VERSION) {
      const older = loadOlderCodexFileCache(codexHome, filePath, signature, cacheOptions);
      const candidate = older?.entry?.index ?? older?.index;
      if (sameIndex(candidate)) full = candidate;
    }
  } catch {
    full = null;
  }
  if (!full) return false;
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

/**
 * What a manifest record keeps of a cache state (never the per-record arrays).
 * `entrySignature`: the signature the group's entry carries when it differs
 * from the record's -- an entry written under a group's earlier key (see
 * legacyCodexSegmentSignature()), which this version reads but does not
 * rewrite just to change its key -- so a later run can still fill the slim
 * index from it.
 */
function manifestRecord(cache, signature, src, boundaryParent, filePath, withDigest = false, entrySignature = undefined) {
  return {
    signature,
    ...(entrySignature ? { entrySignature } : {}),
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
 * version-6 entry (olderEntryRecordable()), under the same rules olderEntryFor()
 * applies; a version-5 entry is never served from the manifest.
 */
function manifestRecordUsable(record, signature, cacheOptions, ultrafastStartMs, { group = false } = {}) {
  if (!record || !signatureMatches(record.signature, signature)) return false;
  if (record.src === CODEX_PARSER_ALGORITHM_VERSION) {
    return !!record.result || (!group && !!record.header && !!record.index);
  }
  return !!record.result && olderEntryRecordable(record.src) && olderSummaryAccepted(record.src, cacheOptions)
    && summaryMatchesCut(record.result, ultrafastStartMs);
}

function cacheFromManifestRecord(record, codexHome, filePath, cacheOptions) {
  const index = record.index ? expandManifestIndex(record.index, record.header, filePath) : null;
  // The entry the slim index is filled from: under the record's key or, for a
  // group recorded under its new key, the earlier key its entry still has.
  const signature = record.entrySignature ? [record.signature, record.entrySignature] : record.signature;
  if (index) index[SLIM_INDEX_SOURCE] = { codexHome, filePath, signature, src: record.src, cacheOptions };
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
    && sameSignature(a.entrySignature, b.entrySignature)
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

// Sessions with a plain rollout modified this recently are read first: the
// first pass after discovery reads nothing else (see parseCodexHomes()), so
// today's and yesterday's usage is uploaded by the first sync even when the
// whole history has to be read again. A compressed rollout does not count:
// Codex writes it when it compresses an old conversation, so its mtime is that
// day, not the conversation's.
const RECENT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The order in which a run reads sessions. `recent`: the keys of sessions with
 * a plain rollout modified since `since`. `needed(key)`: those and the parent of
 * each that is a fork or a sub-agent (its replay boundary needs the parent's
 * index). `rank(key)`: the newest plain mtime of the session (a session with
 * compressed rollouts only: when it started), raised to that of any fork or
 * sub-agent of it, so a parent goes with the newest of them.
 */
function sessionPriorities(files, sessionKey, since) {
  const recent = new Set();
  for (const file of files) {
    if (!file.compressed && file.signature.mtimeMs >= since) recent.add(sessionKey(file));
  }
  // The rest only for a run that has to read beyond pass 1 (a warm sync does not).
  let order = null;
  const build = () => {
    const ranks = new Map();
    const parentOf = new Map();
    for (const file of files) {
      const key = sessionKey(file);
      // A session known only from compressed rollouts ranks by when it started.
      const mtime = file.compressed ? (file.header?.sessionStartedAtMs ?? 0) : file.signature.mtimeMs;
      ranks.set(key, Math.max(ranks.get(key) ?? 0, mtime));
      const parentId = file.header?.forkedFromId || (file.header?.isSubagent ? file.header.parentThreadId : null);
      if (parentId && parentId !== key) parentOf.set(key, parentId);
    }
    // A fork's replay boundary needs its parent's index, not the parent's
    // own parent: reading that one in pass 2 could use up the budget the
    // fork's usage was waiting for (cross-review 2026-11-25).
    const needed = new Set(recent);
    for (const key of recent) if (parentOf.has(key)) needed.add(parentOf.get(key));
    // Chains are short; the bound only matters for a cycle in damaged headers.
    for (let changed = true, round = 0; changed && round < 32; round++) {
      changed = false;
      for (const [key, parentId] of parentOf) {
        if (ranks.has(parentId) && ranks.get(parentId) < ranks.get(key)) {
          ranks.set(parentId, ranks.get(key));
          changed = true;
        }
      }
    }
    return { ranks, needed };
  };
  return {
    recent,
    needed: key => (order ??= build()).needed.has(key),
    rank: key => (order ??= build()).ranks.get(key) ?? 0,
  };
}

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

// Model time (aggregate.js, approved 2026-11-25). A Codex reply is one model
// call: it ends at the usage record counted for it (`replyOutputTokens`, its
// output including reasoning) and starts at the latest boundary before it -- a
// task start, a user message or a tool result. Tool runs, waits for a
// sub-agent and the time between tasks lie between a boundary and the next
// reply's start, so they are never counted.
function applySessionEvent(acc, event, modelTime) {
  const timestampMsValue = event.timestamp.getTime();
  if (acc.lastTimestampMs != null && timestampMsValue < acc.lastTimestampMs) return false;
  acc.firstTimestampMs ??= timestampMsValue;
  acc.lastTimestampMs = timestampMsValue;
  acc.messageCount++;

  if (event.role === 'user') {
    acc.userMessageCount++;
    acc.userPromptHours[event.timestamp.getUTCHours()]++;
  }
  if (event.boundary) acc.lastBoundaryMs = timestampMsValue;
  if (event.replyOutputTokens !== undefined) {
    const span = replySpan(acc.lastBoundaryMs, timestampMsValue, event.replyOutputTokens, acc.prevSpanEndMs);
    if (span) {
      addModelTimeSpan(modelTime, span[0], span[1]);
      acc.prevSpanEndMs = span[1];
    }
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
        lastBoundaryMs: null,
        prevSpanEndMs: null,
        modelTime: null,
        messageCount: 0,
        userMessageCount: 0,
        userPromptHours: new Array(24).fill(0),
      };
  const modelTime = restoreModelTime(acc.modelTime);
  for (const event of sorted) {
    if (!applySessionEvent(acc, event, modelTime)) return null;
  }
  // Kept in serializable form: an append tail stores the accumulator.
  acc.modelTime = serializeModelTime(modelTime);
  return acc.sessionId ? acc : null;
}

function sessionFromAccumulator(acc) {
  if (!acc?.sessionId || acc.firstTimestampMs == null || acc.lastTimestampMs == null) return null;
  const { activeSeconds, activity } = modelTimeFields(restoreModelTime(acc.modelTime));
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
    activity,
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
      // This record's timing event, when it has one: the usage it may carry
      // below ends a reply there.
      let recordEvent = null;

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
            recordEvent = {
              sessionId: sessionKey,
              source: 'codex',
              project: sessionProject,
              timestamp: evTs,
              role: isUserTurn ? 'user' : 'assistant',
              ...(isReplyBoundary(obj) ? { boundary: true } : {}),
            };
            sessionEvents.push(recordEvent);
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
      if (recordEvent) recordEvent.replyOutputTokens = Number(usage.output_tokens) || 0;
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
    copyOf: older.copyOf,
    signature: older.signature,
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
  // Its signature carries the device number it was written under (see storedDevs()).
  file.olderEntry = { signature: older.signature };
  if (older.summary) {
    file.cache = older.summary;
    file.cacheSource = older.summary.algorithmVersion;
    return;
  }
  const header = own?.header ?? older.header;
  const index = own?.index ?? older.index;
  const copyOf = own?.copyOf ?? older.copyOf;
  if (header || index) file.cache = { ...own, header, index, ...(copyOf ? { copyOf } : {}) };
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
    && fileMeta.has(other.filePath) && sameFile(other.signature, file.signature));
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
  const currentSignatures = new Map(files.filter(file => !file.members).map(file => [file.filePath, file.signature]));
  for (const file of files) {
    const records = next.get(file.codexHome);
    if (!records) continue;
    const previous = manifests.get(file.codexHome).get(file.filePath);
    const recordableSource = file.cacheSource === CODEX_PARSER_ALGORITHM_VERSION
      || (file.cacheSource != null && olderEntryRecordable(file.cacheSource));
    const usable = !!file.cache && recordableSource && (file.cache.result
      || (!file.members && file.cacheSource === CODEX_PARSER_ALGORITHM_VERSION && file.cache.header && file.cache.index));
    // A group's state has more than one key (stateSignatures(): its current
    // one and those of the earlier format).
    const changedSinceRecorded = file.cacheWritten && previous
      && !signatureMatches(previous.signature, file.stateSignatures?.() ?? file.signature);
    if (usable && !changedSinceRecorded) {
      const boundaryParent = 'boundaryParent' in file ? file.boundaryParent : file.manifestRecord?.boundaryParent;
      // A group record that still matches in the earlier format under the
      // current device number keeps that key while its entry is not rewritten:
      // a 0.15.x collector running next to this one reads the same manifest,
      // and with the key changed back and forth each would rewrite every group
      // record on every run. One that matched only under an earlier device
      // number (an older collector cannot match it anyway) is recorded under
      // the current key, with the key its entry still has.
      const signature = !file.cacheWritten && file.recordSignature ? file.recordSignature : file.signature;
      const entrySignature = !file.cacheWritten && file.entrySignature && !sameSignature(file.entrySignature, signature)
        ? file.entrySignature : undefined;
      // A proven copy names its plain twin with the twin's signature as it is
      // now: a record that took a new device number while its `copyOf` kept
      // the old one is one a 0.15.x collector accepts but whose copy it then
      // rejects, putting the compressed file back into the group's key -- and
      // the two collectors would rewrite that group on every run.
      let cache = file.cache;
      const twin = cache.copyOf && currentSignatures.get(cache.copyOf.filePath);
      if (twin && twin.dev !== cache.copyOf.signature?.dev && sameSignature(twin, cache.copyOf.signature)) {
        cache = { ...cache, copyOf: { ...cache.copyOf, signature: twin } };
      }
      records.set(file.filePath, manifestRecord(cache, signature, file.cacheSource, boundaryParent ?? undefined,
        file.filePath, parentIds.has(cache.header?.sessionId), entrySignature));
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
  // machine) only gets BACKLOG_SHARE of the budget.
  //
  // Recent sessions first (2026-11-25). The rest of the run goes in three
  // passes over the same three phases (replay indexes, duplicate-session
  // groups, usage); each pass may read only some rollouts, and every session
  // takes what the cache has in the first. Pass 1 reads plain rollouts of
  // sessions with a plain rollout modified in the last RECENT_WINDOW_MS. Pass 2
  // reads what those sessions still lack -- the parent of a fork or sub-agent,
  // a compressed copy -- and nothing else, so history cannot hold them up.
  // Pass 3 reads the rest, newest sessions first (a parent with its newest
  // fork or sub-agent). Without this, a cache that had to be rebuilt -- on the
  // maintainer's Mac after the reboot of 2026-11-25, or any cold start: 26,299
  // rollouts in three homes, headers read in 15 s -- spent the rest of every
  // run indexing history in directory order, and the first run ended with none
  // of them done and nothing to upload. Nothing a pass computes
  // depends on the order: results are assembled in the order one pass over
  // every file would produce them, so a history read over many runs ends with
  // exactly the output of one uninterrupted run.
  const sessionKey = file => file.header?.sessionId || `\u0000${file.filePath}`;
  const involvesCompressed = file => file.compressed || !!file.members?.some(member => member.compressed);
  const { recent, needed, rank } = sessionPriorities(files, sessionKey, Date.now() - RECENT_WINDOW_MS);
  // `limited`: compressed reads only within BACKLOG_SHARE. Not in pass 2:
  // what it reads is for the conversations in use. `usage`: whose own usage a
  // pass may read. Pass 2 builds a parent's replay index (and merges its
  // copies) for its forks, but leaves the parent's own usage to pass 3: read
  // between two forks of it, a large compressed parent could use up the
  // budget the second fork was waiting for (cross-review round 3).
  const passes = [
    { mayRead: item => recent.has(sessionKey(item)) && !involvesCompressed(item), limited: false },
    { mayRead: item => needed(sessionKey(item)), usage: item => recent.has(sessionKey(item)), limited: false },
    { mayRead: () => true, limited: true },
  ];
  const backlogBudget = budget * BACKLOG_SHARE;
  const physicalFiles = [...files];
  // Only for sorting after pass 1.
  let positions = null;
  const position = file => (positions ??= new Map(physicalFiles.map((f, i) => [f, i]))).get(file);
  let groupPositions = null;
  const groupPosition = id => (groupPositions ??= new Map([...duplicateIds].map((d, i) => [d, i]))).get(id);
  const byPriority = (key, place) => (a, b) => rank(key(b)) - rank(key(a))
    || involvesCompressed(a) - involvesCompressed(b) || place(a) - place(b);
  // Pass 1 keeps the order a single pass always had: plain rollouts, then
  // compressed ones (so a compressed copy can take a plain twin's index), each
  // in directory order. It reads only recent plain rollouts, and a warm sync --
  // nothing to read, so it ends after pass 1 -- would only pay for sorting.
  // Passes 2 and 3 go newest first, plain before compressed within a session.
  const plainFirst = [...physicalFiles.filter(file => !file.compressed), ...physicalFiles.filter(file => file.compressed)];
  let newestFirst = null;
  const indexOrder = first => (first ? plainFirst
    : newestFirst ??= [...physicalFiles].sort(byPriority(sessionKey, position)));

  // Device numbers the stored signatures carry: a group entry or a parent
  // state written before 2026-11-25 can only be recomputed for the device
  // number its members had then (see legacyCodexSegmentSignature()). Mostly
  // one or two; bounded in any case.
  let knownDevs = null;
  const storedDevs = () => {
    if (knownDevs) return knownDevs;
    const devCounts = new Map();
    const noteDev = dev => {
      if (typeof dev === 'string' && dev !== 'codex-segments') devCounts.set(dev, (devCounts.get(dev) || 0) + 1);
    };
    for (const records of manifests.values()) for (const record of records.values()) noteDev(record?.signature?.dev);
    for (const file of files) {
      for (const stored of [file.cache, file.priorCache, file.priorTail, file.olderEntry]) noteDev(stored?.signature?.dev);
    }
    return knownDevs = [...devCounts].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([dev]) => dev);
  };
  // [0] under the members' current device number (what an earlier release
  // computes now), then under each earlier one.
  const legacyDevs = members => {
    const devs = new Set(members.map(member => member.signature.dev));
    if (devs.size !== 1) return [null];
    const [current] = devs;
    return [current, ...storedDevs().filter(dev => dev !== current)];
  };
  // A group's earlier keys, each hashed only when asked for: a warm sync whose
  // records are still in the earlier format matches the first one (the current
  // device number) for almost every group, and hashing them all cost ~0.1 s.
  // `match(stored)`: the index of the earlier key a stored signature is, or -1
  // (no hashing at all when its size or mtime already differ).
  const legacyKeys = (members, current) => {
    let devs = null;
    const candidates = () => devs ??= legacyDevs(members);
    const keys = [];
    const at = i => keys[i] ??= legacyCodexSegmentSignature(members, candidates()[i]);
    return {
      count: () => candidates().length,
      at,
      all: () => candidates().map((_, i) => at(i)),
      match(stored) {
        if (stored?.size !== current.size || stored?.mtimeMs !== current.mtimeMs) return -1;
        for (let i = 0; i < candidates().length; i++) if (sameSignature(stored, at(i))) return i;
        return -1;
      },
    };
  };

  const indexMeta = new Map(); // physical rollout -> its header, or its full replay index
  const indexDone = new Set(); // physical rollouts the index phase is finished with
  const needsIndex = new Set();
  const groups = new Map();
  const groupLookups = new Map();
  const resultByFile = new Map();
  const filesByPath = new Map(files.map(file => [file.filePath, file]));
  let auditGroupId = null;
  let pendingPaths = new Set();
  let pendingIds = new Set();
  let pendingPhase = null;

  // A parent's state as a summary was checked against it: its file (a group:
  // its key) and the index used. legacyParentStateMatch() recognizes the same
  // state as earlier releases wrote it -- with the device number, and a group's
  // earlier key -- 0 under the current device number.
  const replayParentState = parent => {
    const signature = filesByPath.get(parent.filePath)?.signature;
    const digest = replayIndexDigest(parent);
    return signature && digest
      ? `${parent.filePath}\u0000${signature.size}:${signature.mtimeMs}:${signature.ino}\u0000${digest}`
      : null;
  };
  // The index of the earlier form `recorded` is, or -1.
  const legacyParentStateMatch = (parent, recorded) => {
    const parentFile = filesByPath.get(parent.filePath);
    const digest = replayIndexDigest(parent);
    const head = `${parent.filePath}\u0000`;
    const tail = `\u0000${digest}`;
    if (!parentFile || !digest || !recorded.startsWith(head) || !recorded.endsWith(tail)) return -1;
    const devs = parentFile.members ? null : legacyDevs([parentFile]);
    const count = parentFile.members ? parentFile.legacyKeys.count() : devs.length;
    for (let i = 0; i < count; i++) {
      const s = parentFile.members
        ? parentFile.legacyKeys.at(i)
        : { ...parentFile.signature, dev: devs[i] ?? parentFile.signature.dev };
      if (recorded === `${head}${s.size}:${s.mtimeMs}:${s.dev}:${s.ino}${tail}`) return i;
    }
    return -1;
  };

  for (const { mayRead, usage = mayRead, limited } of passes) {
    const first = mayRead === passes[0].mayRead;
    // A pass that left nothing for later is the last: a warm sync makes one.
    if (pendingPhase !== null || pendingPaths.size > 0 || pendingIds.size > 0) {
      pendingPaths = new Set();
      pendingIds = new Set();
      pendingPhase = null;
    } else if (!first) {
      break;
    }
    // May this pass read these rollouts (or merge these groups) now?
    const withinBudget = items => Date.now() - startedAt < (limited && items.some(involvesCompressed) ? backlogBudget : budget);
    const canRead = (...items) => items.every(mayRead) && withinBudget(items);
    const canReadUsage = file => usage(file) && withinBudget([file]);
    const leaveForNextRun = file => {
      pendingPaths.add(file.filePath);
      if (file.header?.sessionId) pendingIds.add(file.header.sessionId);
    };

    // Only replay participants, their parents, corrupt-header files, and
    // duplicate physical copies need the full compact token index.
    for (const file of indexOrder(first)) {
      if (indexDone.has(file.filePath)) continue;
      const header = file.header;
      const required = !header
        || !header.sessionId
        || header.isSubagent
        || header.forkedFromId != null
        || header.parentThreadId != null
        || referencedParentIds.has(header.sessionId)
        || duplicateIds.has(header.sessionId);
      if (!required) {
        indexMeta.set(file.filePath, { ...header, filePath: file.filePath });
        indexDone.add(file.filePath);
        continue;
      }
      needsIndex.add(file.filePath);
      const sameSession = header?.sessionId ? candidatesById.get(header.sessionId) : [];
      let meta = auditPaths.has(file.filePath) ? null : file.cache?.index;
      if (meta) {
        cacheStats.indexHits++;
      } else if (!auditPaths.has(file.filePath) && (meta = linkedIndex(file, sameSession, indexMeta, needsIndex))) {
        // A hard link of a file already indexed: no read.
        updateFileCache(file, { index: meta });
      } else if (!canRead(file)) {
        leaveForNextRun(file);
        pendingPhase ??= 'replay-index';
        continue;
      } else {
        try {
          const copy = auditPaths.has(file.filePath) ? null
            : await indexFromCompressedCopy(file, sameSession, indexMeta, needsIndex);
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
          indexDone.add(file.filePath);
          continue;
        }
      }
      indexMeta.set(file.filePath, meta);
      indexDone.add(file.filePath);
    }

    // Duplicate ids can be disjoint continuation segments, not just archives.
    // Keep physical caches intact and give each combined session its own cache.
    const plans = [];
    for (const id of duplicateIds) {
      if (groups.has(id)) continue;
      const members = candidatesById.get(id);
      if (members.some(file => pendingPaths.has(file.filePath))) continue;
      if (members.some(file => !indexMeta.has(file.filePath))) {
        return { buckets: [], sessions: [], skipped: true,
          warnings: ['codex: 同一会话的部分文件读取失败，已保留上次同步数据'] };
      }
      members.sort((a, b) => (indexMeta.get(b.filePath).parsedRecordCount || 0)
        - (indexMeta.get(a.filePath).parsedRecordCount || 0) || a.filePath.localeCompare(b.filePath));
      // `identity` names the group's cache entry, `read` is what the merge reads.
      plans.push({ id, members, ...planCodexSegments(members) });
    }
    // Groups merged from plain files only first (see BACKLOG_SHARE); after
    // pass 1, newest first before that. The output keeps the order of
    // duplicateIds.
    const plainOnly = plan => !plan.read.some(file => file.compressed);
    // A stable sort: ties keep the order of duplicateIds.
    plans.sort(first ? (a, b) => plainOnly(b) - plainOnly(a)
      : (a, b) => rank(b.id) - rank(a.id) || plainOnly(b) - plainOnly(a));
    for (const { id, members, identity, read } of plans) {
      const selected = identity[0];
      const filePath = `${selected.codexHome}/.vibe-usage-session-${createHash('sha256').update(id).digest('hex')}`;
      const signature = codexSegmentSignature(identity);
      // The keys earlier releases gave this state (see legacyCodexSegmentSignature()).
      const legacy = legacyKeys(identity, signature);
      // Same order as startingCache(), without step 2: a group has no append tail.
      // An older group entry is taken whole or not at all: when its summary is not
      // exact under the cut the members are merged again anyway, and indexing the
      // merged records costs no further read.
      // A manifest record for exactly this group state stands for either stop.
      // Under the current key or an earlier one: an entry written under an
      // earlier key is used as it is, never rewritten just to change its key
      // (a 0.15.x collector still running reads the same entries).
      let lookup = groupLookups.get(id);
      if (!lookup && !members.some(file => auditPaths.has(file.filePath))) {
        lookup = { cache: null, cacheSource: null, manifestRecord: null, entrySignature: null, recordSignature: null };
        const record = manifests.get(selected.codexHome)?.get(filePath);
        const usable = keys => manifestRecordUsable(record, keys, cacheOptions, ultrafastStartMs, { group: true });
        const current = usable(signature);
        const earlier = current || !record ? -1 : legacy.match(record.signature);
        if (current || (earlier >= 0 && usable(record.signature))) {
          lookup.cache = cacheFromManifestRecord(record, selected.codexHome, filePath, cacheOptions);
          // Its full index is filled from the entry under the record's key, the
          // one the record says the entry has, or an earlier one -- a 0.15.x
          // collector running alongside rewrites the entry under the earlier key
          // for the current device number.
          const source = lookup.cache.index?.[SLIM_INDEX_SOURCE];
          if (source) {
            const recorded = [].concat(source.signature);
            source.signature = () => [...recorded, ...legacy.all()];
          }
          lookup.cacheSource = record.src;
          lookup.manifestRecord = record;
          lookup.entrySignature = record.entrySignature ?? record.signature;
          if (earlier === 0) lookup.recordSignature = record.signature;
          cacheStats.manifestHits++;
        } else {
          const keys = [signature, ...legacy.all()];
          const own = loadCodexFileCache(selected.codexHome, filePath, keys);
          const older = own?.result ? null
            : olderEntryFor(selected.codexHome, filePath, keys, cacheOptions, ultrafastStartMs)?.summary;
          lookup.cache = own?.result ? own : older || own;
          lookup.cacheSource = own?.result ? CODEX_PARSER_ALGORITHM_VERSION : older ? older.algorithmVersion : null;
          lookup.entrySignature = lookup.cache?.signature ?? null;
        }
        groupLookups.set(id, lookup);
      }
      let { cache = null, cacheSource = null, manifestRecord = null } = lookup || {};
      // A compressed member's file size says nothing about the text it holds, so
      // a group with one is not audited (see auditSize()). The group picked is
      // picked again by a later pass, which reads it if an earlier one could not.
      if (cache?.result && (auditGroupId === id || (auditGroupId === null && auditPaths.size === 0
        && !read.some(file => file.compressed)
        && signature.size <= auditMaxBytes()
        && (cache.lastAuditedAt || 0) <= Date.now() - auditIntervalMs()))) {
        if (auditGroupId === null) cacheStats.audited++;
        auditGroupId = id;
        cache = null;
        cacheSource = null;
        manifestRecord = null;
      }
      const group = { ...selected, filePath, signature, snapshotSize: signature.size,
        compressed: false, cache, members: read, lines: null, appendTail: null, priorTail: null,
        cacheSource, manifestRecord, cacheWritten: false,
        legacyKeys: legacy, stateSignatures: () => [signature, ...legacy.all()],
        entrySignature: cache ? lookup?.entrySignature ?? null : null,
        recordSignature: manifestRecord ? lookup?.recordSignature ?? null : null };
      delete group.boundaryParent;
      let meta = cache?.index;
      if (meta) {
        cacheStats.indexHits++;
      } else if (!canRead(group)) {
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
      group.meta = meta;
      needsIndex.add(filePath);
      groups.set(id, group);
      filesByPath.set(filePath, group);
    }

    // What the usage phase works on: every rollout whose session has no other
    // copy, and the group of every session that has.
    const usageFiles = [
      ...physicalFiles.filter(file => !duplicateIds.has(file.header?.sessionId) && indexMeta.has(file.filePath)),
      ...[...duplicateIds].filter(id => groups.has(id)).map(id => groups.get(id)),
    ];
    const metaOf = file => (file.members ? file.meta : indexMeta.get(file.filePath));

    // One index per logical session, including all continuation segments, feeds
    // the unchanged fork/subagent replay boundary logic.
    const sessionById = new Map();
    for (const file of usageFiles) {
      const meta = metaOf(file);
      if (!meta?.sessionId) continue;
      const existing = sessionById.get(meta.sessionId);
      const count = meta.parsedRecordCount ?? 0;
      const existingCount = existing?.parsedRecordCount ?? 0;
      if (!existing || count > existingCount) sessionById.set(meta.sessionId, meta);
    }

    const leftOut = file => {
      // A group stands for its members; a physical file for itself.
      for (const path of (file.members ? candidatesById.get(file.header.sessionId) : [file]).map(f => f.filePath)) {
        pendingPaths.add(path);
      }
      pendingPhase ??= 'usage';
    };
    const usagePlace = file => (file.members ? physicalFiles.length + groupPosition(file.header.sessionId) : position(file));
    for (const file of first ? usageFiles : [...usageFiles].sort(byPriority(sessionKey, usagePlace))) {
      if (resultByFile.has(file)) continue;
      const fm = metaOf(file);
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
      // is needed. A state recorded as an earlier release wrote it is the same
      // state: kept as written while it still matches under the current device
      // number (an older collector running alongside reads it too), recorded in
      // the current form once it matches only under an earlier one.
      const parentId = needsIndex.has(file.filePath)
        ? (fm.forkedFromId || (fm.isSubagent ? fm.parentThreadId : null))
        : null;
      const parent = parentId ? sessionById.get(parentId) : null;
      let parentState = parent ? replayParentState(parent) : null;
      let recordedState = null;
      const recorded = file.manifestRecord?.boundaryParent;
      if (parentState && recorded) {
        if (recorded === parentState) {
          recordedState = parentState;
        } else {
          const at = legacyParentStateMatch(parent, recorded);
          if (at === 0) recordedState = recorded;
          else if (at > 0) recordedState = parentState;
        }
      }
      let boundary = null;
      let key;
      if (recordedState && !auditPaths.has(file.filePath)
        && file.cache?.result && summaryMatchesCut(file.cache.result, ultrafastStartMs)) {
        key = file.cache.result.boundaryKey;
        parentState = recordedState;
      } else {
        if (parent) {
          // Filled from their entries if possible; a full index that has to be
          // built from the rollout again counts against the budget like any read.
          const parentFile = filesByPath.get(parent.filePath);
          if ((!fillFullIndex(fm) || !fillFullIndex(parent)) && !canRead(...[file, parentFile].filter(Boolean))) {
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
      } else if (!canReadUsage(file)) {
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
      resultByFile.set(file, result);
    }
  }

  for (const id of duplicateIds) if (groups.has(id)) files.push(groups.get(id));
  // In the order one pass over every file produces them.
  const results = files.filter(file => resultByFile.has(file)).map(file => resultByFile.get(file));
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
