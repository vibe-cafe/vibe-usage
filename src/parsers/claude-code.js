import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
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

const MAX_WARNINGS = 20;

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

/** Read only the file size captured during discovery, so live appends wait. */
async function readJsonl(candidate, onObject) {
  if (candidate.size === 0) return;
  const stream = createReadStream(candidate.filePath, {
    encoding: 'utf8',
    start: 0,
    end: candidate.size - 1,
  });
  let streamError = null;
  stream.on('error', (err) => { streamError = err; });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        onObject(JSON.parse(line));
      } catch {
        // Claude may be appending the final JSONL record while we snapshot it.
        // A later sync will see the complete line; malformed historical lines
        // are isolated instead of taking the whole parser down.
      }
    }
    if (streamError) throw streamError;
  } finally {
    lines.close();
    stream.destroy();
  }
}

function timingEvent(obj, sessionId, project) {
  if (
    obj.type !== 'user' &&
    obj.type !== 'assistant' &&
    obj.type !== 'tool_use' &&
    obj.type !== 'tool_result'
  ) return null;
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

async function scanProjectCandidate(candidate, collectMagpie) {
  const usageEntries = {
    entriesByKey: new Map(),
    anonymousEntries: [],
  };
  const sessionAccumulator = createSessionAccumulator();
  let lastModel = null;
  let sessionProject = candidate.fallbackProject;
  let foundSessionCwd = false;
  const requestIds = collectMagpie ? new Set() : null;

  await readJsonl(candidate, (obj) => {
    if (requestIds && typeof obj.requestId === 'string') requestIds.add(obj.requestId);
    // cwd can change after Claude runs `cd`; project attribution should remain
    // the directory where this session started, not fragment into subfolders.
    if (!foundSessionCwd && typeof obj.cwd === 'string' && obj.cwd.trim()) {
      sessionProject = projectFromCwd(obj.cwd, candidate.fallbackProject);
      foundSessionCwd = true;
    }
    const event = timingEvent(obj, candidate.sessionId, sessionProject);
    if (event) accumulateSessionEvent(sessionAccumulator, event);

    if (obj.type !== 'assistant' || !obj.message?.usage || !obj.timestamp) return;
    const timestamp = new Date(obj.timestamp);
    if (Number.isNaN(timestamp.getTime())) return;

    const usage = obj.message.usage;
    const rawModel = typeof obj.message.model === 'string'
      ? obj.message.model.trim()
      : '';
    if (rawModel && rawModel !== '<synthetic>') lastModel = rawModel;
    const baseModel = rawModel && rawModel !== '<synthetic>'
      ? rawModel
      : lastModel || 'claude-unknown';
    const model = applySpeedMarker(baseModel, isFastMode(usage, obj.message));
    const cacheCreation = cacheCreationSplit(usage);
    const inputTokens = toCount(usage.input_tokens);
    const outputTokens = toCount(usage.output_tokens);
    const cachedInputTokens = toCount(usage.cache_read_input_tokens);
    const cacheCreation5mTokens = cacheCreation.fiveMinute;
    const cacheCreation1hTokens = cacheCreation.oneHour;
    // Unchanged from when cache writes lived inside inputTokens, so the
    // "keep the most complete duplicate" ranking keeps its old ordering.
    const usageScore = inputTokens + outputTokens + cachedInputTokens +
      cacheCreation5mTokens + cacheCreation1hTokens;

    // Synthetic bookkeeping messages are common and carry zero usage. Do not
    // inflate the CLI's bucket count with rows the server will discard anyway.
    if (usageScore === 0) return;

    mergeUsageEntry(usageEntries, {
      dedupeKey: usageDedupeKey(obj),
      usageScore,
      source: 'claude-code',
      model,
      project: sessionProject,
      timestamp,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningOutputTokens: 0,
      cacheCreation5mTokens,
      cacheCreation1hTokens,
      ...(collectMagpie ? { magpie: { responseId: obj.message.id, fast: isFastMode(usage, obj.message),
        counts: [inputTokens, outputTokens, cachedInputTokens, cacheCreation5mTokens + cacheCreation1hTokens] } } : {}),
    });
  });

  // A cwd can appear after initial metadata/messages. Normalize the completed
  // session in one place so early records receive the same project label.
  for (const entry of usageEntries.anonymousEntries) entry.project = sessionProject;
  for (const entry of usageEntries.entriesByKey.values()) entry.project = sessionProject;
  const session = await finalizeCandidateSession(
    candidate,
    sessionAccumulator,
    () => sessionProject,
    sessionProject,
  );
  return { usageEntries, session, requestIds };
}

async function scanTranscriptCandidate(candidate, collectMagpie) {
  const sessionAccumulator = createSessionAccumulator();
  const requestIds = collectMagpie ? new Set() : null;
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
      return await scanner(candidate, ctx.collectMagpie);
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
  const ctx = {
    collectMagpie: !!magpie?.ledgerExists,
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

  for (const [sessionId, candidates] of projectGroups) {
    const parsed = await scanBestCandidate(candidates, scanProjectCandidate, ctx);
    if (!parsed) continue;
    projectSessionIds.add(sessionId);
    parsedSessions.push(parsed);
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
