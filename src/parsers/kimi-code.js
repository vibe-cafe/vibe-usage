import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { aggregateToBuckets, extractSessions } from './index.js';

/**
 * Kimi Code CLI parser. MoonshotAI/kimi-cli (a.k.a. "Kimi Code").
 *
 * Two on-disk layouts are supported:
 *
 * 1. Current ("~/.kimi-code", protocol >= 1.4). Sessions live at
 *      ~/.kimi-code/sessions/wd_<slug>_<hash>/session_<id>/agents/<agentId>/wire.jsonl
 *    Each line is a self-describing event with a top-level integer-ms `time`:
 *      {"type":"usage.record","model":"kimi-code/kimi-for-coding",
 *       "usage":{"inputOther","output","inputCacheRead","inputCacheCreation"},
 *       "usageScope":"turn","time":<ms>}
 *    `usage.record` events are per-step deltas (one per assistant step), so they
 *    sum to the session total. The model name rides on each record — no config
 *    lookup needed. User turns are `turn.prompt` with origin.kind === "user".
 *    The real working directory per session is recorded in
 *      ~/.kimi-code/session_index.jsonl  -> {sessionId, sessionDir, workDir}
 *    which gives an accurate project name (last path component of workDir).
 *
 * 2. Legacy ("~/.kimi", protocol 1.1 / 1.9). Sessions live at
 *      ~/.kimi/sessions/<md5(workdir)>/<session-id>/wire.jsonl
 *    with a different envelope (StatusUpdate.payload.token_usage, float-second
 *    `timestamp`) and the model in ~/.kimi/config.toml. Kept for users who have
 *    not migrated; see parseLegacyKimi() below.
 */

// ---------------------------------------------------------------------------
// Current format: ~/.kimi-code
// ---------------------------------------------------------------------------

const KIMI_CODE_DIR = join(homedir(), '.kimi-code');
const KIMI_CODE_SESSIONS_DIR = join(KIMI_CODE_DIR, 'sessions');
const KIMI_CODE_SESSION_INDEX = join(KIMI_CODE_DIR, 'session_index.jsonl');

function projectNameFromPath(path) {
  if (typeof path !== 'string' || !path) return null;
  return basename(path.replace(/[/\\]+$/, '')) || path;
}

/**
 * Map each session directory (absolute path) to a project name, read from
 * ~/.kimi-code/session_index.jsonl. Falls back gracefully if the file is
 * missing or malformed — callers default to the wd_ bucket name.
 */
function loadSessionIndex() {
  const map = new Map();
  if (!existsSync(KIMI_CODE_SESSION_INDEX)) return map;

  let content;
  try {
    content = readFileSync(KIMI_CODE_SESSION_INDEX, 'utf-8');
  } catch {
    return map;
  }

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const dir = entry?.sessionDir;
    const project = projectNameFromPath(entry?.workDir);
    if (typeof dir === 'string' && dir && project) map.set(dir, project);
  }
  return map;
}

// Strip the trailing _<hash> from a "wd_<slug>_<hash>" bucket name so the slug
// can serve as a last-resort project label when session_index has no entry.
function projectFromBucketName(name) {
  const m = /^wd_(.+)_[0-9a-f]+$/.exec(name);
  return m ? m[1] : name;
}

// Collect every agents/<id>/wire.jsonl under sessions/wd_<...>/session_<...>/.
function findKimiCodeWireFiles(baseDir) {
  const results = [];
  if (!existsSync(baseDir)) return results;

  let workDirs;
  try {
    workDirs = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const workDir of workDirs) {
    if (!workDir.isDirectory()) continue;
    const workDirPath = join(baseDir, workDir.name);
    const bucketProject = projectFromBucketName(workDir.name);

    let sessions;
    try {
      sessions = readdirSync(workDirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const sessionDir = join(workDirPath, session.name);
      const agentsDir = join(sessionDir, 'agents');

      let agents;
      try {
        agents = readdirSync(agentsDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const agent of agents) {
        if (!agent.isDirectory()) continue;
        const wireFile = join(agentsDir, agent.name, 'wire.jsonl');
        if (existsSync(wireFile)) {
          results.push({ wireFile, sessionDir, bucketProject });
        }
      }
    }
  }
  return results;
}

function parseKimiCode() {
  const wireFiles = findKimiCodeWireFiles(KIMI_CODE_SESSIONS_DIR);
  if (wireFiles.length === 0) return null;

  const sessionIndex = loadSessionIndex();
  const entries = [];
  const sessionEvents = [];

  for (const { wireFile, sessionDir, bucketProject } of wireFiles) {
    let content;
    try {
      content = readFileSync(wireFile, 'utf-8');
    } catch {
      continue;
    }

    const project = sessionIndex.get(sessionDir) || bucketProject || 'unknown';

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }

      const type = evt.type;
      // Top-level `time` is integer milliseconds since epoch.
      const time = typeof evt.time === 'number' ? evt.time : null;

      // Session timing: a user turn vs. anything the model emits.
      if (type === 'turn.prompt' && evt.origin?.kind === 'user' && time) {
        const ts = new Date(time);
        if (!isNaN(ts.getTime())) {
          sessionEvents.push({ sessionId: wireFile, source: 'kimi-code', project, timestamp: ts, role: 'user' });
        }
        continue;
      }

      if (type !== 'usage.record') continue;

      const usage = evt.usage;
      if (!usage) continue;

      const inputTokens = usage.inputOther || 0;
      const outputTokens = usage.output || 0;
      const cachedInputTokens = usage.inputCacheRead || 0;
      if (!inputTokens && !outputTokens && !cachedInputTokens) continue;

      const ts = time ? new Date(time) : new Date();

      entries.push({
        source: 'kimi-code',
        model: evt.model || 'unknown',
        project,
        timestamp: ts,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        reasoningOutputTokens: 0,
      });

      // Each usage.record marks an assistant step completing — use it as an
      // assistant timing event so active-time math has both sides of a turn.
      if (time && !isNaN(ts.getTime())) {
        sessionEvents.push({ sessionId: wireFile, source: 'kimi-code', project, timestamp: ts, role: 'assistant' });
      }
    }
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(sessionEvents) };
}

// ---------------------------------------------------------------------------
// Legacy format: ~/.kimi  (kept for users who haven't migrated to ~/.kimi-code)
// ---------------------------------------------------------------------------

const KIMI_DIR = join(homedir(), '.kimi');
const KIMI_SESSIONS_DIR = join(KIMI_DIR, 'sessions');
const KIMI_WORKDIRS_JSON = join(KIMI_DIR, 'kimi.json');
const KIMI_CONFIG_TOML = join(KIMI_DIR, 'config.toml');

function findLegacyWireFiles(baseDir) {
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

function loadLegacyProjectMap() {
  const map = new Map();
  if (!existsSync(KIMI_WORKDIRS_JSON)) return map;

  let config;
  try {
    config = JSON.parse(readFileSync(KIMI_WORKDIRS_JSON, 'utf-8'));
  } catch {
    return map;
  }

  if (Array.isArray(config.work_dirs)) {
    for (const entry of config.work_dirs) {
      const path = entry?.path;
      if (typeof path !== 'string' || !path) continue;
      const hash = createHash('md5').update(path).digest('hex');
      map.set(hash, projectNameFromPath(path));
    }
  }

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

const TOML_MODEL_SECTION_RE = /^\s*\[models\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]/m;
const TOML_DEFAULT_MODEL_RE = /^\s*default_model\s*=\s*["']([^"']+)["']/m;

function loadLegacyModelFromConfig() {
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

const LEGACY_USER_EVENT_TYPES = new Set(['TurnBegin', 'UserMessage', 'user_message', 'Input']);

function parseLegacyKimi() {
  const wireFiles = findLegacyWireFiles(KIMI_SESSIONS_DIR);
  if (wireFiles.length === 0) return { buckets: [], sessions: [] };

  const projectMap = loadLegacyProjectMap();
  const defaultModel = loadLegacyModelFromConfig();
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

      const envelope = raw.message || raw;
      const type = envelope.type || raw.type;
      const payload = envelope.payload || raw.payload;
      if (!payload) continue;

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
            role: LEGACY_USER_EVENT_TYPES.has(type) ? 'user' : 'assistant',
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

export async function parse() {
  // Prefer the current ~/.kimi-code layout; fall back to legacy ~/.kimi only
  // when no kimi-code sessions exist, so migrated users aren't double-counted.
  const current = parseKimiCode();
  if (current) return current;
  return parseLegacyKimi();
}
