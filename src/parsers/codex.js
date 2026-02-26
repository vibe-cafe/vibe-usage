import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets } from './index.js';

const SESSIONS_DIR = join(homedir(), '.codex', 'sessions');

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

export async function parse(lastSync) {
  if (!existsSync(SESSIONS_DIR)) return [];

  const entries = [];
  const files = findJsonlFiles(SESSIONS_DIR);
  if (files.length === 0) return [];
  for (const filePath of files) {
    if (lastSync) {
      try {
        const stat = statSync(filePath);
        if (stat.mtime <= new Date(lastSync)) continue;
      } catch {
        continue;
      }
    }

    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    // Extract project name and model from session_meta line
    let sessionProject = 'unknown';
    let sessionModel = 'unknown';
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'session_meta' && obj.payload) {
          const meta = obj.payload;
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

    // Track model from turn_context events (fallback when token_count lacks model)
    let turnContextModel = 'unknown';
    // Track previous cumulative totals per model to compute deltas when only total_token_usage is available
    const prevTotal = new Map();
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);


        if (obj.type !== 'event_msg') continue;

        const payload = obj.payload;
        if (!payload) continue;

        // Capture model from turn_context events
        if (payload.type === 'turn_context' && payload.model) {
          turnContextModel = payload.model;
          continue;
        }

        if (payload.type !== 'token_count') continue;

        const info = payload.info;
        if (!info) continue;

        const timestamp = obj.timestamp ? new Date(obj.timestamp) : null;
        if (!timestamp || isNaN(timestamp.getTime())) continue;
        if (lastSync && timestamp <= new Date(lastSync)) continue;

        // Prefer incremental per-request usage; compute delta from cumulative total as fallback
        let usage = info.last_token_usage;
        if (!usage && info.total_token_usage) {
          const totalKey = `${info.model || payload.model || ''}`;
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

        entries.push({
          source: 'codex',
          model,
          project: sessionProject,
          timestamp,
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cachedInputTokens: usage.cached_input_tokens || usage.cache_read_input_tokens || 0,
          reasoningOutputTokens: usage.reasoning_output_tokens || 0,
        });
      } catch {
        continue;
      }
    }
  }

  return aggregateToBuckets(entries);
}
