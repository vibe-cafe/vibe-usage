import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { aggregateToBuckets, extractSessions } from './index.js';

/**
 * Kimi CLI parser (a.k.a. "Kimi Code"). MoonshotAI/kimi-cli.
 *
 * Wire protocol JSONL at ~/.kimi/sessions/<md5(workdir)>/<session-id>/wire.jsonl
 * - First line is a metadata header: {"type":"metadata","protocol_version":"1.9"}
 * - Each subsequent line (1.9):  {"timestamp": <float seconds>, "message": {"type", "payload"}}
 * - Legacy 1.1 line:             {"type", "payload"}  (no message wrapper, ts may live in payload)
 *
 * Token data: StatusUpdate.payload.token_usage
 *   = {input_other, output, input_cache_read, input_cache_creation}
 *
 * Model name is NOT present on StatusUpdate events; we read it from
 * ~/.kimi/config.toml (default_model, falling back to first [models.X] table).
 *
 * Project name comes from ~/.kimi/kimi.json -> work_dirs[].path; the dir name
 * under sessions/ is md5(path).
 */

const KIMI_DIR = join(homedir(), '.kimi');
const KIMI_SESSIONS_DIR = join(KIMI_DIR, 'sessions');
const KIMI_WORKDIRS_JSON = join(KIMI_DIR, 'kimi.json');
const KIMI_CONFIG_TOML = join(KIMI_DIR, 'config.toml');

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

function projectNameFromPath(path) {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

function loadProjectMap() {
  const map = new Map();
  if (!existsSync(KIMI_WORKDIRS_JSON)) return map;

  let config;
  try {
    config = JSON.parse(readFileSync(KIMI_WORKDIRS_JSON, 'utf-8'));
  } catch {
    return map;
  }

  // 1.9 schema: { work_dirs: [{ path, kaos, last_session_id }] }
  if (Array.isArray(config.work_dirs)) {
    for (const entry of config.work_dirs) {
      const path = entry?.path;
      if (typeof path !== 'string' || !path) continue;
      const hash = createHash('md5').update(path).digest('hex');
      map.set(hash, projectNameFromPath(path));
    }
  }

  // Legacy schemas keyed by hash
  for (const key of ['workspaces', 'projects']) {
    const obj = config[key];
    if (!obj || typeof obj !== 'object') continue;
    for (const [hash, info] of Object.entries(obj)) {
      const path = typeof info === 'string' ? info : (info?.path || info?.dir);
      if (typeof path === 'string' && path) map.set(hash, projectNameFromPath(path));
    }
  }

  return map;
}

// Matches both bare-key `[models.kimi-for-coding]` and quoted
// `[models."kimi-code/kimi-for-coding"]` forms (TOML bare keys can't
// contain `/`, so quoting is mandatory for hierarchical names).
const TOML_MODEL_SECTION_RE = /^\s*\[models\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]/m;
const TOML_DEFAULT_MODEL_RE = /^\s*default_model\s*=\s*["']([^"']+)["']/m;

function loadModelFromConfig() {
  if (!existsSync(KIMI_CONFIG_TOML)) return 'unknown';

  let content;
  try {
    content = readFileSync(KIMI_CONFIG_TOML, 'utf-8');
  } catch {
    return 'unknown';
  }

  const defaultMatch = content.match(TOML_DEFAULT_MODEL_RE);
  if (defaultMatch) return defaultMatch[1];

  const sectionMatch = content.match(TOML_MODEL_SECTION_RE);
  if (sectionMatch) return sectionMatch[1] || sectionMatch[2];

  return 'unknown';
}

const USER_EVENT_TYPES = new Set(['TurnBegin', 'UserMessage', 'user_message', 'Input']);

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
      let raw;
      try { raw = JSON.parse(line); } catch { continue; }

      // Unwrap 1.9 envelope; fall through to top-level for legacy 1.1.
      // Metadata header line has no payload and is filtered by the next check.
      const envelope = raw.message || raw;
      const type = envelope.type || raw.type;
      const payload = envelope.payload || raw.payload;
      if (!payload) continue;

      // 1.9 puts timestamp at the outer level (Unix seconds, float).
      // Legacy 1.1 sometimes puts it inside payload.
      if (typeof raw.timestamp === 'number') {
        lastTimestamp = raw.timestamp * 1000;
      } else if (typeof payload.timestamp === 'number') {
        lastTimestamp = payload.timestamp * 1000;
      }
      if (payload.model) currentModel = payload.model;

      if (lastTimestamp) {
        const evTs = new Date(lastTimestamp);
        if (!isNaN(evTs.getTime())) {
          sessionEvents.push({
            sessionId: filePath,
            source: 'kimi-code',
            project,
            timestamp: evTs,
            role: USER_EVENT_TYPES.has(type) ? 'user' : 'assistant',
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
    }
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(sessionEvents) };
}
