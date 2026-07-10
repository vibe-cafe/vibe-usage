import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { findTraeCliDataDirs } from '../tools.js';
import { aggregateToBuckets, extractSessions } from './index.js';

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function projectFromPath(absPath) {
  if (!absPath || typeof absPath !== 'string') return 'unknown';
  const trimmed = absPath.replace(/[\\/]+$/, '');
  const name = basename(trimmed);
  return name || 'unknown';
}

function parseJsonlSafe(path) {
  try {
    const content = readFileSync(path, 'utf-8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
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

      // 1. Parse traces.jsonl for token usage
      const traceLines = parseJsonlSafe(join(sessionPath, 'traces.jsonl'));
      const tracesMap = new Map();

      for (const line of traceLines) {
        if (!line.traceID) continue;
        const tags = Array.isArray(line.tags) ? line.tags : [];
        const tagMap = {};
        for (const t of tags) {
          if (t && typeof t === 'object' && t.key) {
            tagMap[t.key] = t.value;
          }
        }

        const model = tagMap['model.name'] || tagMap['semantic.name'] || null;
        const inputTokens = Math.max(0, Number(tagMap['usage.input_tokens']) || 0);
        const outputTokens = Math.max(0, Number(tagMap['usage.output_tokens']) || 0);
        const cacheReadTokens = Math.max(0, Number(tagMap['usage.cache_read_tokens']) || 0);
        const reasoningTokens = Math.max(0, Number(tagMap['usage.reasoning_tokens']) || 0);

        if (inputTokens + outputTokens + cacheReadTokens + reasoningTokens === 0) {
          continue;
        }

        if (!tracesMap.has(line.traceID)) {
          tracesMap.set(line.traceID, {
            model,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            reasoningTokens,
            startTime: Number(line.startTime) || 0,
          });
        } else {
          // Merge spans under the same traceID by selecting the max values
          const existing = tracesMap.get(line.traceID);
          if (model) {
            existing.model = model;
          }
          existing.inputTokens = Math.max(existing.inputTokens, inputTokens);
          existing.outputTokens = Math.max(existing.outputTokens, outputTokens);
          existing.cacheReadTokens = Math.max(existing.cacheReadTokens, cacheReadTokens);
          existing.reasoningTokens = Math.max(existing.reasoningTokens, reasoningTokens);
          if (line.startTime) {
            existing.startTime = existing.startTime ? Math.min(existing.startTime, Number(line.startTime)) : Number(line.startTime);
          }
        }
      }

      // Convert trace map to vibe-usage entries
      for (const trace of tracesMap.values()) {
        // Convert microsecond startTime to milliseconds for Date constructor
        const startTime = Number(trace.startTime);
        if (!Number.isFinite(startTime) || startTime <= 0) continue;
        const timestamp = new Date(startTime / 1000);
        entries.push({
          source: 'trae-cli',
          model: trace.model || fallbackModel,
          project,
          timestamp,
          inputTokens: trace.inputTokens,
          outputTokens: trace.outputTokens,
          cachedInputTokens: trace.cacheReadTokens,
          reasoningOutputTokens: trace.reasoningTokens,
        });
      }

      // 2. Parse events.jsonl for user and assistant timings
      const eventLines = parseJsonlSafe(join(sessionPath, 'events.jsonl'));
      for (const line of eventLines) {
        if (!line.created_at) continue;
        const timestamp = new Date(line.created_at);
        if (Number.isNaN(timestamp.getTime())) continue;

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
      }
    }
  }

  return {
    buckets: aggregateToBuckets(entries),
    sessions: extractSessions(events),
  };
}
