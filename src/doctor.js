import http from 'node:http';
import https from 'node:https';
import { existsSync } from 'node:fs';
import { arch, homedir, hostname as osHostname, release } from 'node:os';
import { createHash } from 'node:crypto';
import { loadConfig } from './config.js';
import { loadState, inspectStateIdentity, stateIdentity } from './state.js';
import { TOOLS } from './tools.js';
import { EXTRA_ROOT_SOURCES, extraRootList } from './extra-roots.js';
import { COLLECTOR_VERSION, resolveSurface } from './client-meta.js';
import { readSyncHistory, SYNC_FAILURE_CODES } from './sync-history.js';
import { WARNING_CODES } from './warning-codes.js';
import { daemonSummary } from './daemon-service.js';
import { sqliteImplementation } from './parsers/sqlite.js';

/**
 * `doctor` / `doctor --json` (approved 2026-11-09 by the maintainer, Hogan;
 * 一键诊断 plan, step 2, behaviour A).
 *
 * A report the user can paste into a group chat, built only from whitelisted
 * fields and fixed codes: no path, directory or project name, warning text,
 * response body, hostname or key. It reads local state (config, state.json,
 * the sync history, tool detection) and tests connectivity; it never runs a
 * parser, reads a quota or a tool credential, writes a file or uploads.
 *
 * `--json` is a cross-repository contract for the desktop apps, versioned by
 * `schemaVersion`; its fields are documented in docs/doctor-json.md. Within a
 * schema version fields are only ever added.
 */

export const DOCTOR_SCHEMA_VERSION = 1;
const DEFAULT_API_URL = 'https://vibecafe.ai';
const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/';
const PROBE_TIMEOUT_MS = 10_000;

export const PROBE_ERRORS = Object.freeze({
  timeout: '超时',
  dns_failed: '域名解析失败',
  connection_refused: '连接被拒绝',
  connection_reset: '连接被重置',
  tls_failed: 'TLS 证书校验失败',
  network_failed: '网络失败',
});

export function probeErrorCode(err) {
  const code = typeof err?.code === 'string' ? err.code : '';
  if (code === 'DOCTOR_TIMEOUT' || code === 'ETIMEDOUT') return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns_failed';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'connection_reset';
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return 'tls_failed';
  return 'network_failed';
}

/**
 * One unauthenticated GET through the same `https` module and default global
 * agent the sync uses, so it takes the same route as an upload: through the
 * environment proxy when NODE_USE_ENV_PROXY is set (Node 22.21+ / 24.5+, what
 * the Windows app sets when the system has a proxy), directly otherwise. Any
 * HTTP response counts as reachable; only the time to the response is kept.
 * The request is destroyed after the response, so no keep-alive socket holds
 * the process open.
 */
export function probeUrl(url, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      resolve({ reachable: false, latencyMs: null, error: 'network_failed' });
      return;
    }
    const started = Date.now();
    const mod = target.protocol === 'http:' ? http : https;
    const req = mod.request(target, {
      method: 'GET',
      headers: { 'User-Agent': `vibe-usage/${COLLECTOR_VERSION} doctor` },
    }, (res) => {
      clearTimeout(timer);
      resolve({ reachable: true, latencyMs: Date.now() - started, error: null });
      res.resume();
      res.on('error', () => {});
      req.destroy();
    });
    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error('timeout'), { code: 'DOCTOR_TIMEOUT' }));
    }, timeoutMs);
    timer.unref?.();
    req.on('error', (err) => {
      clearTimeout(timer);
      resolve({ reachable: false, latencyMs: null, error: probeErrorCode(err) });
    });
    req.end();
  });
}

function registryUrl(env = process.env) {
  // npx passes the user's configured registry down as npm_config_registry.
  const configured = env.npm_config_registry?.trim();
  return configured || OFFICIAL_REGISTRY;
}

function isOfficialRegistry(url) {
  try {
    return new URL(url).hostname === 'registry.npmjs.org';
  } catch {
    return false;
  }
}

/** 4 hex chars of sha256(upload hostname): tells one person's machines apart, reveals nothing. */
export function deviceTag(name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  return createHash('sha256').update(name).digest('hex').slice(0, 4);
}

function uploadedBySource(state) {
  const counts = new Map();
  const bump = (key, field) => {
    const source = key.split('|')[0];
    if (!counts.has(source)) counts.set(source, { buckets: 0, sessions: 0 });
    counts.get(source)[field]++;
  };
  for (const key of Object.keys(state?.buckets || {})) bump(key, 'buckets');
  for (const key of Object.keys(state?.sessions || {})) bump(key, 'sessions');
  return counts;
}

function extraRootCount(config, source) {
  let count = extraRootList(config?.extraRoots?.[source]).length;
  if (source === 'codex' && typeof config?.codexExtraHome === 'string' && config.codexExtraHome.trim()) count++;
  return count;
}

function toolDetected(tool, options) {
  try {
    return tool.detectDataDirs ? tool.detectDataDirs(options).length > 0 : existsSync(tool.dataDir);
  } catch {
    return false;
  }
}

function historySummary(entry) {
  return {
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    surface: entry.surface,
    cliVersion: entry.cliVersion,
    runtime: entry.runtime,
    result: entry.result,
    durationMs: entry.durationMs,
    uploaded: entry.uploaded,
    failure: entry.failure,
  };
}

/**
 * The tool in the newest sync whose parsers finished for it. A tool that ran
 * there but is absent from `tools` produced nothing and warned about nothing:
 * zeros, i.e. healthy -- so a tool that recovered no longer shows an older
 * entry's error. Entries that never got to parse (or wrote no `parsed` flag)
 * count only where they mention the tool.
 */
function lastToolSync(entries, source) {
  const entry = entries.find(item => item.tools[source] || (item.parsed && !item.pending.includes(source)));
  if (!entry) return null;
  const tool = entry.tools[source] ?? { buckets: 0, sessions: 0 };
  return {
    startedAt: entry.startedAt,
    buckets: tool.buckets,
    sessions: tool.sessions,
    skipped: tool.skipped === true,
    indexing: tool.indexing ?? null,
    warnings: tool.warnings ?? {},
    error: tool.error ?? null,
    serverDropped: tool.serverDropped ?? 0,
  };
}

function lastSyncHasData(last) {
  return Boolean(last && (last.buckets || last.sessions || last.error || last.indexing
    || last.serverDropped || Object.keys(last.warnings).length > 0));
}

/**
 * Build the report object (the `--json` payload, before scrubbing). `probe`
 * and `sqlite` are seams for tests; production uses the real ones.
 */
export async function collectDoctorReport({
  now = new Date(),
  probe = probeUrl,
  sqlite = sqliteImplementation,
  daemon = daemonSummary,
  env = process.env,
} = {}) {
  const config = loadConfig();
  const apiUrl = (typeof config?.apiUrl === 'string' && config.apiUrl.trim()) || DEFAULT_API_URL;
  const configured = typeof config?.apiKey === 'string' && config.apiKey.length > 0;
  const registry = registryUrl(env);

  // A malformed URL becomes '' and probes as an ordinary network failure.
  const resolveUrl = (path, base) => {
    try {
      return new URL(path, base).toString();
    } catch {
      return '';
    }
  };
  const [server, npmRegistry] = await Promise.all([
    probe(resolveUrl('/api/usage/settings', apiUrl)),
    probe(resolveUrl('-/ping', registry.endsWith('/') ? registry : `${registry}/`)),
  ]);

  const history = readSyncHistory();
  const finished = history.entries.find(entry => entry.result);
  const lastSyncRejected = finished ? finished.failure?.code === 'unauthorized' : null;

  const state = loadState();
  const uploaded = uploadedBySource(state);
  const toolOptions = { codexExtraHome: config?.codexExtraHome, extraRoots: config?.extraRoots };
  const tools = [];
  for (const tool of TOOLS) {
    const detected = toolDetected(tool, toolOptions);
    const lastSync = lastToolSync(history.entries, tool.id);
    const counts = uploaded.get(tool.id) ?? { buckets: 0, sessions: 0 };
    // Every installed parser "runs" each sync, so a zero lastSync alone does
    // not make an absent tool worth listing.
    if (!detected && !lastSyncHasData(lastSync) && !counts.buckets && !counts.sessions) continue;
    tools.push({
      id: tool.id,
      name: tool.name,
      detected,
      extraRoots: extraRootCount(config, tool.id),
      uploaded: counts,
      lastSync,
    });
  }

  let extraRoots = 0;
  for (const source of EXTRA_ROOT_SOURCES) extraRoots += extraRootCount(config, source);

  return {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    cli: { version: COLLECTOR_VERSION, surface: resolveSurface('cli') },
    system: { platform: process.platform, arch: arch(), release: release() },
    runtime: {
      name: process.versions.bun ? 'bun' : 'node',
      version: process.versions.bun || process.versions.node,
    },
    sqlite: sqlite(),
    account: {
      configured,
      server: apiUrl.replace(/\/+$/, '') === DEFAULT_API_URL ? 'default' : 'custom',
      uploadState: configured ? inspectStateIdentity(stateIdentity({ apiUrl, apiKey: config.apiKey })) : 'none',
      lastSyncRejected,
      deviceTag: deviceTag(config?.hostname || osHostname().replace(/\.local$/, '')),
    },
    network: {
      server,
      npmRegistry: { registry: isOfficialRegistry(registry) ? 'official' : 'custom', ...npmRegistry },
    },
    daemon: daemon(),
    settings: {
      uploadProject: config?.lastUploadProjectApiUrl === apiUrl && typeof config?.lastUploadProject === 'boolean'
        ? config.lastUploadProject
        : null,
      extraRoots,
      kikiStartAt: config?.kikiStartAt ? 'set' : 'unset',
      magpieStartAt: config?.magpieStartAt === 'none' ? 'none' : (config?.magpieStartAt ? 'set' : 'unset'),
    },
    syncHistory: { available: history.exists, entries: history.entries.map(historySummary) },
    tools,
  };
}

// ---------------------------------------------------------------------------
// Last-line scrub (plan §6.9). Every field above is already whitelisted; this
// pass catches anything that slips through anyway.

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SECRET_PATTERNS = [
  /Bearer\s+\S+/g,
  /\bvbu_[A-Za-z0-9_-]+/g,
  /\bsk-[A-Za-z0-9_-]+/g,
  /\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /[A-Za-z0-9_\-.=+/]{40,}/g,
];

export function scrubText(text, home = homedir()) {
  let out = String(text);
  if (home && home.length > 1) out = out.replace(new RegExp(escapeRegExp(home), 'g'), '~');
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '***');
  return out;
}

export function scrubDeep(value, home = homedir()) {
  if (typeof value === 'string') return scrubText(value, home);
  if (Array.isArray(value)) return value.map(item => scrubDeep(item, home));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubDeep(item, home)]));
  }
  return value;
}

// ---------------------------------------------------------------------------
// Text report (plan §4). Plain text, no colors: it is meant to be pasted.

const SURFACE_LABELS = { cli: '终端', daemon: '后台服务', 'mac-app': 'Mac App', 'windows-app': 'Windows App' };
const UPLOAD_STATE_LABELS = {
  match: '上传记录与当前 Key 一致',
  mismatch: '上传记录属于另一个 Key（下次同步会整段重传）',
  unrecorded: '上传记录没有绑定 Key（旧版本写入，下次同步自动补上）',
  none: '还没有上传记录',
};
const SQLITE_LABELS = { 'node:sqlite': '内置 node:sqlite', 'sqlite3-cli': '系统 sqlite3 命令', none: '都没有（Cursor、OpenCode 等工具读不了）' };

function pad(value) {
  return String(value).padStart(2, '0');
}

function localStamp(date, { withYear = false } = {}) {
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return withYear ? `${date.getFullYear()}-${day} ${time}` : `${day} ${time}`;
}

function utcOffset(date) {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${pad(abs % 60)}` : ''}`;
}

function formatMs(ms) {
  if (!Number.isFinite(ms)) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatDuration(ms) {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  return secs % 60 ? `${m}m${secs % 60}s` : `${m}m`;
}

function formatCount(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function counts({ buckets, sessions }) {
  return sessions ? `${formatCount(buckets)} buckets / ${formatCount(sessions)} sessions` : `${formatCount(buckets)} buckets`;
}

function failureText(failure) {
  if (!failure) return '';
  const label = SYNC_FAILURE_CODES[failure.code] ?? failure.code;
  return failure.status ? `${label} ${failure.status}` : label;
}

function syncLine(entry) {
  const when = localStamp(new Date(entry.startedAt));
  const who = SURFACE_LABELS[entry.surface] ?? '未知发起方';
  let result;
  if (!entry.result) {
    result = '未记录结束，原因未知';
  } else if (entry.result === 'success') {
    const sent = entry.uploaded.buckets || entry.uploaded.sessions ? `上传 ${counts(entry.uploaded)}` : '无新数据';
    result = `成功 ${formatDuration(entry.durationMs)} · ${sent}`;
  } else if (entry.result === 'partial') {
    result = `部分完成 ${formatDuration(entry.durationMs)} · 已上传 ${counts(entry.uploaded)} · ${failureText(entry.failure)}`;
  } else {
    result = `失败 ${formatDuration(entry.durationMs)} · ${failureText(entry.failure)}`;
  }
  const version = entry.cliVersion ? ` · CLI ${entry.cliVersion}` : '';
  return `${when} ${who} · ${result}${version}`;
}

function probeText(label, probe) {
  return probe.reachable
    ? `${label}可达 ${formatMs(probe.latencyMs)}`
    : `${label}连不上（${PROBE_ERRORS[probe.error] ?? probe.error}）`;
}

function toolLine(tool, nameWidth) {
  const parts = [tool.detected ? '已检测' : '未检测到数据目录'];
  if (tool.extraRoots > 0) parts.push(`额外目录 ${tool.extraRoots} 个`);
  const last = tool.lastSync;
  if (!last) {
    parts.push('暂无同步记录');
  } else if (last.error) {
    parts.push(`出错：${WARNING_CODES[last.error] ?? last.error}（${last.error}）`);
  } else {
    const warnings = Object.entries(last.warnings);
    const quiet = !last.buckets && !last.sessions && !last.indexing && warnings.length === 0;
    parts.push(quiet ? '上次无新数据' : `上次 ${counts(last)}`);
    if (last.indexing) parts.push(`正在建立本地索引 ${last.indexing.completed}/${last.indexing.total}`);
    for (const [code, n] of warnings) parts.push(`${WARNING_CODES[code] ?? code} ×${n}（${code}）`);
    if (!last.indexing && warnings.length === 0) parts.push('正常');
  }
  if (last?.serverDropped) parts.push(`服务端丢弃 ${formatCount(last.serverDropped)}（服务端还没收录这个来源）`);
  if (tool.uploaded.buckets || tool.uploaded.sessions) parts.push(`累计已上传 ${counts(tool.uploaded)}`);
  return `  ${tool.name.padEnd(nameWidth)}  ${parts.join(' · ')}`;
}

function hasProblem(tool) {
  const last = tool.lastSync;
  return Boolean(last && (last.error || last.indexing || last.serverDropped || Object.keys(last.warnings).length > 0));
}

export function renderDoctorText(report) {
  const generated = new Date(report.generatedAt);
  const lines = [];
  lines.push(`Vibe Usage 诊断报告 v${report.schemaVersion}（CLI doctor）· ${localStamp(generated, { withYear: true })}（${utcOffset(generated)}）`);
  lines.push(`环境：${report.system.platform} ${report.system.release} ${report.system.arch} · CLI ${report.cli.version} · 由${SURFACE_LABELS[report.cli.surface] ?? '终端'}运行`);
  const runtimeName = report.runtime.name === 'bun' ? 'Bun' : 'Node';
  const runtimeScope = report.cli.surface === 'cli' ? '本终端' : '本次调用';
  lines.push(`运行环境（${runtimeScope}）：${runtimeName} ${report.runtime.version} · SQLite：${SQLITE_LABELS[report.sqlite] ?? report.sqlite}`);

  const account = report.account;
  const accountParts = [account.configured ? '已配置 Key' : '尚未配置 Key'];
  accountParts.push(`服务器：${account.server === 'default' ? '默认' : '自定义'}`);
  if (account.configured) accountParts.push(UPLOAD_STATE_LABELS[account.uploadState] ?? account.uploadState);
  if (account.lastSyncRejected === true) accountParts.push('最近一次同步被服务器拒绝（Key 无效）');
  else if (account.lastSyncRejected === false) accountParts.push('最近一次同步未被服务器拒绝');
  if (account.deviceTag) accountParts.push(`设备标签 ${account.deviceTag}`);
  lines.push(`账号：${accountParts.join(' · ')}`);

  const registryLabel = report.network.npmRegistry.registry === 'official' ? 'npm 源（官方）' : 'npm 源（自定义）';
  lines.push(`网络：${probeText('服务器', report.network.server)} · ${probeText(registryLabel, report.network.npmRegistry)}`);

  const daemon = report.daemon;
  let daemonText;
  if (!daemon.platform) daemonText = 'CLI 后台服务：本系统不支持';
  else if (!daemon.installed) daemonText = 'CLI 后台服务：未安装';
  else daemonText = `CLI 后台服务：已安装（${daemon.platform}，${daemon.mode === 'npx' ? 'npx 每次取最新版' : daemon.mode === 'pinned' ? '固定路径' : '运行方式未知'}）`;
  const lastDaemon = report.syncHistory.entries.find(entry => entry.surface === 'daemon');
  if (lastDaemon) {
    const result = lastDaemon.result
      ? { success: '成功', failed: '失败', partial: '部分完成' }[lastDaemon.result]
      : '未记录结束';
    daemonText += ` · 最近一次后台同步 ${localStamp(new Date(lastDaemon.startedAt))} ${result}`;
  }
  lines.push(`后台：${daemonText}`);

  const settings = report.settings;
  const project = settings.uploadProject === true ? '上传' : settings.uploadProject === false ? '已隐藏' : '未知（还没成功读过服务端设置）';
  const magpie = { set: '已设', none: '全部历史', unset: '未设' }[settings.magpieStartAt];
  lines.push(`设置：项目名：${project} · 额外数据目录 ${settings.extraRoots} 个 · Kiki 切点：${settings.kikiStartAt === 'set' ? '已设' : '未设'} · Magpie 切点：${magpie}`);

  lines.push('最近同步（新的在前）：');
  if (report.syncHistory.entries.length === 0) lines.push('  暂无同步记录');
  for (const entry of report.syncHistory.entries) lines.push(`  ${syncLine(entry)}`);

  const shown = report.tools.filter(tool => tool.detected || hasProblem(tool));
  lines.push('工具（只列检测到的和有问题的）：');
  if (shown.length === 0) lines.push('  未检测到任何工具');
  const width = Math.max(0, ...shown.map(tool => tool.name.length));
  for (const tool of shown) lines.push(toolLine(tool, width));

  lines.push('—— 只含固定字段和错误码：不含 API Key、令牌、对话内容、项目名和任何目录名 ——');
  return lines.join('\n');
}

export async function runDoctor(args = []) {
  const json = args.includes('--json');
  const unknown = args.filter(arg => arg !== '--json');
  if (unknown.length > 0) {
    console.error(`Unknown doctor option: ${unknown[0]}`);
    console.error('Usage: vibe-usage doctor [--json]');
    process.exitCode = 1;
    return;
  }
  const report = scrubDeep(await collectDoctorReport());
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${scrubText(renderDoctorText(report))}\n`);
  }
}
