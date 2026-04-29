import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './index.js';

function resolveThreadsDir() {
  if (process.env.AMP_DATA_DIR) return process.env.AMP_DATA_DIR;
  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, 'amp', 'threads');
  return join(homedir(), '.local', 'share', 'amp', 'threads');
}

function findThreadFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;

  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findThreadFiles(fullPath));
      } else if (entry.isFile() && entry.name.startsWith('T-') && entry.name.endsWith('.json')) {
        results.push(fullPath);
      }
    }
  } catch {
  }

  return results;
}

function setMessageTimestamp(map, messageId, timestamp) {
  if (!Number.isInteger(messageId)) return;
  const current = map.get(messageId);
  if (!current || timestamp < current) {
    map.set(messageId, timestamp);
  }
}

function buildMessageTimestampMap(events) {
  const map = new Map();
  if (!Array.isArray(events)) return map;

  for (const event of events) {
    const ts = new Date(event?.timestamp);
    if (isNaN(ts.getTime())) continue;

    setMessageTimestamp(map, event.fromMessageId, ts);
    setMessageTimestamp(map, event.toMessageId, ts);
  }

  return map;
}

export async function parse() {
  const threadsDir = resolveThreadsDir();
  const threadFiles = findThreadFiles(threadsDir);
  if (threadFiles.length === 0) return { buckets: [], sessions: [] };

  const entries = [];
  const sessionEvents = [];

  for (const filePath of threadFiles) {
    let thread;
    try {
      thread = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      continue;
    }

    const sessionId = thread?.id || filePath;
    const messages = Array.isArray(thread?.messages) ? thread.messages : [];
    const ledgerEvents = Array.isArray(thread?.usageLedger?.events) ? thread.usageLedger.events : [];
    const hasLedger = ledgerEvents.length > 0;

    if (hasLedger) {
      for (const event of ledgerEvents) {
        const ts = new Date(event?.timestamp);
        if (isNaN(ts.getTime())) continue;

        const inputTokens = event?.tokens?.input || 0;
        const outputTokens = event?.tokens?.output || 0;
        if (inputTokens === 0 && outputTokens === 0) continue;

        const toMessage = Number.isInteger(event.toMessageId) ? messages[event.toMessageId] : null;
        const cacheReadInputTokens = toMessage?.usage?.cacheReadInputTokens || 0;
        const cacheCreationInputTokens = toMessage?.usage?.cacheCreationInputTokens || 0;

        entries.push({
          source: 'amp',
          model: event?.model || 'unknown',
          project: 'unknown',
          timestamp: ts,
          inputTokens,
          outputTokens,
          cachedInputTokens: cacheReadInputTokens,
          cacheCreationInputTokens,
          reasoningOutputTokens: 0,
        });
      }
    } else {
      for (const message of messages) {
        const usage = message?.usage;
        if (!usage) continue;

        const ts = new Date(message?.timestamp || thread?.created);
        if (isNaN(ts.getTime())) continue;

        const inputTokens = usage.inputTokens || 0;
        const outputTokens = usage.outputTokens || 0;
        if (inputTokens === 0 && outputTokens === 0 && (usage.cacheReadInputTokens || 0) === 0) continue;

        entries.push({
          source: 'amp',
          model: usage.model || 'unknown',
          project: 'unknown',
          timestamp: ts,
          inputTokens,
          outputTokens,
          cachedInputTokens: usage.cacheReadInputTokens || 0,
          cacheCreationInputTokens: usage.cacheCreationInputTokens || 0,
          reasoningOutputTokens: 0,
        });
      }
    }

    const messageTsMap = buildMessageTimestampMap(ledgerEvents);
    const baseTimestamp = new Date(thread?.created);
    const hasBaseTimestamp = !isNaN(baseTimestamp.getTime());

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const mappedTs = messageTsMap.get(i);
      const ts = mappedTs || (hasBaseTimestamp ? baseTimestamp : null);
      if (!ts || isNaN(ts.getTime())) continue;

      sessionEvents.push({
        sessionId,
        source: 'amp',
        project: 'unknown',
        timestamp: ts,
        role: message?.role === 'user' ? 'user' : 'assistant',
      });
    }
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(sessionEvents) };
}
