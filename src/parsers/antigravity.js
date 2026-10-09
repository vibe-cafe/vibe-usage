import { execSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { antigravityConversationDirs, normalizeExtraRoot } from '../extra-roots.js';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { hasTokenUsage, listDbCascades, readDbUsageRecords, readDbWorkspaceUri, readDbStepRows, resolveUsageTimestamp } from './antigravity-db.js';



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
// App, CLI, and the standalone IDE each have their own conversation store.
const CONVERSATIONS_DIRS = antigravityConversationDirs(homedir());

// User sources → role 'user'; Model source → role 'assistant'; System sources → skip
const USER_SOURCES = new Set([
  'CORTEX_STEP_SOURCE_USER_EXPLICIT',
  'CORTEX_STEP_SOURCE_USER_IMPLICIT',
]);
const ASSISTANT_SOURCES = new Set([
  'CORTEX_STEP_SOURCE_MODEL',
]);

// ── Process discovery ───────────────────────────────────────────────

const IS_WIN = process.platform === 'win32';

/**
 * Find running language servers with CSRF tokens. The App and standalone IDE
 * can run together, and one server cannot read the other's legacy cascades.
 */
function findLanguageServers() {
  try {
    return IS_WIN ? findLanguageServersWin() : findLanguageServersUnix();
  } catch {
    return [];
  }
}

function findLanguageServersUnix() {
  const out = execSync("ps aux | grep -i 'antigravity.*language_server'", { encoding: 'utf-8', timeout: 5000 });
  const servers = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    if (line.includes('grep')) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = parts[1];
    const csrfMatch = line.match(/--csrf_token\s+([0-9a-f-]+)/);
    const csrfToken = csrfMatch ? csrfMatch[1] : '';
    if (csrfToken) servers.push({ pid, csrfToken });
  }
  return servers;
}

function findLanguageServersWin() {
  // Prefer PowerShell/CIM: wmic is disabled by default on Windows 11 23H2+
  // and removed entirely from 25H2 onward. Fall back to wmic for old/stripped
  // environments without PowerShell. Each probe is independently time-boxed and
  // failures are swallowed, so a missing/hung tool never blocks the next one or
  // the parsers that run after antigravity.
  const out = queryProcessesWinPowerShell() ?? queryProcessesWinWmic();
  if (!out) return [];
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
 * wmic /format:list) and return each language_server that carries a
 * --csrf_token. PowerShell emits an explicit "---" separator per
 * process; wmic does not and may emit the two fields in either order, so a
 * record also ends whenever a field we've already captured reappears.
 */
export function parseWinProcessList(out) {
  const servers = [];
  let pid = '';
  let cmdLine = '';
  const finish = () => {
    if (pid && cmdLine && !/WMIC\.exe|powershell\.exe|pwsh\.exe/i.test(cmdLine)) {
      const csrfMatch = cmdLine.match(/--csrf_token\s+([0-9a-f-]+)/);
      if (csrfMatch) servers.push({ pid, csrfToken: csrfMatch[1] });
    }
  };
  const reset = () => { pid = ''; cmdLine = ''; };
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    const isPid = trimmed.startsWith('ProcessId=');
    const isCmd = trimmed.startsWith('CommandLine=');
    // Record boundary: explicit "---", or a field that would overwrite one we
    // already hold (next process began without a separator, e.g. wmic output).
    if (trimmed === '---' || (isPid && pid) || (isCmd && cmdLine)) {
      finish();
      reset();
    }
    if (isPid) pid = trimmed.slice('ProcessId='.length);
    else if (isCmd) cmdLine = trimmed.slice('CommandLine='.length);
  }
  finish();
  return servers;
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
function listPbCascades(conversationsDir) {
  try {
    const out = [];
    for (const f of readdirSync(conversationsDir)) {
      if (f.endsWith('.pb')) out.push(f.slice(0, -3));
    }
    return out;
  } catch {
    return [];
  }
}

// ── Main parse ───────────────────────────────────────────────────────

// Model ids (`GeneratorMetadata` chatModel field 3 / `ModelUsage` field 1) for
// the models current builds serve. Cross-verified against the ccusage
// Antigravity adapter's id table, which decodes the same wire format; an id
// outside this table falls through to the cascade's last named model rather
// than inventing a placeholder nobody can price.
const MODEL_ID_NAMES = {
  246: 'gemini-2.5-pro',
  312: 'gemini-2.5-flash',
  313: 'gemini-2.5-flash-thinking',
  329: 'gemini-2.5-flash-thinking',
  330: 'gemini-2.5-flash-lite',
  281: 'claude-4-sonnet',
  282: 'claude-4-sonnet',
  290: 'claude-4-opus',
  291: 'claude-4-opus',
  333: 'claude-4.5-sonnet',
  334: 'claude-4.5-sonnet',
  340: 'claude-4.5-haiku',
  341: 'claude-4.5-haiku',
  342: 'gpt-oss-120b-medium',
  1071: 'gemini-3.6-flash-high',
  1072: 'gemini-3.6-flash-medium',
  1073: 'gemini-3.6-flash-low',
  1298: 'gemini-3.7-flash-high',
  1299: 'gemini-3.7-flash-medium',
  1300: 'gemini-3.7-flash-low',
  1318: 'gemini-3.8-flash-high',
  1319: 'gemini-3.8-flash-medium',
  1320: 'gemini-3.8-flash-low',
};

/** Model name for a .db usage record: display name → slug → step model → id. */
function modelFromRecord(rec) {
  if (rec.displayName) return rec.displayName;
  if (rec.responseModel) return normalizeModel(rec.responseModel);
  if (rec.modelName) return normalizeModel(rec.modelName);
  if (rec.modelId && MODEL_ID_NAMES[rec.modelId]) return MODEL_ID_NAMES[rec.modelId];
  return 'unknown';
}

/** Identity keys naming one provider call; any shared key links two records. */
function usageIdentityKeys(rec) {
  const keys = [];
  if (rec.responseId) keys.push(`response:${rec.responseId}`);
  if (rec.providerMessageId) keys.push(`provider:${rec.providerMessageId}`);
  if (rec.messageId) keys.push(`message:${rec.messageId}`);
  return keys;
}

/** Ranking used to keep the richest copy of one call. */
function usageScore(rec) {
  return (rec.inputTokens || 0) + (rec.totalOutputTokens || 0) +
    (rec.cacheReadTokens || 0) + (rec.cacheCreationTokens || 0);
}

/** Keep the richest payload, borrowing the loser's clock and model name. */
function richerUsageRecord(a, b) {
  const [rich, poor] = usageScore(b) > usageScore(a) ? [b, a] : [a, b];
  return {
    ...rich,
    timestamp: rich.timestamp ?? poor.timestamp ?? null,
    displayName: rich.displayName || poor.displayName || '',
    responseModel: rich.responseModel || poor.responseModel || '',
  };
}

/**
 * Merge one cascade's usage records from the two tables that can carry them.
 *
 * Older stores write every call into `gen_metadata`; newer builds keep the live
 * usage on the *step* instead, so a cascade can have a moving step stream and no
 * generator usage at all — the shape where this parser used to go silently
 * empty while its session timing kept advancing. Both carriers name a call by
 * the provider's response id and, on some builds, by message ids only, so two
 * records are linked by *any* shared identity and the richest payload wins;
 * counting both would double-bill every turn that both tables saw.
 *
 * A step record with no identity at all can only be proven new when the cascade
 * has no generator usage for it to duplicate; next to generator usage it is
 * dropped rather than risk the same turn twice.
 */
function mergeCascadeUsage(genRecords, stepRows) {
  const groups = new Set();
  const byIdentity = new Map();

  const merge = (record) => {
    const keys = usageIdentityKeys(record);
    const hits = new Set();
    for (const key of keys) {
      const group = byIdentity.get(key);
      if (group) hits.add(group);
    }
    let target;
    if (hits.size === 0) {
      target = { rec: record, keys: new Set() };
      groups.add(target);
    } else {
      target = hits.values().next().value;
      for (const other of hits) {
        if (other === target) continue;
        target.rec = richerUsageRecord(target.rec, other.rec);
        for (const key of other.keys) {
          byIdentity.set(key, target);
          target.keys.add(key);
        }
        groups.delete(other);
      }
      target.rec = richerUsageRecord(target.rec, record);
    }
    for (const key of keys) {
      byIdentity.set(key, target);
      target.keys.add(key);
    }
  };

  for (const rec of genRecords) {
    merge(rec);
    // Retry entries repeat the call they belong to (same response id), so they
    // collapse into it; a genuine extra attempt keeps its own id and counts.
    for (const retry of rec.retryUsages || []) merge({ ...retry, timestamp: rec.timestamp });
  }
  const stepUsageStandsAlone = genRecords.length === 0;
  for (const row of stepRows.usages) {
    for (const usage of [row.usage, ...row.retryUsages]) {
      if (!hasTokenUsage(usage)) continue;
      if (!stepUsageStandsAlone && usageIdentityKeys(usage).length === 0) continue;
      merge({
        ...usage,
        timestamp: row.timestamp,
        displayName: '',
        responseModel: '',
        modelName: row.modelName,
      });
    }
  }

  // Records merged in first-seen order; resolve each model, carrying the
  // cascade's last named model onto records that only carry an id.
  let carriedModel = '';
  return [...groups].map((group) => {
    const model = modelFromRecord(group.rec);
    if (model !== 'unknown') carriedModel = model;
    return { ...group.rec, model: model === 'unknown' ? carriedModel || 'unknown' : model };
  });
}

export async function parse({ extraRoots = [] } = {}) {
  const entries = [];
  const sessionEvents = [];
  const warnings = [];
  const seenResponseIds = new Set();

  const extraDirs = [];
  for (const root of extraRoots) {
    const dirs = antigravityConversationDirs(root);
    let found = false;
    for (const dir of dirs) {
      try {
        readdirSync(dir);
        extraDirs.push(dir);
        found = true;
      } catch (err) {
        if (err?.code === 'ENOENT') continue;
        return {
          buckets: [],
          sessions: [],
          skipped: true,
          warnings: [`antigravity: 额外根目录读取失败，已保留上次同步数据: ${normalizeExtraRoot(root)}`],
        };
      }
    }
    if (!found) {
      return {
        buckets: [],
        sessions: [],
        skipped: true,
        warnings: [`antigravity: 额外根目录不可用，已跳过本次 Antigravity 同步: ${normalizeExtraRoot(root)}`],
      };
    }
  }

  // ── Path 1: offline .db parsing (App 2.0 + agy CLI, no process needed) ──
  const dbHandled = new Set();
  const fixtureDirs = process.env.VIBE_USAGE_ANTIGRAVITY_DIRS?.trim();
  const defaultDirs = fixtureDirs
    ? fixtureDirs.split(delimiter).filter(Boolean)
    : CONVERSATIONS_DIRS;
  const strictDirs = new Set(extraDirs);
  const conversationDirs = [...new Set([...defaultDirs, ...extraDirs])];
  const candidates = [];
  for (const dir of conversationDirs) {
    const strict = strictDirs.has(dir);
    try {
      for (const cascadeId of listDbCascades(dir, { strict })) {
        candidates.push({ dir, cascadeId, strict });
      }
    } catch {
      return {
        buckets: [], sessions: [], skipped: true,
        warnings: [`antigravity: 额外根目录读取失败，已保留上次同步数据: ${dir}`],
      };
    }
  }
  const configuredCascadeIds = new Set(
    candidates.filter(candidate => candidate.strict).map(candidate => candidate.cascadeId),
  );
  const selectedConfiguredCopies = new Map();
  for (const candidate of candidates) {
    if (!configuredCascadeIds.has(candidate.cascadeId)) continue;
    let size = 0;
    try {
      size = statSync(join(candidate.dir, `${candidate.cascadeId}.db`)).size;
    } catch {
      // The DB may move between discovery and stat; the read below will fail
      // open in the existing offline reader.
    }
    const previous = selectedConfiguredCopies.get(candidate.cascadeId);
    if (!previous || size > previous.size) selectedConfiguredCopies.set(candidate.cascadeId, { ...candidate, size });
  }

  for (const { dir, cascadeId, strict } of candidates) {
    const selected = selectedConfiguredCopies.get(cascadeId);
    if (selected && selected.dir !== dir) continue;
    try {
      const options = { strict };
      // One steps scan feeds all of it: the usage newer builds keep on the step
      // (which `gen_metadata` no longer carries), the idx → clock fallback for
      // generator rows that lost their own timestamp, and session events.
      const stepRows = readDbStepRows(dir, cascadeId, options);
      const genRecords = readDbUsageRecords(dir, cascadeId, options);
      const project = projectFromUri(readDbWorkspaceUri(dir, cascadeId)) || 'unknown';
      const records = mergeCascadeUsage(genRecords, stepRows);

      if (records.length > 0) {
        dbHandled.add(cascadeId);
        for (const rec of records) {
          if (rec.responseId && seenResponseIds.has(rec.responseId)) continue;
          if (rec.responseId) seenResponseIds.add(rec.responseId);
          // Gemini 3.7 CLI blobs dropped chatStartMetadata.createdAt (9.4.1)
          // and modelDisplayName (21); newer stores drop generator usage
          // altogether and keep it on the step. Either way the clock comes from
          // the record itself or from steps.metadata at the same idx.
          const timestamp = resolveUsageTimestamp(rec, stepRows.timestamps);
          if (!timestamp || isNaN(timestamp.getTime())) continue;
          entries.push({
            source: SOURCE,
            model: rec.model,
            project,
            timestamp,
            inputTokens: toSafeNumber(rec.inputTokens),
            outputTokens: toSafeNumber(rec.outputTokens),
            cachedInputTokens: toSafeNumber(rec.cacheReadTokens),
            // The store carries one untyped cache-write count; an unexplained
            // total belongs in the cheaper 5m tier (see the cache-write rule in
            // AGENTS.md).
            cacheCreation5mTokens: toSafeNumber(rec.cacheCreationTokens),
            reasoningOutputTokens: toSafeNumber(rec.thinkingOutputTokens),
          });
        }
      }

      // Session timing from the same steps scan (independent of token usage).
      for (const ev of stepRows.events) {
        sessionEvents.push({
          sessionId: cascadeId,
          source: SOURCE,
          project,
          timestamp: ev.timestamp,
          role: ev.role,
        });
      }
    } catch (err) {
      if (!strict) throw err;
      return {
        buckets: [], sessions: [], skipped: true,
        warnings: [`antigravity: 额外根目录读取失败，已保留上次同步数据: ${dir}`],
      };
    }
  }

  // ── Path 2: RPC fallback, only for legacy .pb cascades not already parsed ──
  const pbCascades = [...new Set(defaultDirs.flatMap(listPbCascades))]
    .filter((id) => !dbHandled.has(id));
  if (pbCascades.length > 0) {
    const pending = new Set(pbCascades);
    for (const server of findLanguageServers()) {
      const ports = findListeningPorts(server.pid);
      const baseUrl = ports.length > 0 ? await probeHttpPort(ports, server.csrfToken) : null;
      if (!baseUrl) continue;
      const rpc = (method, body) =>
        rpcPost(
          baseUrl,
          `/exa.language_server_pb.LanguageServerService/${method}`,
          body,
          server.csrfToken,
        );

      for (const cascadeId of pending) {
        let resp;
        try {
          resp = await rpc('GetCascadeTrajectory', { cascadeId });
        } catch {
          continue;
        }
        const trajectory = resp?.trajectory;
        if (!trajectory) continue;
        pending.delete(cascadeId);

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
            // The language server serializes the same GeneratorMetadata
            // protobuf the .db rows carry, where `outputTokens` (field 3) is
            // the total and thinking is one part of it — billed at the same
            // output rate, but only once.
            const totalOutputTokens = toSafeNumber(usage.outputTokens);
            const thinkingOutputTokens = toSafeNumber(usage.thinkingOutputTokens);
            const outputTokens = Math.max(0, totalOutputTokens - thinkingOutputTokens);
            entries.push({
              source: SOURCE,
              model,
              project,
              timestamp: ts,
              inputTokens: toSafeNumber(usage.inputTokens),
              outputTokens,
              cachedInputTokens: toSafeNumber(usage.cacheReadTokens),
              reasoningOutputTokens: Math.max(thinkingOutputTokens, totalOutputTokens - outputTokens),
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
      if (pending.size === 0) break;
    }
    if (pending.size > 0) {
      warnings.push(`antigravity: ${pending.size} 个旧格式会话未能读取，请打开对应的 Antigravity IDE/App 后重新同步；已保留上次同步状态。`);
    }
  }

  return {
    buckets: aggregateToBuckets(entries),
    sessions: extractSessions(sessionEvents),
    ...(warnings.length > 0 ? { skipped: true, warnings } : {}),
  };
}
