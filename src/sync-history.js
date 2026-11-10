import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { COLLECTOR_VERSION, SURFACES, resolveSurface } from './client-meta.js';
import { isWarningCode } from './warning-codes.js';

/**
 * Local record of the last 10 syncs, ~/.vibe-usage/sync-history.json
 * (approved 2026-11-09 by the maintainer, Hogan; 一键诊断 plan, behaviour B).
 *
 * Every runSync writes an entry when it starts, adds per-tool counts once the
 * parsers finish, saves the upload counts after every committed batch, and
 * fills in the result when it ends. An entry without an
 * end means the process never got there -- killed by a desktop app's 120s
 * timeout, the machine slept, or the sync is still running -- and is reported
 * as "未记录结束，原因未知", never guessed.
 *
 * Whitelist only: timestamps, the surface, the CLI and runtime versions,
 * counts, and fixed codes (warning-codes.js / SYNC_FAILURE_CODES). Never a
 * path, directory or project name, warning text, response body or key. The
 * file is local-only (never uploaded), separate from state.json (upload state
 * is untouched), mode 0600 in a directory created 0700.
 *
 * Recording must never affect the sync: every read and write here swallows its
 * own errors, silently -- an extra stderr line would become the "last error
 * line" the Windows app shows for a failed sync.
 */

// Same directory as state.json, including its test hook and dev split.
const HISTORY_DIR = process.env.VIBE_USAGE_STATE_DIR?.trim() || join(homedir(), '.vibe-usage');
const isDev = process.env.VIBE_USAGE_DEV === '1';
const HISTORY_FILE = join(HISTORY_DIR, isDev ? 'sync-history.dev.json' : 'sync-history.json');

export const SYNC_HISTORY_SCHEMA_VERSION = 1;
export const SYNC_HISTORY_LIMIT = 10;

export const SYNC_RESULTS = Object.freeze(['success', 'failed', 'partial']);

// Why a sync failed. `server_error` also records the HTTP status number; no
// other detail (and never the response body) is kept.
export const SYNC_FAILURE_CODES = Object.freeze({
  unauthorized: 'API Key 被服务器拒绝',
  settings_unavailable: '读取上传设置失败（网络或服务器）',
  network_failed: '网络失败',
  server_error: '服务器错误',
  invalid_response: '服务器返回无法解析',
  unexpected_error: '意外错误',
});

export function getSyncHistoryPath() {
  return HISTORY_FILE;
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN',
  'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE',
]);

/** Fixed failure category for an error that ended a sync; never its message. */
export function syncFailureFromError(err) {
  const message = typeof err?.message === 'string' ? err.message : '';
  if (message === 'UNAUTHORIZED') return { code: 'unauthorized' };
  if (message === 'SETTINGS_UNAVAILABLE' || err?.code === 'SETTINGS_UNAVAILABLE') {
    return { code: 'settings_unavailable' };
  }
  const status = err?.statusCode;
  if (Number.isInteger(status) && status >= 100 && status <= 599) return { code: 'server_error', status };
  if (message.startsWith('Invalid JSON response')) return { code: 'invalid_response' };
  const code = typeof err?.code === 'string' ? err.code : '';
  if (NETWORK_ERROR_CODES.has(code) || /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)
    || message.startsWith('Request timed out')) {
    return { code: 'network_failed' };
  }
  return { code: 'unexpected_error' };
}

function emptyHistory() {
  return { schemaVersion: SYNC_HISTORY_SCHEMA_VERSION, entries: [] };
}

function readRaw() {
  try {
    const parsed = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
    if (parsed?.schemaVersion === SYNC_HISTORY_SCHEMA_VERSION && Array.isArray(parsed.entries)) {
      return parsed;
    }
  } catch {
    // Missing or corrupt: start over. The history is diagnostics only.
  }
  return emptyHistory();
}

function writeRaw(history) {
  let temporary;
  try {
    mkdirSync(HISTORY_DIR, { recursive: true, mode: 0o700 });
    temporary = `${HISTORY_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(history)}\n`, { encoding: 'utf8', mode: 0o600 });
    // Atomic replace: a concurrent reader (an app's sync next to the daemon's,
    // or `doctor`) sees the old file or the new one, never half of one.
    renameSync(temporary, HISTORY_FILE);
    temporary = null;
    try {
      chmodSync(HISTORY_FILE, 0o600);
    } catch {
      // Windows models permissions with ACLs; the file stays in the user's home.
    }
  } catch {
    // Recording must never affect the sync.
  } finally {
    if (temporary) {
      try { rmSync(temporary, { force: true }); } catch { /* ignore */ }
    }
  }
}

function update(mutate) {
  try {
    const history = readRaw();
    mutate(history.entries);
    history.entries = history.entries.slice(-SYNC_HISTORY_LIMIT);
    writeRaw(history);
  } catch {
    // Recording must never affect the sync.
  }
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Start recording one runSync. Writes the "started" entry right away and
 * returns a recorder; every method is a no-op after finish() and never throws.
 *
 * `uploaded` is the live counter runSync increments as batches are accepted,
 * so a failure anywhere still records what reached the server.
 */
export function beginSyncRecord({ surface: defaultSurface = 'cli', now = () => Date.now() } = {}) {
  const startedMs = now();
  const entry = {
    id: randomBytes(6).toString('hex'),
    startedAt: new Date(startedMs).toISOString(),
    endedAt: null,
    surface: resolveSurface(defaultSurface),
    cliVersion: COLLECTOR_VERSION,
    runtime: {
      name: process.versions.bun ? 'bun' : 'node',
      version: process.versions.bun || process.versions.node,
    },
    result: null,
    durationMs: null,
    uploaded: { buckets: 0, sessions: 0 },
    failure: null,
    // `parsed`: at least one parser pass finished, so a tool absent from
    // `tools` ran and had nothing to report (no data, no warning) -- unless it
    // is in `pending`, a deferred source (Cursor) still running when the entry
    // was last saved. Lets `doctor` show a recovered tool as healthy instead
    // of repeating an older entry's error.
    parsed: false,
    pending: [],
    tools: {},
  };
  let finished = false;

  const save = () => update((entries) => {
    const index = entries.findIndex(item => item?.id === entry.id);
    if (index === -1) entries.push(structuredClone(entry));
    else entries[index] = structuredClone(entry);
  });
  save();

  const tool = (source) => {
    entry.tools[source] ??= {};
    return entry.tools[source];
  };

  return {
    uploaded: entry.uploaded,

    /**
     * Per-parser outcome of one pass: counts, skipped/indexing state, warning
     * code counts, or the code of an error the parser threw. Tools with
     * nothing to say are left out to keep the file small.
     */
    noteParser(source, { buckets = 0, sessions = 0, skipped = false, indexing, warnings, error } = {}) {
      if (finished) return;
      const hasWarnings = warnings && Object.keys(warnings).length > 0;
      if (!buckets && !sessions && !skipped && !indexing && !hasWarnings && !error) return;
      const item = tool(source);
      item.buckets = count(item.buckets) + count(buckets);
      item.sessions = count(item.sessions) + count(sessions);
      if (skipped) item.skipped = true;
      if (indexing) item.indexing = { completed: count(indexing.completed), total: count(indexing.total) };
      if (error) item.error = isWarningCode(error) ? error : 'parser_error';
      if (hasWarnings) {
        item.warnings ??= {};
        for (const [code, n] of Object.entries(warnings)) {
          const key = isWarningCode(code) ? code : 'other';
          item.warnings[key] = count(item.warnings[key]) + count(n);
        }
      }
    },

    /** Deferred sources (Cursor) still running when the first pass uploads. */
    notePending(sources) {
      if (finished) return;
      entry.pending = [...new Set([...entry.pending, ...sources])];
    },

    /** A parser pass finished for these sources (call before flush()). */
    notePassDone(sources) {
      if (finished) return;
      const done = new Set(sources);
      entry.parsed = true;
      entry.pending = entry.pending.filter(source => !done.has(source));
    },

    /** One warning raised by sync.js itself (Magpie/Kiki holds, Cursor account changes). */
    noteWarning(source, code) {
      if (finished) return;
      const item = tool(source);
      item.warnings ??= {};
      const key = isWarningCode(code) ? code : 'other';
      item.warnings[key] = count(item.warnings[key]) + 1;
    },

    /** Buckets the server soft-dropped because it does not know their source yet. */
    noteServerDropped(source, buckets) {
      if (finished || !count(buckets)) return;
      const item = tool(source);
      item.serverDropped = count(item.serverDropped) + count(buckets);
    },

    /** Persist what is known so far (called once the parsers of a pass finish). */
    flush() {
      if (!finished) save();
    },

    /**
     * End the record. With `failure` the result is `failed`, or `partial`
     * when anything was already uploaded; without it, `success`. Only the
     * first call counts.
     */
    finish({ failure } = {}) {
      if (finished) return;
      finished = true;
      const endedMs = now();
      entry.endedAt = new Date(endedMs).toISOString();
      entry.durationMs = Math.max(0, endedMs - startedMs);
      if (failure) {
        const code = Object.hasOwn(SYNC_FAILURE_CODES, failure.code) ? failure.code : 'unexpected_error';
        entry.failure = code === 'server_error' && Number.isInteger(failure.status)
          ? { code, status: failure.status }
          : { code };
        entry.result = entry.uploaded.buckets > 0 || entry.uploaded.sessions > 0 ? 'partial' : 'failed';
      } else {
        entry.result = 'success';
      }
      save();
    },
  };
}

// ---------------------------------------------------------------------------
// Reading (doctor). Every field is re-validated against the whitelist, so even
// a hand-edited file cannot put free text into a report.

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,40}$/;
const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function isoOrNull(value) {
  return typeof value === 'string' && ISO_RE.test(value) ? value : null;
}

function versionOrNull(value) {
  return typeof value === 'string' && VERSION_RE.test(value) ? value : null;
}

function sanitizeTool(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tool = { buckets: count(raw.buckets), sessions: count(raw.sessions) };
  if (raw.skipped === true) tool.skipped = true;
  if (raw.indexing && typeof raw.indexing === 'object') {
    tool.indexing = { completed: count(raw.indexing.completed), total: count(raw.indexing.total) };
  }
  if (isWarningCode(raw.error)) tool.error = raw.error;
  if (raw.warnings && typeof raw.warnings === 'object') {
    const warnings = {};
    for (const [code, n] of Object.entries(raw.warnings)) {
      if (isWarningCode(code) && count(n) > 0) warnings[code] = count(n);
    }
    if (Object.keys(warnings).length > 0) tool.warnings = warnings;
  }
  if (count(raw.serverDropped) > 0) tool.serverDropped = count(raw.serverDropped);
  return tool;
}

export function sanitizeSyncEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const startedAt = isoOrNull(raw.startedAt);
  if (!startedAt) return null;
  const endedAt = isoOrNull(raw.endedAt);
  const result = endedAt && SYNC_RESULTS.includes(raw.result) ? raw.result : null;
  let failure = null;
  if (result && result !== 'success' && raw.failure && Object.hasOwn(SYNC_FAILURE_CODES, raw.failure.code)) {
    failure = { code: raw.failure.code };
    if (raw.failure.code === 'server_error' && Number.isInteger(raw.failure.status)
      && raw.failure.status >= 100 && raw.failure.status <= 599) {
      failure.status = raw.failure.status;
    }
  }
  const tools = {};
  if (raw.tools && typeof raw.tools === 'object') {
    for (const [source, value] of Object.entries(raw.tools)) {
      if (!SOURCE_RE.test(source)) continue;
      const tool = sanitizeTool(value);
      if (tool) tools[source] = tool;
    }
  }
  const runtimeName = raw.runtime?.name === 'bun' || raw.runtime?.name === 'node' ? raw.runtime.name : null;
  const pending = Array.isArray(raw.pending)
    ? [...new Set(raw.pending.filter(source => typeof source === 'string' && SOURCE_RE.test(source)))]
    : [];
  return {
    startedAt,
    endedAt: result ? endedAt : null,
    surface: SURFACES.has(raw.surface) ? raw.surface : null,
    cliVersion: versionOrNull(raw.cliVersion),
    runtime: runtimeName ? { name: runtimeName, version: versionOrNull(raw.runtime.version) } : null,
    result,
    durationMs: result && Number.isSafeInteger(raw.durationMs) && raw.durationMs >= 0 ? raw.durationMs : null,
    uploaded: { buckets: count(raw.uploaded?.buckets), sessions: count(raw.uploaded?.sessions) },
    failure,
    parsed: raw.parsed === true,
    pending,
    tools,
  };
}

/**
 * The recorded syncs, newest first, sanitized. `exists` is false when there is
 * no file yet (or it is unreadable) -- `doctor` then says "暂无同步记录".
 */
export function readSyncHistory() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return { exists: false, entries: [] };
  }
  if (parsed?.schemaVersion !== SYNC_HISTORY_SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
    return { exists: false, entries: [] };
  }
  const entries = parsed.entries
    .slice(-SYNC_HISTORY_LIMIT)
    .map(sanitizeSyncEntry)
    .filter(Boolean)
    .reverse();
  return { exists: true, entries };
}
