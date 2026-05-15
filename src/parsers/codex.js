import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './index.js';

const SESSIONS_DIR = join(homedir(), '.codex', 'sessions');
const FORK_REPLAY_WINDOW_MS = 5_000;

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

export async function parse({ sessionsDir = SESSIONS_DIR } = {}) {
  if (!existsSync(sessionsDir)) return { buckets: [], sessions: [] };

  const entries = [];
  const sessionEvents = [];
  const files = findJsonlFiles(sessionsDir);
  if (files.length === 0) return { buckets: [], sessions: [] };
  for (const filePath of files) {

    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    // Extract project name, model, and fork metadata from session_meta lines.
    let sessionProject = 'unknown';
    let sessionModel = 'unknown';
    let forkReplayUntil = null;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'session_meta' && obj.payload) {
          const meta = obj.payload;
          if (meta.forked_from_id && obj.timestamp) {
            const forkStart = new Date(obj.timestamp);
            if (!isNaN(forkStart.getTime())) {
              forkReplayUntil = new Date(forkStart.getTime() + FORK_REPLAY_WINDOW_MS);
            }
          }
          if (meta.cwd) {
            sessionProject = meta.cwd.split('/').pop() || 'unknown';
          }
          if (meta.git?.repository_url) {
            // e.g. https://github.com/org/repo.git → org/repo
            const match = meta.git.repository_url.match(/([^/]+\/[^/]+?)(?:\.git)?$/);
            if (match) sessionProject = match[1];
          }
          break;
        }
      } catch { break; }
    }

    let turnContextModel = 'unknown';
    const prevTotal = new Map();
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);

        if (obj.timestamp) {
          const evTs = new Date(obj.timestamp);
          if (!isNaN(evTs.getTime())) {
            if (!forkReplayUntil || evTs > forkReplayUntil) {
              const isUserTurn = obj.type === 'turn_context' || obj.type === 'session_meta';
              sessionEvents.push({
                sessionId: filePath,
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
        if (forkReplayUntil && timestamp <= forkReplayUntil) continue;

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
          prevTotal.set(totalKey, { ...curr });
        }
        if (!usage) continue;

        const model = info.model || payload.model || turnContextModel || sessionModel;

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
