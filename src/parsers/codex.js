import { createReadStream, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { aggregateToBuckets, extractSessions } from './index.js';

// Codex stores live sessions in $CODEX_HOME/sessions (default ~/.codex) and,
// once a session is "completed", moves its rollout file verbatim into
// $CODEX_HOME/archived_sessions. A session can be archived between two syncs,
// so scanning only the live dir loses that session's usage forever. We scan
// both, index them together so fork replay-skip works across directories, and
// select the most complete physical file when the same session briefly exists
// in both locations during an archive move.
function sessionsDirs() {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  return [
    join(codexHome, 'sessions'),
    join(codexHome, 'archived_sessions'),
  ];
}

/**
 * Recursively find all .jsonl files under a directory.
 * Codex CLI stores sessions as: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 */
function findJsonlFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findJsonlFiles(fullPath));
      } else if (entry.name.endsWith('.jsonl')) {
        results.push(fullPath);
      }
    }
  } catch {
    // ignore unreadable directories
  }
  return results;
}

function readLines(filePath) {
  return createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
}

function extractProject(meta) {
  if (meta.git?.repository_url) {
    // e.g. https://github.com/org/repo.git → org/repo
    const match = meta.git.repository_url.match(/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  }
  if (meta.cwd) return meta.cwd.split('/').pop() || 'unknown';
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
 * records) on a monotonic timeline. This lets a fork skip only the source
 * records that existed at the fork/spawn time, even if the source continues
 * running and grows after the child was created.
 */
async function indexSessionFile(filePath) {
  let sessionId = null;
  let forkedFromId = null;
  let parentThreadId = null;
  let sessionProject = 'unknown';
  let sessionStartedAtMs = null;
  let isSubagent = false;
  let sessionMetaCount = 0;
  let parsedRecordCount = 0;
  let rawTokenCount = 0;
  let logicalTimestamp = Number.NEGATIVE_INFINITY;
  const tokenTimes = [];
  let pendingTokenTimeIndexes = [];
  let firstTaskBoundary = null;
  let ownTaskBoundary = null;

  for await (const line of readLines(filePath)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
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
          sessionStartedAtMs = timestampMs(meta.timestamp) ?? recordTimestamp;
        }
      } else if (obj.type === 'event_msg' && obj.payload?.type === 'token_count') {
        rawTokenCount++;
        if (recordTimestamp == null) {
          tokenTimes.push(Number.POSITIVE_INFINITY);
          pendingTokenTimeIndexes.push(tokenTimes.length - 1);
        } else {
          tokenTimes.push(logicalTimestamp);
        }
      } else if (obj.type === 'event_msg' && obj.payload?.type === 'task_started') {
        const boundary = { recordIndex: parsedRecordCount, rawTokenCount };
        firstTaskBoundary ??= boundary;

        const startedAtMs = epochMs(obj.payload.started_at);
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
    sessionStartedAtMs,
    isSubagent,
    sessionMetaCount,
    parsedRecordCount,
    rawTokenCount,
    tokenTimes,
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

  if (meta.isSubagent) {
    // Direct evidence inside the child wins. Legacy single-meta rollouts did
    // not replay task_started records, so their first task remains a safe
    // fallback. Double-meta files must not use their copied parent's first
    // task_started as the boundary.
    const direct = meta.ownTaskBoundary
      || (meta.sessionMetaCount === 1 ? meta.firstTaskBoundary : null);
    if (direct) {
      return { rawTokenCount: direct.rawTokenCount, recordIndex: direct.recordIndex };
    }
    return { rawTokenCount: parentAtSpawn ?? 0, recordIndex: null };
  }

  if (meta.forkedFromId) {
    return { rawTokenCount: parentAtSpawn ?? 0, recordIndex: null };
  }
  return { rawTokenCount: 0, recordIndex: null };
}

export async function parse() {
  const dirs = sessionsDirs();
  if (!dirs.some(existsSync)) return { buckets: [], sessions: [] };

  const entries = [];
  const sessionEvents = [];
  const files = dirs.flatMap(findJsonlFiles);
  if (files.length === 0) return { buckets: [], sessions: [] };

  // Pass 1: build a compact per-file index. Keep the most complete physical
  // copy for each logical session id so a rollout briefly present in both
  // sessions/ and archived_sessions/ cannot double its token buckets.
  const sessionById = new Map();
  const fileMeta = new Map();
  for (const filePath of files) {
    let meta;
    try {
      meta = await indexSessionFile(filePath);
    } catch {
      continue;
    }
    fileMeta.set(filePath, meta);
    if (meta.sessionId) {
      const existing = sessionById.get(meta.sessionId);
      if (!existing || meta.parsedRecordCount > existing.parsedRecordCount) {
        sessionById.set(meta.sessionId, meta);
      }
    }
  }

  // Pass 2: parse usage while skipping the replay prefix resolved above.
  for (const filePath of files) {
    const fm = fileMeta.get(filePath);
    if (!fm) continue;
    if (fm.sessionId && sessionById.get(fm.sessionId)?.filePath !== filePath) continue;

    const boundary = replayBoundary(fm, sessionById);
    let rawTokenSeen = 0;
    let parsedRecordIndex = 0;
    let canonicalSessionMetaSeen = false;

    const sessionProject = fm.sessionProject;
    // Group timing events by the real Codex session id, not the file path: the
    // same session can briefly exist in both sessions/ and archived_sessions/
    // (mid-archive, or a re-synced archive). Path-keyed grouping would emit it
    // as two different sessionHashes and double-count its session stats. Fall
    // back to the path only when the id is unknown (corrupt/missing meta).
    const sessionKey = fm.sessionId || filePath;

    let turnContextModel = 'unknown';
    const prevTotal = new Map();
    let prevCumulativeTotal = null;
    for await (const line of readLines(filePath)) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        parsedRecordIndex++;

        // A direct child task boundary covers every copied record, including
        // timing/meta events. The raw-token ordinal also covers ordinary forks
        // where the source-at-spawn prefix is the only available boundary.
        const beforeOwnTask = boundary.recordIndex != null
          && parsedRecordIndex < boundary.recordIndex;
        const inReplayBlock = beforeOwnTask || rawTokenSeen < boundary.rawTokenCount;

        const isSessionMeta = obj.type === 'session_meta';
        const isCanonicalSessionMeta = isSessionMeta && !canonicalSessionMetaSeen;
        if (isSessionMeta) canonicalSessionMetaSeen = true;

        if (obj.timestamp) {
          const evTs = new Date(obj.timestamp);
          if (!isNaN(evTs.getTime())) {
            // Keep only the rollout's own first session_meta. A replayed parent
            // session_meta must not inflate timing stats or user message count.
            if (isCanonicalSessionMeta || (!isSessionMeta && !inReplayBlock)) {
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

        if (obj.type === 'turn_context' && obj.payload?.model) {
          turnContextModel = obj.payload.model;
          continue;
        }

        if (obj.type !== 'event_msg') continue;

        const payload = obj.payload;
        if (!payload) continue;

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
        const cumulativeTotal = info.total_token_usage?.total_tokens;
        const isDuplicateEmission = typeof cumulativeTotal === 'number'
          && cumulativeTotal > 0 && cumulativeTotal === prevCumulativeTotal;
        if (typeof cumulativeTotal === 'number') prevCumulativeTotal = cumulativeTotal;

        // Prefer incremental per-request usage; compute delta from cumulative
        // totals as fallback. Always advance the cumulative baseline, even
        // when last_token_usage exists or the record belongs to a replay.
        const totalKey = `${info.model || payload.model || turnContextModel || ''}`;
        const curr = info.total_token_usage;
        let usage = info.last_token_usage;
        if (!usage && curr) {
          const prev = prevTotal.get(totalKey);
          if (prev) {
            usage = {
              input_tokens: (curr.input_tokens || 0) - (prev.input_tokens || 0),
              output_tokens: (curr.output_tokens || 0) - (prev.output_tokens || 0),
              cached_input_tokens: (curr.cached_input_tokens || 0) - (prev.cached_input_tokens || 0),
              reasoning_output_tokens: (curr.reasoning_output_tokens || 0) - (prev.reasoning_output_tokens || 0),
            };
          } else {
            // First cumulative entry — use as-is (it's the first event's total)
            usage = curr;
          }
        }
        if (curr) prevTotal.set(totalKey, { ...curr });
        if (!usage) continue;
        if (isReplayedHistory || isDuplicateEmission) continue;

        const timestamp = obj.timestamp ? new Date(obj.timestamp) : null;
        if (!timestamp || isNaN(timestamp.getTime())) continue;

        const model = info.model || payload.model || turnContextModel || 'unknown';

        // OpenAI API: input_tokens INCLUDES cached, output_tokens INCLUDES reasoning.
        // Normalize to Anthropic-style semantics where each field is non-overlapping.
        const cachedInput = usage.cached_input_tokens || usage.cache_read_input_tokens || 0;
        const reasoningOutput = usage.reasoning_output_tokens || 0;
        entries.push({
          source: 'codex',
          model,
          project: sessionProject,
          timestamp,
          inputTokens: (usage.input_tokens || 0) - cachedInput,
          outputTokens: (usage.output_tokens || 0) - reasoningOutput,
          cachedInputTokens: cachedInput,
          reasoningOutputTokens: reasoningOutput,
        });
      } catch {
        continue;
      }
    }
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(sessionEvents) };
}
