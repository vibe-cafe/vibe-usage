import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, basename, sep } from 'node:path';
import {
  accumulateSessionEvent,
  aggregateToBuckets,
  createSessionAccumulator,
  extractSessions,
  finalizeSessionAccumulator,
  sessionAccumulatorIsOrdered,
} from './aggregate.js';
import { projectFromCwd, toCount } from './fs-utils.js';
import { getClaudeRoots } from '../claude-roots.js';
import {
  claudeCacheEnabled,
  fileSignature,
  loadClaudeFileCache,
  pruneClaudeFileCache,
  saveClaudeFileCache,
} from './claude-cache.js';

const MAX_WARNINGS = 20;
const READ_CHUNK_BYTES = 1024 * 1024;
const GUARD_BYTES = 4096;
const TIMING_TYPES = new Set(['user', 'assistant', 'tool_use', 'tool_result']);

function addWarning(ctx, message) {
  ctx.incomplete = true;
  if (ctx.warnings.length < MAX_WARNINGS) ctx.warnings.push(message);
}

/** Recursively collect JSONL files without making one unreadable branch fatal. */
function findJsonlFiles(dir, ctx) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      addWarning(ctx, `Claude Code: cannot read directory ${dir}: ${err.message}`);
    }
    return [];
  }

  const results = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const nested of findJsonlFiles(fullPath, ctx)) results.push(nested);
    } else if (entry.name.endsWith('.jsonl')) {
      results.push(fullPath);
    }
  }
  return results;
}

function projectRelativePath(filePath, projectsDir) {
  const prefix = projectsDir + sep;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : null;
}

/** Best-effort fallback for old records without cwd. */
function projectFromRelative(relative) {
  if (!relative) return 'unknown';
  const firstSegment = relative.split(sep)[0];
  if (!firstSegment) return 'unknown';
  const parts = firstSegment.split('-').filter(Boolean);
  return parts.at(-1) || 'unknown';
}

/**
 * Cache-creation (prompt-cache write) tokens, split by TTL.
 *
 * Anthropic bills the two TTLs at different multiples of the base input rate
 * (5-minute writes 1.25x, 1-hour writes 2x — platform.claude.com/docs/en/
 * about-claude/pricing), so the split is a price-changing dimension and has to
 * survive to the server. Folding both into `input_tokens` (what this parser did
 * before 2026-09-16) under-billed every Claude bucket by 13-33%.
 *
 * Current Claude logs carry both the `cache_creation_input_tokens` total and its
 * `cache_creation` TTL breakdown. When the breakdown is missing, or adds up to
 * less than the total, the unexplained remainder is booked to the **5m** bucket:
 * that is the cheaper of the two multipliers, so a partially populated log can
 * only ever under-state cost, never over-state it. This preserves the old
 * max(direct, split) total exactly — only its attribution is new.
 */
function cacheCreationSplit(usage) {
  const direct = toCount(usage.cache_creation_input_tokens);
  const breakdown = usage.cache_creation || {};
  const fiveMinute = toCount(breakdown.ephemeral_5m_input_tokens);
  const oneHour = toCount(breakdown.ephemeral_1h_input_tokens);
  const split = fiveMinute + oneHour;
  if (split >= direct) return { fiveMinute, oneHour };
  return { fiveMinute: fiveMinute + (direct - split), oneHour };
}

// Fast mode (research preview, Claude Opus 5 / Opus 4.8) is billed at 2x the
// standard input and output rate, with the cache multipliers stacking on top.
// Claude Code records it as `message.usage.speed` ('standard' | 'fast'); accept
// `message.speed` too so a build that moves the field keeps working. The server
// pricing map keys the premium rate off a trailing `-fast` marker
// (TIER_MARKER_SUFFIX -> tiers.priority), so tag the model here. A model with no
// published priority tier falls back to its base rate server-side, which makes
// the marker safe to append unconditionally.
function isFastMode(usage, message) {
  const speed = usage?.speed ?? message?.speed;
  return typeof speed === 'string' && speed.trim().toLowerCase() === 'fast';
}

function applySpeedMarker(model, fast) {
  if (!fast || !model) return model;
  return model.endsWith('-fast') ? model : `${model}-fast`;
}

function candidateIsBetter(next, current) {
  if (!current) return true;
  if (next.size !== current.size) return next.size > current.size;
  if (next.mtimeMs !== current.mtimeMs) return next.mtimeMs > current.mtimeMs;
  return next.filePath.localeCompare(current.filePath) < 0;
}

/**
 * Group physical files by logical session id and keep candidates ordered by
 * completeness. A session copied between ~/.claude and CLAUDE_CONFIG_DIR must
 * use its largest/newest copy, not whichever root happened to be scanned first.
 */
function collectCandidates(roots, directoryName, ctx) {
  const groups = new Map();
  for (const root of roots) {
    const baseDir = join(root, directoryName);
    for (const filePath of findJsonlFiles(baseDir, ctx)) {
      let stat;
      try {
        stat = statSync(filePath);
      } catch (err) {
        addWarning(ctx, `Claude Code: cannot stat ${filePath}: ${err.message}`);
        continue;
      }
      const sessionId = basename(filePath, '.jsonl');
      const relative = projectRelativePath(filePath, baseDir);
      const candidate = {
        filePath,
        sessionId,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        signature: fileSignature(stat),
        fallbackProject: directoryName === 'projects'
          ? projectFromRelative(relative)
          : 'unknown',
      };
      const group = groups.get(sessionId) || [];
      group.push(candidate);
      groups.set(sessionId, group);
    }
  }
  for (const group of groups.values()) {
    group.sort((a, b) => candidateIsBetter(a, b) ? -1 : candidateIsBetter(b, a) ? 1 : 0);
  }
  return groups;
}

function emitLine(line, onObject) {
  if (!line.trim()) return;
  try {
    onObject(JSON.parse(line));
  } catch {
    // Claude may be appending the final JSONL record while we snapshot it.
    // A later sync will see the complete line; malformed historical lines
    // are isolated instead of taking the whole parser down.
  }
}

/**
 * Feed the newline-terminated JSONL lines in bytes [start, end) to onObject.
 *
 * Lines are split on raw 0x0a bytes and decoded one at a time: readline's
 * per-line stream decoding cost more than JSON.parse itself on a 15.6 GB
 * history (26s vs 13s). `parsedBytes` is the offset just past the last newline,
 * which is where a later read can resume. A final segment without a newline is
 * returned undecided in `trailing`: Claude may still be appending it. When
 * `shouldStop()` turns true after a chunk that completed at least one line, the
 * read stops early with `stopped: true`.
 */
async function readJsonlRange(filePath, start, end, onObject, shouldStop = null) {
  const result = { parsedBytes: start, trailing: null, stopped: false };
  if (end <= start) return result;
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, end - start));
    let pending = [];
    let position = start;
    while (position < end) {
      const { bytesRead } = await handle.read(
        buffer, 0, Math.min(buffer.length, end - position), position,
      );
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      let lineStart = 0;
      let newline;
      while ((newline = chunk.indexOf(0x0a, lineStart)) !== -1) {
        let line;
        if (pending.length) {
          pending.push(chunk.subarray(lineStart, newline));
          line = Buffer.concat(pending).toString('utf8');
          pending = [];
        } else {
          line = chunk.toString('utf8', lineStart, newline);
        }
        emitLine(line, onObject);
        lineStart = newline + 1;
        result.parsedBytes = position + lineStart;
      }
      // The buffer is reused by the next read; keep a copy of the partial line.
      if (lineStart < bytesRead) pending.push(Buffer.from(chunk.subarray(lineStart)));
      position += bytesRead;
      if (shouldStop && position < end && result.parsedBytes > start && shouldStop()) {
        result.stopped = true;
        return result;
      }
    }
    if (pending.length) result.trailing = Buffer.concat(pending).toString('utf8');
  } finally {
    await handle.close();
  }
  return result;
}

/** Read the whole captured size, final unterminated line included. */
async function readJsonl(candidate, onObject) {
  const { trailing } = await readJsonlRange(candidate.filePath, 0, candidate.size, onObject);
  if (trailing !== null) emitLine(trailing, onObject);
}

function timingEvent(obj, sessionId, project) {
  if (!TIMING_TYPES.has(obj.type)) return null;
  if (!obj.timestamp) return null;
  const timestamp = new Date(obj.timestamp);
  if (Number.isNaN(timestamp.getTime())) return null;
  return {
    sessionId,
    source: 'claude-code',
    project,
    timestamp,
    role: obj.type === 'user' ? 'user' : 'assistant',
  };
}
async function collectTimingEvents(candidate, projectForObject) {
  const events = [];
  await readJsonl(candidate, (obj) => {
    const event = timingEvent(
      obj,
      candidate.sessionId,
      projectForObject(obj),
    );
    if (event) events.push(event);
  });
  return events;
}

async function finalizeCandidateSession(
  candidate,
  accumulator,
  projectForObject,
  projectOverride,
) {
  if (sessionAccumulatorIsOrdered(accumulator)) {
    return finalizeSessionAccumulator(
      accumulator,
      candidate.sessionId,
      projectOverride,
    );
  }

  // JSONL is normally append-ordered. Preserve the old sort semantics for an
  // unusual copied/rewritten file without retaining every event on the common
  // path: re-read only that candidate and let extractSessions() sort it.
  const events = await collectTimingEvents(candidate, projectForObject);
  return extractSessions(events)[0] || null;
}

// ---------------------------------------------------------------------------
// Project transcripts: one resumable scan state per physical file.
//
// Everything a session file contributes is kept in a compact state that can be
// saved to the parser cache and later continued from the byte where it stopped.
// An unchanged transcript is then not opened at all, an appended one is read
// only from its last complete line, and a cold build can checkpoint mid-file.
// ---------------------------------------------------------------------------

function createScanState(fallbackProject) {
  return {
    fallbackProject,
    sessionProject: fallbackProject,
    foundSessionCwd: false,
    lastModel: null,
    // dedupeKey -> usage record, in first-seen order (Map.set on an existing
    // key keeps its position, exactly like the entry map this replaced).
    keyed: new Map(),
    anonymous: [],
    // Every timing event as [ms, isUser] pairs, flattened. Sessions need all of
    // them, sorted, whenever a file is out of order — 263 of 2,487 transcripts
    // (10.1 of 15.6 GB) on one heavy account — so an appended file cannot be
    // finished from a running accumulator alone.
    events: [],
    // Every top-level requestId, for Magpie bridge matching. Kept even when
    // Magpie is inactive so the cache does not depend on the Magpie context.
    requestIds: new Set(),
  };
}

function usageScore(record) {
  // Unchanged from when cache writes lived inside inputTokens, so the
  // "keep the most complete duplicate" ranking keeps its old ordering.
  return record.input + record.output + record.cached + record.c5m + record.c1h;
}

function mergeRecord(state, dedupeKey, record) {
  if (!dedupeKey) {
    state.anonymous.push(record);
    return;
  }
  const current = state.keyed.get(dedupeKey);
  // Claude sometimes copies the same record into another session with zeroed
  // usage. Keep the most complete payload, independent of directory order.
  if (!current || record.score > current.score) state.keyed.set(dedupeKey, record);
}

function scanProjectLine(state, obj) {
  if (typeof obj.requestId === 'string') state.requestIds.add(obj.requestId);
  // cwd can change after Claude runs `cd`; project attribution should remain
  // the directory where this session started, not fragment into subfolders.
  if (!state.foundSessionCwd && typeof obj.cwd === 'string' && obj.cwd.trim()) {
    state.sessionProject = projectFromCwd(obj.cwd, state.fallbackProject);
    state.foundSessionCwd = true;
  }
  if (!TIMING_TYPES.has(obj.type) || !obj.timestamp) return;
  const ms = new Date(obj.timestamp).getTime();
  if (Number.isNaN(ms)) return;
  state.events.push(ms, obj.type === 'user' ? 1 : 0);

  if (obj.type !== 'assistant' || !obj.message?.usage) return;
  const usage = obj.message.usage;
  const rawModel = typeof obj.message.model === 'string'
    ? obj.message.model.trim()
    : '';
  if (rawModel && rawModel !== '<synthetic>') state.lastModel = rawModel;
  const baseModel = rawModel && rawModel !== '<synthetic>'
    ? rawModel
    : state.lastModel || 'claude-unknown';
  const fast = isFastMode(usage, obj.message);
  const cacheCreation = cacheCreationSplit(usage);
  const record = {
    model: applySpeedMarker(baseModel, fast),
    ms,
    input: toCount(usage.input_tokens),
    output: toCount(usage.output_tokens),
    cached: toCount(usage.cache_read_input_tokens),
    c5m: cacheCreation.fiveMinute,
    c1h: cacheCreation.oneHour,
    responseId: obj.message.id ?? null,
    fast,
  };
  record.score = usageScore(record);
  // Synthetic bookkeeping messages are common and carry zero usage. Do not
  // inflate the CLI's bucket count with rows the server will discard anyway.
  if (record.score === 0) return;
  mergeRecord(state, usageDedupeKey(obj), record);
}

const recordToArray = (r) => [r.model, r.ms, r.input, r.output, r.cached, r.c5m, r.c1h,
  r.responseId, r.fast ? 1 : 0];

function recordFromArray([model, ms, input, output, cached, c5m, c1h, responseId, fast]) {
  const record = { model, ms, input, output, cached, c5m, c1h, responseId, fast: fast === 1 };
  record.score = usageScore(record);
  return record;
}

function serializeState(state) {
  return {
    fallbackProject: state.fallbackProject,
    sessionProject: state.sessionProject,
    foundSessionCwd: state.foundSessionCwd,
    lastModel: state.lastModel,
    keyed: [...state.keyed].map(([key, record]) => [key, ...recordToArray(record)]),
    anonymous: state.anonymous.map(recordToArray),
    events: state.events,
    requestIds: [...state.requestIds],
  };
}

function restoreState(saved) {
  const state = createScanState(saved.fallbackProject);
  state.sessionProject = saved.sessionProject;
  state.foundSessionCwd = saved.foundSessionCwd;
  state.lastModel = saved.lastModel;
  for (const [key, ...fields] of saved.keyed) state.keyed.set(key, recordFromArray(fields));
  state.anonymous = saved.anonymous.map(recordFromArray);
  state.events = saved.events;
  state.requestIds = new Set(saved.requestIds);
  return state;
}

/**
 * The same session the old streaming accumulator produced: in file order when
 * the file is ordered, otherwise after the stable timestamp sort that used to
 * need a second read of the file.
 */
function sessionFromState(state, sessionId) {
  const events = [];
  for (let i = 0; i < state.events.length; i += 2) {
    events.push({
      sessionId,
      source: 'claude-code',
      project: state.sessionProject,
      timestamp: new Date(state.events[i]),
      role: state.events[i + 1] === 1 ? 'user' : 'assistant',
    });
  }
  return extractSessions(events)[0] || null;
}

function usageEntriesFromState(state, collectMagpie) {
  const toEntry = (record, dedupeKey) => ({
    dedupeKey,
    usageScore: record.score,
    source: 'claude-code',
    model: record.model,
    // A cwd can appear after initial metadata/messages; every entry of the
    // session carries the project the session finally resolved to.
    project: state.sessionProject,
    timestamp: new Date(record.ms),
    inputTokens: record.input,
    outputTokens: record.output,
    cachedInputTokens: record.cached,
    reasoningOutputTokens: 0,
    cacheCreation5mTokens: record.c5m,
    cacheCreation1hTokens: record.c1h,
    ...(collectMagpie ? { magpie: { responseId: record.responseId, fast: record.fast,
      counts: [record.input, record.output, record.cached, record.c5m + record.c1h] } } : {}),
  });
  const entriesByKey = new Map();
  for (const [key, record] of state.keyed) entriesByKey.set(key, toEntry(record, key));
  return {
    entriesByKey,
    anonymousEntries: state.anonymous.map((record) => toEntry(record, null)),
  };
}

function scanResult(state, session, collectMagpie) {
  return {
    usageEntries: usageEntriesFromState(state, collectMagpie),
    session,
    requestIds: collectMagpie ? state.requestIds : null,
  };
}

function readGuard(filePath, offset) {
  const length = Math.min(offset, GUARD_BYTES);
  const buffer = Buffer.allocUnsafe(length);
  const fd = openSync(filePath, 'r');
  try {
    if (readSync(fd, buffer, 0, length, offset - length) !== length) return null;
  } finally {
    closeSync(fd);
  }
  return {
    hash: createHash('sha256').update(buffer).digest('base64url').slice(0, 22),
    endsWithNewline: buffer[length - 1] === 0x0a,
  };
}

function sameSignature(a, b) {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.dev === b.dev && a.ino === b.ino;
}

/**
 * May this file continue from the cached offset? Only when it is the same
 * inode, has not shrunk or gone back in time, and the 4 KiB before the offset
 * (ending in a newline) are byte-for-byte what was parsed. Claude Code only
 * appends to a transcript; anything else is read again from the start.
 */
function canResume(cache, candidate) {
  const prior = cache.signature;
  const now = candidate.signature;
  if (cache.state.fallbackProject !== candidate.fallbackProject) return false;
  if (prior.dev !== now.dev || prior.ino !== now.ino) return false;
  if (now.size < prior.size || now.mtimeMs < prior.mtimeMs) return false;
  if (cache.parsedBytes <= 0 || cache.parsedBytes > now.size || !cache.guardHash) return false;
  try {
    const guard = readGuard(candidate.filePath, cache.parsedBytes);
    return !!guard && guard.endsWithNewline && guard.hash === cache.guardHash;
  } catch {
    return false;
  }
}

function workBudgetMs() {
  const configured = Number(process.env.VIBE_USAGE_CLAUDE_WORK_BUDGET_MS);
  if (Number.isFinite(configured) && configured > 0) return configured;
  // Same wall as the Codex cache build: the desktop apps kill a sync at 120s,
  // so a non-interactive cold build checkpoints at 45s and the next run
  // continues. Interactive runs may finish in one go.
  if (claudeCacheEnabled() && !process.stdout.isTTY) return 45_000;
  return Number.POSITIVE_INFINITY;
}

function auditIntervalMs() {
  const configured = Number(process.env.VIBE_USAGE_CLAUDE_AUDIT_INTERVAL_MS);
  if (Number.isFinite(configured) && configured >= 0) return configured;
  return 30 * 24 * 60 * 60 * 1000;
}

// One bounded re-read per run of a transcript whose cache was last built from
// byte 0 more than 30 days ago, so a cache that drifted for any unforeseen
// reason heals over time without anyone noticing a slow sync.
const AUDIT_MAX_BYTES = 64 * 1024 * 1024;

async function scanProjectCandidate(candidate, ctx) {
  if (candidate.size === 0) return scanResult(createScanState(candidate.fallbackProject), null, ctx.collectMagpie);

  let cache = ctx.cacheEnabled ? loadClaudeFileCache(candidate.filePath) : null;
  if (cache && !ctx.audited && candidate.size <= AUDIT_MAX_BYTES
    && Date.now() - (cache.fullReadAt || 0) >= ctx.auditIntervalMs) {
    ctx.audited = true;
    cache = null;
  }
  let cachedState = null;
  if (cache) {
    try {
      cachedState = restoreState(cache.state);
    } catch {
      cache = null; // malformed entry: a miss, never a failed source
    }
  }
  if (cache && cache.parsedBytes === candidate.size && cache.session !== undefined
    && sameSignature(cache.signature, candidate.signature)
    && cache.state.fallbackProject === candidate.fallbackProject) {
    return scanResult(cachedState, cache.session, ctx.collectMagpie);
  }

  const resume = !!cache && canResume(cache, candidate);
  if (!resume && ctx.progressed && ctx.shouldStop?.()) return { stopped: true };
  const state = resume ? cachedState : createScanState(candidate.fallbackProject);
  const start = resume ? cache.parsedBytes : 0;
  const onObject = (obj) => scanProjectLine(state, obj);

  // The saved state covers exactly [0, parsedBytes): complete lines only.
  const save = (parsedBytes, completed) => {
    if (!ctx.cacheEnabled || ctx.saveFailed) return false;
    let guardHash = null;
    try {
      guardHash = readGuard(candidate.filePath, parsedBytes)?.hash ?? null;
    } catch {
      // No guard, no resume: treated like a failed write below.
    }
    const saved = !!guardHash && saveClaudeFileCache(candidate.filePath, {
      signature: candidate.signature,
      parsedBytes,
      guardHash,
      fullReadAt: resume ? cache.fullReadAt : Date.now(),
      state: serializeState(state),
      ...(completed ? { session: completed.session } : {}),
    });
    if (!saved) {
      // Stopping at the budget is only progress if the work is on disk. With
      // an unwritable cache (full disk, read-only home) every run would redo
      // and abandon the same work, so this run finishes without a budget.
      ctx.saveFailed = true;
      ctx.shouldStop = null;
    }
    return saved;
  };

  let read = await readJsonlRange(candidate.filePath, start, candidate.size, onObject, ctx.shouldStop);
  if (read.stopped && !save(read.parsedBytes, null)) {
    read = await readJsonlRange(candidate.filePath, read.parsedBytes, candidate.size, onObject);
  }
  if (read.parsedBytes > start) ctx.progressed = true;
  if (read.stopped) return { stopped: true };

  const complete = read.trailing === null;
  const session = complete ? sessionFromState(state, candidate.sessionId) : null;
  // Nothing new parsed (only a still-unterminated last line) leaves the saved
  // entry valid as it is; a completed file whose mtime moved refreshes it.
  if (read.parsedBytes > start || (complete && resume)) {
    save(read.parsedBytes, complete ? { session } : null);
  }
  if (complete) return scanResult(state, session, ctx.collectMagpie);

  // Count a final line without a newline the way the old reader did, but
  // only in this run's result, never in the saved state: Claude may still be
  // writing it, and the next run re-reads it from parsedBytes.
  emitLine(read.trailing, onObject);
  return scanResult(state, sessionFromState(state, candidate.sessionId), ctx.collectMagpie);
}

async function scanTranscriptCandidate(candidate, ctx) {
  const sessionAccumulator = createSessionAccumulator();
  const requestIds = ctx.collectMagpie ? new Set() : null;
  const projectForObject = (obj) => projectFromCwd(obj.cwd, 'unknown');
  await readJsonl(candidate, (obj) => {
    if (requestIds && typeof obj.requestId === 'string') requestIds.add(obj.requestId);
    const event = timingEvent(
      obj,
      candidate.sessionId,
      projectForObject(obj),
    );
    if (event) accumulateSessionEvent(sessionAccumulator, event);
  });
  const session = await finalizeCandidateSession(
    candidate,
    sessionAccumulator,
    projectForObject,
  );
  return { session, requestIds };
}

async function scanBestCandidate(candidates, scanner, ctx) {
  for (const candidate of candidates) {
    try {
      return await scanner(candidate, ctx);
    } catch (err) {
      addWarning(ctx, `Claude Code: cannot read ${candidate.filePath}: ${err.message}`);
    }
  }
  return null;
}

// One API call is written as several assistant lines - one per content block -
// that share `message.id`/`requestId` and repeat the same `usage` object, so a
// per-line key counts the same call once per block. Streaming also emits an
// early partial line (lower `output_tokens`) before the final one under that
// same id. Keying on the call identity collapses both, and the existing
// highest-usageScore wins rule then keeps the final, complete payload.
// Records without either id (older logs) fall back to the line uuid.
function usageDedupeKey(obj) {
  const messageId = typeof obj.message?.id === 'string' ? obj.message.id.trim() : '';
  const requestId = typeof obj.requestId === 'string' ? obj.requestId.trim() : '';
  if (messageId || requestId) return `call:${messageId}\u0000${requestId}`;
  return typeof obj.uuid === 'string' && obj.uuid ? obj.uuid : null;
}

function mergeUsageEntry(ctx, entry) {
  if (!entry.dedupeKey) {
    ctx.anonymousEntries.push(entry);
    return;
  }
  const current = ctx.entriesByKey.get(entry.dedupeKey);
  // Claude sometimes copies the same record into another session with zeroed
  // usage. Keep the most complete payload, independent of directory order.
  if (!current || entry.usageScore > current.usageScore) {
    ctx.entriesByKey.set(entry.dedupeKey, entry);
  }
}

function mergeUsageEntries(target, source) {
  for (const entry of source.anonymousEntries) mergeUsageEntry(target, entry);
  for (const entry of source.entriesByKey.values()) mergeUsageEntry(target, entry);
}

function* iterateUsageEntries(ctx) {
  for (const entry of ctx.anonymousEntries) yield entry;
  for (const entry of ctx.entriesByKey.values()) yield entry;
}

export async function parse({ extraRoots = [], magpie } = {}) {
  if (magpie?.ledgerExists === undefined) magpie?.discover();
  const startedAt = Date.now();
  const budget = workBudgetMs();
  const ctx = {
    collectMagpie: !!magpie?.ledgerExists,
    cacheEnabled: claudeCacheEnabled(),
    shouldStop: Number.isFinite(budget) ? () => Date.now() - startedAt >= budget : null,
    progressed: false,
    saveFailed: false,
    audited: false,
    auditIntervalMs: auditIntervalMs(),
    entriesByKey: new Map(),
    anonymousEntries: [],
    sessions: [],
    warnings: [],
    incomplete: false,
  };
  const roots = getClaudeRoots({
    onWarning: (message) => addWarning(ctx, message),
    extraRoots,
  }).filter((root) => {
    // On Windows readdir("file/projects") can return ENOENT rather than
    // ENOTDIR. Validate the root first so that an invalid store cannot look
    // like a successful empty scan and allow incremental state to be pruned.
    try {
      if (statSync(root).isDirectory()) return true;
      addWarning(ctx, `Claude Code: cannot read directory ${root}: not a directory`);
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        addWarning(ctx, `Claude Code: cannot read directory ${root}: ${err.message}`);
      }
    }
    return false;
  });
  const projectGroups = collectCandidates(roots, 'projects', ctx);
  const projectSessionIds = new Set();
  const parsedSessions = [];

  let completed = 0;
  for (const [sessionId, candidates] of projectGroups) {
    const parsed = await scanBestCandidate(candidates, scanProjectCandidate, ctx);
    if (parsed?.stopped) {
      // Out of budget on a cold build: progress is checkpointed in the cache.
      // A partial view must not prune upload state, so report skipped.
      return {
        buckets: [],
        sessions: [],
        skipped: true,
        indexing: { phase: 'transcripts', completed, total: projectGroups.size },
        ...(ctx.warnings.length > 0 ? { warnings: ctx.warnings } : {}),
      };
    }
    completed++;
    if (!parsed) continue;
    projectSessionIds.add(sessionId);
    parsedSessions.push(parsed);
  }
  if (ctx.cacheEnabled && !ctx.incomplete) {
    pruneClaudeFileCache([...projectGroups.values()].flat().map((c) => c.filePath));
  }

  const transcriptGroups = collectCandidates(roots, 'transcripts', ctx);
  for (const [sessionId, candidates] of transcriptGroups) {
    if (projectSessionIds.has(sessionId)) continue;
    const parsed = await scanBestCandidate(candidates, scanTranscriptCandidate, ctx);
    if (parsed) parsedSessions.push(parsed);
  }

  // Read the ledger after all transcript snapshots. A bridge match excludes
  // both tracks of the entire physical session, before cross-copy selection.
  if (ctx.collectMagpie && parsedSessions.length) magpie.prepare();
  for (const parsed of parsedSessions) {
    if (ctx.collectMagpie && magpie.isBridge(parsed.requestIds)) continue;
    if (parsed.session) ctx.sessions.push(parsed.session);
    if (parsed.usageEntries) mergeUsageEntries(ctx, parsed.usageEntries);
  }
  const entries = [...iterateUsageEntries(ctx)];

  return {
    buckets: aggregateToBuckets(ctx.collectMagpie ? magpie.attribute(entries, 'claude') : entries),
    sessions: ctx.sessions,
    ...(ctx.incomplete ? { skipped: true } : {}),
    ...(ctx.warnings.length > 0 ? { warnings: ctx.warnings } : {}),
  };
}
