import { execSync } from 'node:child_process';
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './index.js';
import { CONFIG_DIR } from '../config.js';

// ── Antigravity sync state ──────────────────────────────────────────
// Tracks per-cascade file mtime so we only re-parse changed .pb files.
// Format: { "<cascade-id>": { "mtimeMs": <number> } }

const isDev = process.env.VIBE_USAGE_DEV === '1';
const ANTIGRAVITY_SYNC_FILE = join(CONFIG_DIR, isDev ? 'antigravity-sync.dev.json' : 'antigravity-sync.json');

export function loadAntigravitySyncState() {
  if (!existsSync(ANTIGRAVITY_SYNC_FILE)) return {};
  try {
    return JSON.parse(readFileSync(ANTIGRAVITY_SYNC_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveAntigravitySyncState(state) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(ANTIGRAVITY_SYNC_FILE, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

/**
 * Antigravity parser (file-based).
 * Scans .pb files in ~/.gemini/antigravity/conversations/ to discover cascade IDs.
 * Only processes files that are new or modified since last sync.
 * Calls GetCascadeTrajectory via a running language server to extract token usage
 * (from generatorMetadata) and session events (from trajectory steps).
 */

const SOURCE = 'antigravity';
const CONVERSATIONS_DIR = join(homedir(), '.gemini', 'antigravity', 'conversations');

// User sources → role 'user'; Model source → role 'assistant'; System sources → skip
const USER_SOURCES = new Set([
  'CORTEX_STEP_SOURCE_USER_EXPLICIT',
  'CORTEX_STEP_SOURCE_USER_IMPLICIT',
]);
const ASSISTANT_SOURCES = new Set([
  'CORTEX_STEP_SOURCE_MODEL',
]);

// ── Process discovery (single instance) ──────────────────────────────

const IS_WIN = process.platform === 'win32';

/**
 * Find ONE running language server process with a CSRF token.
 * Returns { pid, csrfToken } or null.
 */
function findLanguageServer() {
  try {
    return IS_WIN ? findLanguageServerWin() : findLanguageServerUnix();
  } catch {
    return null;
  }
}

function findLanguageServerUnix() {
  const out = execSync("ps aux | grep 'antigravity/bin/language_server_'", { encoding: 'utf-8', timeout: 5000 });
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    if (line.includes('grep')) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = parts[1];
    const csrfMatch = line.match(/--csrf_token\s+([0-9a-f-]+)/);
    const csrfToken = csrfMatch ? csrfMatch[1] : '';
    if (csrfToken) return { pid, csrfToken };
  }
  return null;
}

function findLanguageServerWin() {
  const out = execSync(
    'wmic process where "CommandLine like \'%antigravity%language_server%\'" get ProcessId,CommandLine /format:list',
    { encoding: 'utf-8', timeout: 5000, shell: 'cmd.exe' },
  );
  // wmic /format:list outputs lines like "CommandLine=..." and "ProcessId=..."
  let cmdLine = '';
  let pid = '';
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('CommandLine=')) {
      const val = trimmed.slice('CommandLine='.length);
      if (/WMIC\.exe/i.test(val)) continue; // skip wmic's own process
      cmdLine = val;
    }
    if (trimmed.startsWith('ProcessId=')) pid = trimmed.slice('ProcessId='.length);
  }
  if (!pid || !cmdLine) return null;
  const csrfMatch = cmdLine.match(/--csrf_token\s+([0-9a-f-]+)/);
  const csrfToken = csrfMatch ? csrfMatch[1] : '';
  if (!csrfToken) return null;
  return { pid, csrfToken };
}

function findListeningPorts(pid) {
  try {
    return IS_WIN ? findListeningPortsWin(pid) : findListeningPortsUnix(pid);
  } catch {
    return [];
  }
}

function findListeningPortsUnix(pid) {
  const out = execSync(`lsof -iTCP -sTCP:LISTEN -nP -a -p ${pid}`, {
    encoding: 'utf-8',
    timeout: 5000,
  });
  const ports = [];
  for (const line of out.split('\n')) {
    const match = line.match(/:(\d+)\s+\(LISTEN\)/);
    if (match) ports.push(parseInt(match[1], 10));
  }
  return ports;
}

function findListeningPortsWin(pid) {
  // netstat output: TCP  127.0.0.1:49327  0.0.0.0:0  LISTENING  12345
  const out = execSync('netstat -ano', { encoding: 'utf-8', timeout: 5000 });
  const ports = [];
  for (const line of out.split('\n')) {
    if (!line.includes('LISTENING')) continue;
    const parts = line.trim().split(/\s+/);
    // parts: [TCP, local_addr:port, foreign_addr, LISTENING, pid]
    const linePid = parts[parts.length - 1];
    if (linePid !== String(pid)) continue;
    const addrMatch = parts[1]?.match(/:(\d+)$/);
    if (addrMatch) ports.push(parseInt(addrMatch[1], 10));
  }
  return ports;
}

async function rpcPost(baseUrl, path, body, csrfToken, timeoutMs = 10000) {
  const url = new URL(path, baseUrl);
  const headers = {
    'Content-Type': 'application/json',
    'Connect-Protocol-Version': '1',
  };
  if (csrfToken) headers['X-Codeium-Csrf-Token'] = csrfToken;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
  return res.json();
}

async function probeHttpPort(ports, csrfToken) {
  for (const port of ports) {
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await rpcPost(
        baseUrl,
        '/exa.language_server_pb.LanguageServerService/GetWorkspaceInfos',
        {},
        csrfToken,
        3000,
      );
      return baseUrl;
    } catch {
      // Not the right port, try next
    }
  }
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────

function toSafeNumber(value) {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Extract project name from a workspace URI (e.g. "file:///Users/x/myproject" → "myproject").
 */
function projectFromUri(uri) {
  if (!uri) return null;
  const parts = uri.replace(/\/$/, '').split('/');
  return parts[parts.length - 1] || null;
}

/**
 * List .pb files and return [{ cascadeId, mtimeMs }].
 */
function listCascadeFiles() {
  try {
    const files = readdirSync(CONVERSATIONS_DIR);
    const results = [];
    for (const f of files) {
      if (!f.endsWith('.pb')) continue;
      const cascadeId = f.slice(0, -3); // strip .pb
      try {
        const st = statSync(join(CONVERSATIONS_DIR, f));
        results.push({ cascadeId, mtimeMs: st.mtimeMs });
      } catch {
        // skip unreadable files
      }
    }
    return results;
  } catch {
    return [];
  }
}

// ── Main parse ───────────────────────────────────────────────────────

export async function parse() {
  // Step 1: List cascade .pb files and filter to new/changed
  const allFiles = listCascadeFiles();
  if (allFiles.length === 0) return { buckets: [], sessions: [] };

  const syncState = loadAntigravitySyncState();
  const changedFiles = allFiles.filter((f) => {
    const prev = syncState[f.cascadeId];
    return !prev || f.mtimeMs > prev.mtimeMs;
  });

  if (changedFiles.length === 0) return { buckets: [], sessions: [] };

  // Step 2: Find a running language server to make RPC calls
  const server = findLanguageServer();
  if (!server) return { buckets: [], sessions: [] };

  const ports = findListeningPorts(server.pid);
  if (ports.length === 0) return { buckets: [], sessions: [] };

  const baseUrl = await probeHttpPort(ports, server.csrfToken);
  if (!baseUrl) return { buckets: [], sessions: [] };

  console.log("[antigravity] get base url", baseUrl);
  const rpc = (method, body) =>
    rpcPost(
      baseUrl,
      `/exa.language_server_pb.LanguageServerService/${method}`,
      body,
      server.csrfToken,
    );

  // Step 3: Fetch trajectory for each changed cascade
  const entries = [];
  const sessionEvents = [];
  const seenResponseIds = new Set();

  console.log("[antigravity] changed files", changedFiles);

  for (const { cascadeId, mtimeMs } of changedFiles) {
    let resp;
    try {
      resp = await rpc('GetCascadeTrajectory', { cascadeId });
    } catch {
      continue; // skip this cascade if RPC fails
    }

    const trajectory = resp?.trajectory;
    if (!trajectory) continue;

    const steps = trajectory.steps || [];
    const metadataList = trajectory.generatorMetadata || [];

    console.log("[antigravity] trajectory has ", steps.length, "steps");
    console.log("[antigravity] metadataList has ", metadataList.length, "metadataList");

    // Extract project from trajectory metadata workspaces
    let project = 'unknown';
    const workspaces = trajectory.metadata?.workspaces || [];
    if (workspaces.length > 0) {
      project = workspaces[0].repository?.computedName || projectFromUri(workspaces[0].workspaceFolderAbsoluteUri) || 'unknown';
    }

    // ── Token entries from generatorMetadata ──
    for (const meta of metadataList) {
      const chatModel = meta?.chatModel;
      if (!chatModel) continue;

      const responseModel = chatModel.responseModel || 'unknown';
      const createdAt = chatModel?.chatStartMetadata?.createdAt;
      const ts = createdAt ? new Date(createdAt) : null;
      if (!ts || isNaN(ts.getTime())) continue;

      const retryInfos = chatModel.retryInfos || [];
      for (const retry of retryInfos) {
        const usage = retry.usage;
        if (!usage) continue;

        const responseId = usage.responseId || '';
        if (responseId && seenResponseIds.has(responseId)) continue;
        if (responseId) seenResponseIds.add(responseId);

        entries.push({
          source: SOURCE,
          model: responseModel,
          project,
          timestamp: ts,
          inputTokens: toSafeNumber(usage.inputTokens),
          outputTokens: toSafeNumber(usage.outputTokens),
          cachedInputTokens: toSafeNumber(usage.cacheReadTokens),
          reasoningOutputTokens: toSafeNumber(usage.thinkingOutputTokens),
        });
      }
    }

    // ── Session events from trajectory steps ──
    for (const step of steps) {
      const stepSource = step?.metadata?.source || '';
      let role;
      if (USER_SOURCES.has(stepSource)) {
        role = 'user';
      } else if (ASSISTANT_SOURCES.has(stepSource)) {
        role = 'assistant';
      } else {
        continue; // skip SYSTEM / SYSTEM_SDK / UNSPECIFIED
      }

      const createdAt = step?.metadata?.createdAt;
      const ts = createdAt ? new Date(createdAt) : null;
      if (!ts || isNaN(ts.getTime())) continue;

      sessionEvents.push({
        sessionId: cascadeId,
        source: SOURCE,
        project,
        timestamp: ts,
        role,
      });
    }

    // Mark this cascade as synced
    syncState[cascadeId] = { mtimeMs };
  }

  // Step 4: Save updated sync state
  saveAntigravitySyncState(syncState);

  return {
    buckets: aggregateToBuckets(entries),
    sessions: extractSessions(sessionEvents),
  };
}
