import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets } from './index.js';

const TMP_DIR = join(homedir(), '.gemini', 'tmp');

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
          if (f.startsWith('session-') && f.endsWith('.json')) {
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

export async function parse() {
  const sessionFiles = findSessionFiles(TMP_DIR);
  if (sessionFiles.length === 0) return [];

  const entries = [];

  for (const filePath of sessionFiles) {

    let data;
    try {
      data = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      continue;
    }

    const messages = data.messages || data.history || [];
    for (const msg of messages) {
      // New format: tokens on type=gemini messages (ChatRecordingService)
      // Old format: usage/usageMetadata on any message
      const tokens = msg.tokens;
      const usage = msg.usage || msg.usageMetadata || msg.token_count;
      if (!tokens && !usage) continue;

      const timestamp = msg.timestamp || msg.createTime || data.createTime;
      if (!timestamp) continue;
      const ts = new Date(timestamp);
      if (isNaN(ts.getTime())) continue;

      if (tokens) {
        // Gemini API: input INCLUDES cached, output INCLUDES thoughts. Normalize to non-overlapping.
        const cached = tokens.cached || 0;
        const thoughts = tokens.thoughts || 0;
        entries.push({
          source: 'gemini-cli',
          model: msg.model || data.model || 'unknown',
          project: 'unknown',
          timestamp: ts,
          inputTokens: (tokens.input || 0) - cached,
          outputTokens: (tokens.output || 0) - thoughts,
          cachedInputTokens: cached,
          reasoningOutputTokens: thoughts,
        });
      } else {
        // Gemini API: promptTokenCount INCLUDES cachedContentTokenCount. Normalize to non-overlapping.
        const cached = usage.cachedContentTokenCount || 0;
        const thoughts = usage.thoughtsTokenCount || 0;
        entries.push({
          source: 'gemini-cli',
          model: msg.model || data.model || 'unknown',
          project: 'unknown',
          timestamp: ts,
          inputTokens: (usage.promptTokenCount || usage.input_tokens || 0) - cached,
          outputTokens: (usage.candidatesTokenCount || usage.output_tokens || 0) - thoughts,
          cachedInputTokens: cached,
          reasoningOutputTokens: thoughts,
        });
      }
    }
  }

  return aggregateToBuckets(entries);
}
