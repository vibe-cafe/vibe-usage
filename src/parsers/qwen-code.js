import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename, sep } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets } from './index.js';

/**
 * Qwen Code parser (Gemini CLI fork).
 * JSONL at ~/.qwen/tmp/<project_id>/chats/<sessionId>.jsonl
 * Token fields: usageMetadata.{promptTokenCount, candidatesTokenCount,
 *   cachedContentTokenCount, thoughtsTokenCount}
 * Note: promptTokenCount INCLUDES cachedContentTokenCount (needs normalization).
 */

const QWEN_TMP_DIR = join(homedir(), '.qwen', 'tmp');

function findSessionFiles(baseDir) {
  const results = [];
  if (!existsSync(baseDir)) return results;

  try {
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const chatsDir = join(baseDir, entry.name, 'chats');
      if (!existsSync(chatsDir)) continue;
      try {
        for (const f of readdirSync(chatsDir)) {
          if (f.endsWith('.jsonl')) {
            results.push(join(chatsDir, f));
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    return results;
  }
  return results;
}

function extractProject(cwd, filePath) {
  if (cwd) {
    const parts = cwd.split('/').filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  const tmpPrefix = QWEN_TMP_DIR + sep;
  if (filePath.startsWith(tmpPrefix)) {
    const relative = filePath.slice(tmpPrefix.length);
    const projectId = relative.split(sep)[0];
    if (projectId) return projectId;
  }
  return 'unknown';
}

export async function parse() {
  const sessionFiles = findSessionFiles(QWEN_TMP_DIR);
  if (sessionFiles.length === 0) return [];

  const entries = [];
  const seenUuids = new Set();

  for (const filePath of sessionFiles) {
    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);

        if (obj.type !== 'assistant') continue;
        const usage = obj.usageMetadata;
        if (!usage) continue;
        if (usage.promptTokenCount == null && usage.candidatesTokenCount == null) continue;

        const uuid = obj.uuid;
        if (uuid) {
          if (seenUuids.has(uuid)) continue;
          seenUuids.add(uuid);
        }

        const timestamp = obj.timestamp;
        if (!timestamp) continue;
        const ts = new Date(timestamp);
        if (isNaN(ts.getTime())) continue;

        // promptTokenCount INCLUDES cachedContentTokenCount — normalize to non-overlapping
        const cached = usage.cachedContentTokenCount || 0;
        const thoughts = usage.thoughtsTokenCount || 0;

        entries.push({
          source: 'qwen-code',
          model: obj.model || 'unknown',
          project: extractProject(obj.cwd, filePath),
          timestamp: ts,
          inputTokens: (usage.promptTokenCount || 0) - cached,
          outputTokens: (usage.candidatesTokenCount || 0) - thoughts,
          cachedInputTokens: cached,
          reasoningOutputTokens: thoughts,
        });
      } catch {
        continue;
      }
    }
  }

  return aggregateToBuckets(entries);
}
