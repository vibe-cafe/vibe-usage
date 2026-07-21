import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename, sep } from 'node:path';
import { aggregateToBuckets, extractSessions } from './index.js';
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
      results.push(...findJsonlFiles(fullPath, ctx));
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

/** Works for Unix and Windows cwd values regardless of the current OS. */
function projectFromCwd(cwd, fallback) {
  if (typeof cwd !== 'string') return fallback;
  const trimmed = cwd.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return fallback;
  return trimmed.split(/[\\/]/).filter(Boolean).at(-1) || fallback;
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function cacheCreationTokens(usage) {
  const direct = toCount(usage.cache_creation_input_tokens);
  const breakdown = usage.cache_creation || {};
  const split =
    toCount(breakdown.ephemeral_5m_input_tokens) +
    toCount(breakdown.ephemeral_1h_input_tokens);
  // Current Claude logs carry both the total and its TTL breakdown. max()
  // avoids double-counting while remaining tolerant of partially populated logs.
  return Math.max(direct, split);
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

async function scanProjectCandidate(candidate) {
  const entries = [];
  const events = [];
  let lastModel = null;
  let sessionProject = candidate.fallbackProject;
  let foundSessionCwd = false;

  await readJsonl(candidate, (obj) => {
    // cwd can change after Claude runs `cd`; project attribution should remain
    // the directory where this session started, not fragment into subfolders.
    if (!foundSessionCwd && typeof obj.cwd === 'string' && obj.cwd.trim()) {
      sessionProject = projectFromCwd(obj.cwd, candidate.fallbackProject);
      foundSessionCwd = true;
    }
    const event = timingEvent(obj, candidate.sessionId, sessionProject);
    if (event) events.push(event);

    if (obj.type !== 'assistant' || !obj.message?.usage || !obj.timestamp) return;
    const timestamp = new Date(obj.timestamp);
    if (Number.isNaN(timestamp.getTime())) return;

    const usage = obj.message.usage;
    const rawModel = typeof obj.message.model === 'string'
      ? obj.message.model.trim()
      : '';
    if (rawModel && rawModel !== '<synthetic>') lastModel = rawModel;
    const model = rawModel && rawModel !== '<synthetic>'
      ? rawModel
      : lastModel || 'claude-unknown';
    const inputTokens = toCount(usage.input_tokens) + cacheCreationTokens(usage);
    const outputTokens = toCount(usage.output_tokens);
    const cachedInputTokens = toCount(usage.cache_read_input_tokens);
    const usageScore = inputTokens + outputTokens + cachedInputTokens;

    // Synthetic bookkeeping messages are common and carry zero usage. Do not
    // inflate the CLI's bucket count with rows the server will discard anyway.
    if (usageScore === 0) return;

    entries.push({
      uuid: typeof obj.uuid === 'string' && obj.uuid ? obj.uuid : null,
      usageScore,
      source: 'claude-code',
      model,
      project: sessionProject,
      timestamp,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningOutputTokens: 0,
    });
  });

  // A cwd can appear after initial metadata/messages. Normalize the completed
  // session in one place so early records receive the same project label.
  for (const entry of entries) entry.project = sessionProject;
  for (const event of events) event.project = sessionProject;
  return { entries, events };
}

async function scanTranscriptCandidate(candidate) {
  const events = [];
  await readJsonl(candidate, (obj) => {
    const event = timingEvent(
      obj,
      candidate.sessionId,
      projectFromCwd(obj.cwd, 'unknown'),
    );
    if (event) events.push(event);
  });
  return { entries: [], events };
}

async function scanBestCandidate(candidates, scanner, ctx) {
  for (const candidate of candidates) {
    try {
      return await scanner(candidate);
    } catch (err) {
      addWarning(ctx, `Claude Code: cannot read ${candidate.filePath}: ${err.message}`);
    }
  }
  return null;
}

function mergeUsageEntry(ctx, entry) {
  if (!entry.uuid) {
    ctx.anonymousEntries.push(entry);
    return;
  }
  const current = ctx.entriesByUuid.get(entry.uuid);
  // Claude sometimes copies the same UUID into another session with zeroed
  // usage. Keep the most complete payload, independent of directory order.
  if (!current || entry.usageScore > current.usageScore) {
    ctx.entriesByUuid.set(entry.uuid, entry);
  }
}

export async function parse() {
  const ctx = {
    entriesByUuid: new Map(),
    anonymousEntries: [],
    sessionEvents: [],
    warnings: [],
    incomplete: false,
  };
  const roots = getClaudeRoots();
  const projectGroups = collectCandidates(roots, 'projects', ctx);
  const projectSessionIds = new Set();

  for (const [sessionId, candidates] of projectGroups) {
    const parsed = await scanBestCandidate(candidates, scanProjectCandidate, ctx);
    if (!parsed) continue;
    projectSessionIds.add(sessionId);
    ctx.sessionEvents.push(...parsed.events);
    for (const entry of parsed.entries) mergeUsageEntry(ctx, entry);
  }

  const transcriptGroups = collectCandidates(roots, 'transcripts', ctx);
  for (const [sessionId, candidates] of transcriptGroups) {
    if (projectSessionIds.has(sessionId)) continue;
    const parsed = await scanBestCandidate(candidates, scanTranscriptCandidate, ctx);
    if (parsed) ctx.sessionEvents.push(...parsed.events);
  }

  const entries = [
    ...ctx.anonymousEntries,
    ...ctx.entriesByUuid.values(),
  ].map(({ uuid: _uuid, usageScore: _usageScore, ...entry }) => entry);

  return {
    buckets: aggregateToBuckets(entries),
    sessions: extractSessions(ctx.sessionEvents),
    ...(ctx.incomplete ? { skipped: true } : {}),
    ...(ctx.warnings.length > 0 ? { warnings: ctx.warnings } : {}),
  };
}
