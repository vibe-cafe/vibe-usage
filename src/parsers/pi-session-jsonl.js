import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, sep } from 'node:path';
import { aggregateToBuckets, extractSessions } from './index.js';

function findJsonlFiles(dir, includeFile = () => true) {
  const results = [];
  if (!existsSync(dir)) return results;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = `${dir}${sep}${entry.name}`;
      if (entry.isDirectory()) {
        results.push(...findJsonlFiles(fullPath, includeFile));
      } else if (entry.name.endsWith('.jsonl') && includeFile(fullPath)) {
        results.push(fullPath);
      }
    }
  } catch {
    // Ignore unreadable directories. A parser should never break the whole sync.
  }
  return results;
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function extractProjectFromCwd(cwd) {
  if (!cwd) return 'unknown';
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : 'unknown';
}

export function extractProjectFromFirstDir(filePath, sessionsDir) {
  const relative = filePath.slice(sessionsDir.length + 1);
  const firstSeg = relative.split(/[\\/]/)[0];
  if (!firstSeg) return 'unknown';
  const parts = firstSeg.split('-').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : 'unknown';
}

export function parsePiSessionJsonl({ source, sessionsDir, includeFile, projectFromPath }) {
  const entries = [];
  const sessionEvents = [];
  const seenEntryIds = new Set();
  const sessionFiles = findJsonlFiles(sessionsDir, includeFile);

  for (const filePath of sessionFiles) {
    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    let sessionId = basename(filePath, '.jsonl');
    let project = projectFromPath?.(filePath, sessionsDir) || extractProjectFromFirstDir(filePath, sessionsDir);

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;

      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (obj.type === 'session') {
        if (obj.id) sessionId = obj.id;
        if (obj.cwd) project = extractProjectFromCwd(obj.cwd);
        continue;
      }

      if (obj.type !== 'message' || !obj.message) continue;

      const msg = obj.message;
      const ts = new Date(obj.timestamp || msg.timestamp || 0);
      if (Number.isNaN(ts.getTime())) continue;

      if (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'toolResult') {
        sessionEvents.push({
          sessionId,
          source,
          project,
          timestamp: ts,
          role: msg.role === 'user' ? 'user' : 'assistant',
        });
      }

      if (msg.role !== 'assistant' || !msg.usage) continue;

      const usage = msg.usage;
      if (usage.input == null && usage.output == null) continue;

      const entryId = obj.id;
      if (entryId) {
        if (seenEntryIds.has(entryId)) continue;
        seenEntryIds.add(entryId);
      }

      entries.push({
        source,
        model: msg.model || msg.modelId || obj.model || obj.modelId || 'unknown',
        project,
        timestamp: ts,
        inputTokens: numberOrZero(usage.input),
        outputTokens: numberOrZero(usage.output),
        cachedInputTokens: numberOrZero(usage.cacheRead),
        reasoningOutputTokens: 0,
      });
    }
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(sessionEvents) };
}
