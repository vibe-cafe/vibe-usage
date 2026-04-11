import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './index.js';

/**
 * Kimi Code CLI parser.
 * Wire protocol JSONL at ~/.kimi/sessions/<work-dir-hash>/<session-id>/wire.jsonl
 * Token data from StatusUpdate events: payload.token_usage.{input_other, output,
 *   input_cache_read, input_cache_creation}
 */

const KIMI_SESSIONS_DIR = join(homedir(), '.kimi', 'sessions');
const KIMI_CONFIG = join(homedir(), '.kimi', 'kimi.json');

function parseTimestamp(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string') {
    const asNumber = Number(value);
    if (!Number.isNaN(asNumber)) {
      const ms = asNumber > 1e12 ? asNumber : asNumber * 1000;
      const date = new Date(ms);
      return isNaN(date.getTime()) ? null : date;
    }
  }
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

function findWireFiles(baseDir) {
  const results = [];
  if (!existsSync(baseDir)) return results;

  try {
    for (const workDir of readdirSync(baseDir, { withFileTypes: true })) {
      if (!workDir.isDirectory()) continue;
      const workDirPath = join(baseDir, workDir.name);

      try {
        for (const session of readdirSync(workDirPath, { withFileTypes: true })) {
          if (!session.isDirectory()) continue;
          const wireFile = join(workDirPath, session.name, 'wire.jsonl');
          if (existsSync(wireFile)) {
            results.push({ filePath: wireFile, workDirHash: workDir.name });
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

function loadProjectMap() {
  const map = new Map();
  if (!existsSync(KIMI_CONFIG)) return map;

  try {
    const config = JSON.parse(readFileSync(KIMI_CONFIG, 'utf-8'));
    const workspaces = config.workspaces || config.projects || {};
    for (const [hash, info] of Object.entries(workspaces)) {
      const path = typeof info === 'string' ? info : (info?.path || info?.dir);
      if (path) {
        const parts = path.split('/').filter(Boolean);
        map.set(hash, parts[parts.length - 1] || hash);
      }
    }
  } catch {
    // config unreadable
  }
  return map;
}

export async function parse() {
  const wireFiles = findWireFiles(KIMI_SESSIONS_DIR);
  if (wireFiles.length === 0) return { buckets: [], sessions: [] };

  const projectMap = loadProjectMap();
  const entries = [];
  const sessionEvents = [];
  const seenMessageIds = new Set();

  for (const { filePath, workDirHash } of wireFiles) {
    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const project = projectMap.get(workDirHash) || workDirHash;
    let currentModel = 'unknown';
    let lastTimestamp = null;

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const message = obj.message && typeof obj.message === 'object' ? obj.message : null;
        const type = message?.type || obj.type;
        const payload = message?.payload ?? obj.payload;
        if (!type || !payload || typeof payload !== 'object') continue;

        const eventTimestamp = parseTimestamp(obj.timestamp ?? payload.timestamp);
        if (eventTimestamp) lastTimestamp = eventTimestamp;
        if (payload.model) currentModel = payload.model;

        const sessionTimestamp = eventTimestamp || lastTimestamp;
        if (sessionTimestamp) {
          const isUser =
            type === 'UserMessage' ||
            type === 'user_message' ||
            type === 'Input' ||
            type === 'TurnBegin';
          sessionEvents.push({
            sessionId: filePath,
            source: 'kimi-code',
            project,
            timestamp: sessionTimestamp,
            role: isUser ? 'user' : 'assistant',
          });
        }

        if (type !== 'StatusUpdate') continue;

        const tokenUsage = payload.token_usage || payload.tokenUsage;
        if (!tokenUsage) continue;
        const inputOther = tokenUsage.input_other || 0;
        const output = tokenUsage.output || 0;
        const cacheRead = tokenUsage.input_cache_read || 0;
        const cacheCreation = tokenUsage.input_cache_creation || 0;
        if (!inputOther && !output && !cacheRead && !cacheCreation) continue;

        const messageId = payload.message_id;
        if (messageId) {
          if (seenMessageIds.has(messageId)) continue;
          seenMessageIds.add(messageId);
        }

        const ts = eventTimestamp || lastTimestamp || new Date();
        if (isNaN(ts.getTime())) continue;

        entries.push({
          source: 'kimi-code',
          model: currentModel,
          project,
          timestamp: ts,
          inputTokens: inputOther + cacheCreation,
          outputTokens: output,
          cachedInputTokens: cacheRead,
          reasoningOutputTokens: 0,
        });
      } catch {
        continue;
      }
    }
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(sessionEvents) };
}
