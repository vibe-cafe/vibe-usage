import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './index.js';
import { listDbCascades, readDbUsageRecords, readDbWorkspaceUri, readDbSessionEvents } from './antigravity-db.js';



/**
 * Antigravity parser.
 *
 * Two conversation stores, two read paths:
 *  - `.db` cascades (App 2.0 + `agy` CLI): plain-protobuf SQLite, parsed offline
 *    from disk — no running process required (see antigravity-db.js).
 *  - `.pb` cascades (legacy App history): encrypted/opaque, only decodable via a
 *    running language server's GetCascadeTrajectory RPC (fallback below).
 * A cascade backed by a `.db` never uses RPC, so the two paths never double-count.
 */

const SOURCE = 'antigravity';
const CONVERSATIONS_DIR = join(homedir(), '.gemini', 'antigravity', 'conversations');
// `agy` CLI stores conversations in a separate, App-independent directory.
const CLI_CONVERSATIONS_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'conversations');

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
  const out = execSync("ps aux | grep -i 'antigravity.*language_server'", { encoding: 'utf-8', timeout: 5000 });
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
  // Prefer PowerShell/CIM: wmic is disabled by default on Windows 11 23H2+
  // and removed entirely from 25H2 onward. Fall back to wmic for old/stripped
  // environments without PowerShell. Each probe is independently time-boxed and
  // failures are swallowed, so a missing/hung tool never blocks the next one or
  // the parsers that run after antigravity.
  const out = queryProcessesWinPowerShell() ?? queryProcessesWinWmic();
  if (!out) return null;
  return parseWinProcessList(out);
}

/**
 * Query language_server processes via PowerShell + CIM.
 * Emits "ProcessId=..." / "CommandLine=..." lines (wmic /format:list shape)
 * so parseWinProcessList handles either source. Returns null on failure.
 */
function queryProcessesWinPowerShell() {
  // Filter is applied in PowerShell so the LIKE wildcards stay server-side.
  // A "---" separator before each process's ProcessId/CommandLine lines keeps
  // fields grouped even when multiple processes match.
  const script =
    "Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%antigravity%language_server%'\" | " +
    'ForEach-Object { "---"; "ProcessId=" + $_.ProcessId; "CommandLine=" + $_.CommandLine }';
  for (const exe of ['powershell.exe', 'pwsh.exe']) {
    try {
      const out = execSync(
        `${exe} -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`,
        { encoding: 'utf-8', timeout: 4000, windowsHide: true },
      );
      if (out && out.trim()) return out;
      // Empty (no matching process) — no point trying another shell.
      return null;
    } catch {
      // Try next shell (pwsh on systems without legacy powershell.exe).
    }
  }
  return null;
}

/** Legacy fallback: wmic /format:list. Returns null on failure. */
function queryProcessesWinWmic() {
  try {
    return execSync(
      'wmic process where "CommandLine like \'%antigravity%language_server%\'" get ProcessId,CommandLine /format:list',
      { encoding: 'utf-8', timeout: 4000, shell: 'cmd.exe' },
    );
  } catch {
    return null;
  }
}

/**
 * Parse "ProcessId=..." / "CommandLine=..." records (from either PowerShell or
 * wmic /format:list) and return the first language_server that carries a
 * --csrf_token, or null. PowerShell emits an explicit "---" separator per
 * process; wmic does not and may emit the two fields in either order, so a
 * record also ends whenever a field we've already captured reappears.
 */
function parseWinProcessList(out) {
  let pid = '';
  let cmdLine = '';
  const finish = () => {
    if (pid && cmdLine && !/WMIC\.exe|powershell\.exe|pwsh\.exe/i.test(cmdLine)) {
      const csrfMatch = cmdLine.match(/--csrf_token\s+([0-9a-f-]+)/);
      if (csrfMatch) return { pid, csrfToken: csrfMatch[1] };
    }
    return null;
  };
  const reset = () => { pid = ''; cmdLine = ''; };
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    const isPid = trimmed.startsWith('ProcessId=');
    const isCmd = trimmed.startsWith('CommandLine=');
    // Record boundary: explicit "---", or a field that would overwrite one we
    // already hold (next process began without a separator, e.g. wmic output).
    if (trimmed === '---' || (isPid && pid) || (isCmd && cmdLine)) {
      const found = finish();
      if (found) return found;
      reset();
    }
    if (isPid) pid = trimmed.slice('ProcessId='.length);
    else if (isCmd) cmdLine = trimmed.slice('CommandLine='.length);
  }
  return finish();
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

/**
 * Normalize model names to canonical forms.
 */
// Normalize model names to canonical forms. NOTE: only legacy .pb data (which
// exposes bare slugs via responseModel) reaches this; .db data uses the
// human-readable modelDisplayName verbatim (e.g. "Gemini 3.5 Flash (High)"),
// which is never normalized. Flash reasoning tiers (-a/-b/-c) are intentionally
// NOT merged: each tier is a distinct choice and left as-is ("as it is").
const MODEL_NORMALIZE_MAP = {
  'claude-opus-4-6-thinking': 'claude-opus-4-6',
  'claude-sonnet-4-6-thinking': 'claude-sonnet-4-6',
  "gemini-3.1-pro-high": "gemini-3.1-pro",
  "gemini-3.1-pro-low": "gemini-3.1-pro",
  "gemini-3-pro-high": "gemini-3-pro",
  "gemini-3-pro-low": "gemini-3-pro",
};

/**
 * Map internal placeholder model IDs to canonical names.
 * Used when responseModel is empty and only chatModel.model is available.
 */
const PLACEHOLDER_MODEL_MAP = {
  'MODEL_PLACEHOLDER_M37': 'gemini-3.1-pro',
  'MODEL_PLACEHOLDER_M36': 'gemini-3.1-pro',
  'MODEL_PLACEHOLDER_M47': 'gemini-3-flash',
  'MODEL_PLACEHOLDER_M35': 'claude-sonnet-4-6',
  'MODEL_PLACEHOLDER_M26': 'claude-opus-4-6',
  'MODEL_OPENAI_GPT_OSS_120B_MEDIUM': 'gpt-oss-120b',
};

function normalizeModel(raw) {
  return MODEL_NORMALIZE_MAP[raw] || raw;
}

/**
 * Resolve a display model name from a chatModel-like object.
 * Priority: modelDisplayName (real name, e.g. "Gemini 3.5 Flash (High)") →
 * responseModel slug (normalized) → placeholder map → "unknown".
 *
 * modelDisplayName is present on .db data (App 2.0 + CLI) and is authoritative;
 * it is used verbatim (carries the reasoning tier). Legacy .pb data has no
 * display name, so it falls back to the responseModel slug.
 */
function resolveModel(chatModel) {
  if (chatModel.modelDisplayName) return chatModel.modelDisplayName;
  if (chatModel.responseModel) return normalizeModel(chatModel.responseModel);
  const placeholder = chatModel.model || '';
  if (PLACEHOLDER_MODEL_MAP[placeholder]) return PLACEHOLDER_MODEL_MAP[placeholder];
  return 'unknown';
}

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
 * List cascade IDs backed by a legacy `.pb` file (App history). `.db` cascades
 * are handled separately via offline parsing.
 */
function listPbCascades() {
  try {
    const out = [];
    for (const f of readdirSync(CONVERSATIONS_DIR)) {
      if (f.endsWith('.pb')) out.push(f.slice(0, -3));
    }
    return out;
  } catch {
    return [];
  }
}

// ── Main parse ───────────────────────────────────────────────────────

/** Model name for an offline .db record: real display name → slug → unknown. */
function modelFromRecord(rec) {
  if (rec.displayName) return rec.displayName;
  if (rec.responseModel) return normalizeModel(rec.responseModel);
  return 'unknown';
}

export async function parse() {
  const entries = [];
  const sessionEvents = [];
  const seenResponseIds = new Set();

  // ── Path 1: offline .db parsing (App 2.0 + agy CLI, no process needed) ──
  const dbHandled = new Set();
  for (const dir of [CONVERSATIONS_DIR, CLI_CONVERSATIONS_DIR]) {
    for (const cascadeId of listDbCascades(dir)) {
      const records = readDbUsageRecords(dir, cascadeId);
      const project = projectFromUri(readDbWorkspaceUri(dir, cascadeId)) || 'unknown';

      if (records.length > 0) {
        dbHandled.add(cascadeId);
        for (const rec of records) {
          if (rec.responseId && seenResponseIds.has(rec.responseId)) continue;
          if (rec.responseId) seenResponseIds.add(rec.responseId);
          if (!rec.timestamp || isNaN(rec.timestamp.getTime())) continue;
          entries.push({
            source: SOURCE,
            model: modelFromRecord(rec),
            project,
            timestamp: rec.timestamp,
            inputTokens: toSafeNumber(rec.inputTokens),
            outputTokens: toSafeNumber(rec.outputTokens),
            cachedInputTokens: toSafeNumber(rec.cacheReadTokens),
            reasoningOutputTokens: toSafeNumber(rec.thinkingOutputTokens),
          });
        }
      }

      // Session timing from steps (independent of token usage presence).
      for (const ev of readDbSessionEvents(dir, cascadeId)) {
        sessionEvents.push({
          sessionId: cascadeId,
          source: SOURCE,
          project,
          timestamp: ev.timestamp,
          role: ev.role,
        });
      }
    }
  }

  // ── Path 2: RPC fallback, only for legacy .pb cascades not already parsed ──
  const pbCascades = listPbCascades().filter((id) => !dbHandled.has(id));
  if (pbCascades.length > 0) {
    const server = findLanguageServer();
    const ports = server ? findListeningPorts(server.pid) : [];
    const baseUrl = ports.length > 0 ? await probeHttpPort(ports, server.csrfToken) : null;
    if (baseUrl) {
      const rpc = (method, body) =>
        rpcPost(
          baseUrl,
          `/exa.language_server_pb.LanguageServerService/${method}`,
          body,
          server.csrfToken,
        );

      for (const cascadeId of pbCascades) {
        let resp;
        try {
          resp = await rpc('GetCascadeTrajectory', { cascadeId });
        } catch {
          continue;
        }
        const trajectory = resp?.trajectory;
        if (!trajectory) continue;

        const steps = trajectory.steps || [];
        const metadataList = trajectory.generatorMetadata || [];

        let project = 'unknown';
        const workspaces = trajectory.metadata?.workspaces || [];
        if (workspaces.length > 0) {
          project = workspaces[0].repository?.computedName
            || projectFromUri(workspaces[0].workspaceFolderAbsoluteUri)
            || 'unknown';
        }

        for (const meta of metadataList) {
          const chatModel = meta?.chatModel;
          if (!chatModel) continue;
          const model = resolveModel(chatModel);
          const createdAt = chatModel?.chatStartMetadata?.createdAt;
          const ts = createdAt ? new Date(createdAt) : null;
          if (!ts || isNaN(ts.getTime())) continue;

          for (const retry of (chatModel.retryInfos || [])) {
            const usage = retry.usage;
            if (!usage) continue;
            const responseId = usage.responseId || '';
            if (responseId && seenResponseIds.has(responseId)) continue;
            if (responseId) seenResponseIds.add(responseId);
            entries.push({
              source: SOURCE,
              model,
              project,
              timestamp: ts,
              inputTokens: toSafeNumber(usage.inputTokens),
              outputTokens: toSafeNumber(usage.outputTokens),
              cachedInputTokens: toSafeNumber(usage.cacheReadTokens),
              reasoningOutputTokens: toSafeNumber(usage.thinkingOutputTokens),
            });
          }
        }

        for (const step of steps) {
          const stepSource = step?.metadata?.source || '';
          let role;
          if (USER_SOURCES.has(stepSource)) role = 'user';
          else if (ASSISTANT_SOURCES.has(stepSource)) role = 'assistant';
          else continue;
          const createdAt = step?.metadata?.createdAt;
          const ts = createdAt ? new Date(createdAt) : null;
          if (!ts || isNaN(ts.getTime())) continue;
          sessionEvents.push({ sessionId: cascadeId, source: SOURCE, project, timestamp: ts, role });
        }
      }
    }
  }

  return {
    buckets: aggregateToBuckets(entries),
    sessions: extractSessions(sessionEvents),
  };
}
