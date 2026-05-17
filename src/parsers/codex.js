import { createReadStream, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { aggregateToBuckets, extractSessions } from './index.js';

// Codex stores live sessions in ~/.codex/sessions and, once a session is
// "completed", moves its rollout file verbatim into ~/.codex/archived_sessions.
// A session can be archived between two syncs, so scanning only the live dir
// loses that session's usage forever. We scan both: the parser is stateless
// and the server dedups on (source, sessionHash/bucket), so re-reading an
// archived file that was already synced from sessions/ is idempotent. Indexing
// both together also keeps fork replay-skip correct when a fork and its parent
// end up split across the two directories.
const SESSIONS_DIRS = [
  join(homedir(), '.codex', 'sessions'),
  join(homedir(), '.codex', 'archived_sessions'),
];

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
 * Stream a session file once and extract its index metadata: the session
 * id, the forked-from id, the project name, and the total count of
 * `event_msg/token_count` records. The token_count total is used to size
 * the replayed-history block of a forked session — a fork copies the
 * original conversation verbatim, so it begins with exactly as many
 * token_count records as the source session has in total.
 */
async function indexSessionFile(filePath) {
  let sessionId = null;
  let forkedFromId = null;
  let sessionProject = 'unknown';
  let tokenCountRecords = 0;

  for await (const line of readLines(filePath)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'session_meta' && obj.payload) {
        const meta = obj.payload;
        sessionId = meta.id || sessionId;
        forkedFromId = meta.forked_from_id || null;
        sessionProject = extractProject(meta);
      } else if (obj.type === 'event_msg' && obj.payload?.type === 'token_count') {
        tokenCountRecords++;
      }
    } catch {
      continue;
    }
  }

  return { sessionId, forkedFromId, sessionProject, tokenCountRecords };
}

export async function parse() {
  if (!SESSIONS_DIRS.some(existsSync)) return { buckets: [], sessions: [] };

  const entries = [];
  const sessionEvents = [];
  const files = SESSIONS_DIRS.flatMap(findJsonlFiles);
  if (files.length === 0) return { buckets: [], sessions: [] };

  // Pass 1: index every session by its UUID and count its token_count
  // records. A forked session (session_meta.payload.forked_from_id) starts
  // with the original conversation replayed verbatim — including every
  // token_count, all timestamped in a burst at the fork instant. Those
  // tokens are already counted from the original session's own file, so
  // re-counting them here double-counts usage and produces a spurious
  // token/cost spike at the fork time. Timestamps cannot distinguish the
  // replay from new activity (the replay burst is stamped at/after the fork
  // instant, within the same 1–3s window), so we instead skip exactly the
  // original session's token_count count from the start of each fork.
  const tokenCountById = new Map(); // sessionId → number of token_count records
  const fileMeta = new Map(); // filePath -> { forkedFromId, sessionProject }
  for (const filePath of files) {
    let meta;
    try {
      meta = await indexSessionFile(filePath);
    } catch {
      continue;
    }
    fileMeta.set(filePath, meta);
    if (meta.sessionId) {
      tokenCountById.set(meta.sessionId, meta.tokenCountRecords);
    }
  }

  // Pass 2: parse usage, skipping each fork's replayed-history token_counts.
  for (const filePath of files) {
    const fm = fileMeta.get(filePath);
    if (!fm) continue;
    const { forkedFromId } = fm;

    // How many leading token_count records are copied history. A fork's file
    // begins with the *entire* source file replayed verbatim, so the count
    // to skip is the source's total token_count count. This is correct even
    // for chained forks: a fork-of-a-fork replays the parent fork's whole
    // file (which itself already contains the grandparent's replay), so
    // skipping the parent's full count skips exactly the duplicated region.
    // If the source file is missing (rotated/deleted) we cannot locate the
    // boundary; skip nothing so incomplete data over-counts rather than
    // silently dropping real usage.
    let replayTokenCountToSkip = 0;
    if (forkedFromId != null) {
      replayTokenCountToSkip = tokenCountById.get(forkedFromId) ?? 0;
    }
    let tokenCountSeen = 0;

    const sessionProject = fm.sessionProject;
    // Group timing events by the real Codex session id, not the file path: the
    // same session can briefly exist in both sessions/ and archived_sessions/
    // (mid-archive, or a re-synced archive). Path-keyed grouping would emit it
    // as two different sessionHashes and double-count its session stats. Fall
    // back to the path only when the id is unknown (corrupt/missing meta).
    const sessionKey = fm.sessionId || filePath;

    let turnContextModel = 'unknown';
    const prevTotal = new Map();
    for await (const line of readLines(filePath)) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);

        // A fork's replayed-history block is the run from the start of the
        // file up to and including the Nth token_count, where N is the source
        // session's total token_count count. We are still inside that block
        // until we have *passed* the Nth token_count. (token_count is the
        // last event of each turn, so the boundary lands cleanly at a turn
        // edge — the new conversation's events come strictly after it.)
        const inReplayBlock = tokenCountSeen < replayTokenCountToSkip;

        if (obj.timestamp) {
          const evTs = new Date(obj.timestamp);
          if (!isNaN(evTs.getTime())) {
            // Skip replayed history events so a forked session's
            // duration/active-time/message counts reflect only the new
            // conversation, not the copied original. session_meta itself is
            // kept: it marks when the fork actually started.
            const isReplay = inReplayBlock && obj.type !== 'session_meta';
            if (!isReplay) {
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

        const info = payload.info;
        if (!info) continue;

        const timestamp = obj.timestamp ? new Date(obj.timestamp) : null;
        if (!timestamp || isNaN(timestamp.getTime())) continue;

        // This is the (tokenCountSeen+1)-th token_count in the file. If it
        // falls inside the fork's replay block it's an exact copy of a record
        // already counted from the source session's own file — skip it (but
        // still advance the cumulative-total baseline below so the first real
        // post-fork delta is measured correctly).
        const isReplayedHistory = tokenCountSeen < replayTokenCountToSkip;
        tokenCountSeen++;

        // Prefer incremental per-request usage; compute delta from cumulative total as fallback
        let usage = info.last_token_usage;
        if (!usage && info.total_token_usage) {
          const totalKey = `${info.model || payload.model || turnContextModel || ''}`;
          const prev = prevTotal.get(totalKey);
          const curr = info.total_token_usage;
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
          // Always advance the cumulative baseline, even for replayed history,
          // so the first real post-fork delta is measured against the last
          // replayed total instead of being mistaken for a fresh "first entry".
          prevTotal.set(totalKey, { ...curr });
        }
        if (!usage) continue;
        if (isReplayedHistory) continue;

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
