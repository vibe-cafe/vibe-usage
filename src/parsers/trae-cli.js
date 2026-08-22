import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { findTraeCliDataDirs } from '../tools.js';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { readJsonSafe, projectFromPath } from './fs-utils.js';

// Trae writes each LLM call as several nested spans that share one session-level
// traceID and copy the same usage onto every layer:
//   model.stream.eino  (authoritative: includes reasoning tokens)
//   model.real_call    (duplicate)
//   model.call         (duplicate)
// model.generate is a separate failover call (different model), not a duplicate.
// Counting every layer would 3x; merging by traceID with max() collapses a
// whole session of sequential calls into a single request. Keep one unique
// layer per call, then SUM.
const PRIMARY_LLM_CATEGORY = 'model.stream.eino';
const FAILOVER_LLM_CATEGORY = 'model.generate';
const FALLBACK_LLM_CATEGORIES = ['model.real_call', 'model.call'];

function tagMapFrom(tags) {
  const tagMap = {};
  if (!Array.isArray(tags)) return tagMap;
  for (const t of tags) {
    if (t && typeof t === 'object' && t.key) tagMap[t.key] = t.value;
  }
  return tagMap;
}

function spanCategory(tagMap) {
  return typeof tagMap['span.category'] === 'string' ? tagMap['span.category'] : '';
}

function usageFromTagMap(tagMap) {
  const inputTokens = Math.max(0, Number(tagMap['usage.input_tokens']) || 0);
  const outputTokens = Math.max(0, Number(tagMap['usage.output_tokens']) || 0);
  const cacheReadTokens = Math.max(0, Number(tagMap['usage.cache_read_tokens']) || 0);
  const reasoningTokens = Math.max(0, Number(tagMap['usage.reasoning_tokens']) || 0);
  return { inputTokens, outputTokens, cacheReadTokens, reasoningTokens };
}

function hasUsage(usage) {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.reasoningTokens > 0;
}

/**
 * Pick the unique LLM-call spans from a session's traces.
 * Prefer model.stream.eino (+ model.generate failovers). If a session has no
 * primary layer (older traces), fall back to model.real_call, then model.call.
 * @param {{category: string, usage: object, model: string|null, startTime: number}[]} spans
 */
export function selectTraeUsageSpans(spans) {
  const withUsage = spans.filter((s) => hasUsage(s.usage));
  const primary = withUsage.filter((s) => s.category === PRIMARY_LLM_CATEGORY);
  const failover = withUsage.filter((s) => s.category === FAILOVER_LLM_CATEGORY);
  if (primary.length > 0 || failover.length > 0) return primary.concat(failover);
  for (const cat of FALLBACK_LLM_CATEGORIES) {
    const subset = withUsage.filter((s) => s.category === cat);
    if (subset.length > 0) return subset;
  }
  return withUsage;
}

/** Stream a JSONL file line by line. Skips missing files and malformed lines. */
export async function forEachJsonl(path, onObj) {
  if (!existsSync(path)) return;
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (obj && typeof obj === 'object') onObj(obj);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

export async function parse() {
  const cacheDirs = findTraeCliDataDirs();
  if (cacheDirs.length === 0) return { buckets: [], sessions: [] };

  const entries = [];
  const events = [];

  for (const cacheDir of cacheDirs) {
    let sessionDirs = [];
    try {
      sessionDirs = readdirSync(cacheDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch {
      continue;
    }

    for (const sessionId of sessionDirs) {
      const sessionPath = join(cacheDir, sessionId);
      const sessionJson = readJsonSafe(join(sessionPath, 'session.json')) || {};
      const project = projectFromPath(sessionJson.metadata?.cwd);
      const fallbackModel = sessionJson.metadata?.model_name || 'trae-unknown';

      const spans = [];
      await forEachJsonl(join(sessionPath, 'traces.jsonl'), (line) => {
        const tagMap = tagMapFrom(line.tags);
        const usage = usageFromTagMap(tagMap);
        if (!hasUsage(usage)) return;
        const startTime = Number(line.startTime);
        if (!Number.isFinite(startTime) || startTime <= 0) return;
        spans.push({
          category: spanCategory(tagMap),
          model: tagMap['model.name'] || tagMap['semantic.name'] || null,
          startTime,
          usage,
        });
      });

      for (const span of selectTraeUsageSpans(spans)) {
        // Trae startTime is microseconds; Date expects milliseconds.
        const timestamp = new Date(span.startTime / 1000);
        if (Number.isNaN(timestamp.getTime())) continue;
        entries.push({
          source: 'trae-cli',
          model: span.model || fallbackModel,
          project,
          timestamp,
          inputTokens: span.usage.inputTokens,
          outputTokens: span.usage.outputTokens,
          cachedInputTokens: span.usage.cacheReadTokens,
          reasoningOutputTokens: span.usage.reasoningTokens,
        });
      }

      await forEachJsonl(join(sessionPath, 'events.jsonl'), (line) => {
        if (!line.created_at) return;
        const timestamp = new Date(line.created_at);
        if (Number.isNaN(timestamp.getTime())) return;

        if (line.agent_start) {
          events.push({
            sessionId,
            source: 'trae-cli',
            project,
            timestamp,
            role: 'user',
          });
        } else if (line.agent_end || line.tool_call || (line.message && line.message.message?.role === 'assistant')) {
          events.push({
            sessionId,
            source: 'trae-cli',
            project,
            timestamp,
            role: 'assistant',
          });
        }
      });
    }
  }

  return {
    buckets: aggregateToBuckets(entries),
    sessions: extractSessions(events),
  };
}
