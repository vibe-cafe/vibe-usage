import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './aggregate.js';

const DROID_SESSIONS_DIR = join(homedir(), '.factory', 'sessions');

function findJsonlFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;

  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findJsonlFiles(fullPath));
      } else if (entry.name.endsWith('.jsonl') && !entry.name.endsWith('.settings.json')) {
        results.push(fullPath);
      }
    }
  } catch {
  }

  return results;
}

function extractProjectFromSlug(slug) {
  const parts = slug.split('-').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : 'unknown';
}

function toSafeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function parse() {
  const entries = [];
  const sessionEvents = [];
  const sessionFiles = findJsonlFiles(DROID_SESSIONS_DIR);

  for (const filePath of sessionFiles) {
    const sessionId = basename(filePath, '.jsonl');
    const slug = basename(dirname(filePath));
    const project = extractProjectFromSlug(slug);
    let firstMessageTimestamp = null;

    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;

      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (obj.type !== 'message') continue;
      if (!obj.timestamp) continue;

      const ts = new Date(obj.timestamp);
      if (isNaN(ts.getTime())) continue;

      if (firstMessageTimestamp === null) firstMessageTimestamp = ts;

      sessionEvents.push({
        sessionId,
        source: 'droid',
        project,
        timestamp: ts,
        role: obj.message?.role === 'user' ? 'user' : 'assistant',
      });
    }

    const settingsPath = join(dirname(filePath), `${sessionId}.settings.json`);
    if (!existsSync(settingsPath) || firstMessageTimestamp === null) continue;

    let settings;
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      continue;
    }

    const tokenUsage = settings?.tokenUsage;
    if (!tokenUsage) continue;

    const cacheReadTokens = toSafeNumber(tokenUsage.cacheReadTokens);
    const thinkingTokens = toSafeNumber(tokenUsage.thinkingTokens);
    const inputTokens = Math.max(0, toSafeNumber(tokenUsage.inputTokens) - cacheReadTokens);
    const outputTokens = Math.max(0, toSafeNumber(tokenUsage.outputTokens) - thinkingTokens);

    entries.push({
      source: 'droid',
      model: settings.model || 'unknown',
      project,
      timestamp: firstMessageTimestamp,
      inputTokens,
      outputTokens,
      cachedInputTokens: cacheReadTokens,
      reasoningOutputTokens: thinkingTokens,
    });
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(sessionEvents) };
}
