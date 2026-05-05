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
const KIMI_CONFIG_TOML = join(homedir(), '.kimi', 'config.toml');

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

function loadModelFromConfig() {
  if (!existsSync(KIMI_CONFIG_TOML)) return 'unknown';

  try {
    const content = readFileSync(KIMI_CONFIG_TOML, 'utf-8');
    // Try default_model first
    const defaultMatch = content.match(/default_model\s*=\s*["']([^"']+)["']/);
    if (defaultMatch) return defaultMatch[1];

    // Fall back to first model section name
    const sectionMatch = content.match(/\[models\."([^"]+)"\]/);
    if (sectionMatch) return sectionMatch[1];

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function parse() {
  const wireFiles = findWireFiles(KIMI_SESSIONS_DIR);
  if (wireFiles.length === 0) return { buckets: [], sessions: [] };

  const projectMap = loadProjectMap();
  const defaultModel = loadModelFromConfig();
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
    let currentModel = defaultModel;
    let lastTimestamp = null;

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        // Bug 1: Handle wire protocol 1.9 message wrapper
        const message = obj.message || obj;
        const type = message.type || obj.type;
        const payload = message.payload || obj.payload;
        if (!payload) continue;

        // Bug 2: Kimi CLI uses Unix seconds, convert to ms for Date()
        if (obj.timestamp) lastTimestamp = obj.timestamp * 1000;
        else if (payload.timestamp) lastTimestamp = payload.timestamp * 1000;

        if (payload.model) currentModel = payload.model;

        if (lastTimestamp) {
          const evTs = new Date(lastTimestamp);
          if (!isNaN(evTs.getTime())) {
            const isUser = type === 'UserMessage' || type === 'user_message' || type === 'Input';
            sessionEvents.push({
              sessionId: filePath,
              source: 'kimi-code',
              project,
              timestamp: evTs,
              role: isUser ? 'user' : 'assistant',
            });
          }
        }

        if (type !== 'StatusUpdate') continue;

        const tokenUsage = payload.token_usage;
        if (!tokenUsage) continue;
        if (!tokenUsage.input_other && !tokenUsage.output) continue;

        const messageId = payload.message_id;
        if (messageId) {
          if (seenMessageIds.has(messageId)) continue;
          seenMessageIds.add(messageId);
        }

        const ts = lastTimestamp ? new Date(lastTimestamp) : new Date();

        entries.push({
          source: 'kimi-code',
          model: currentModel,
          project,
          timestamp: ts,
          inputTokens: tokenUsage.input_other || 0,
          outputTokens: tokenUsage.output || 0,
          cachedInputTokens: tokenUsage.input_cache_read || 0,
          reasoningOutputTokens: 0,
        });
      } catch {
        continue;
      }
    }
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(sessionEvents) };
}
