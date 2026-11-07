import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, roundToHalfHour } from './aggregate.js';
import { queryDbJsonSnapshotOnLock, sqliteUnavailableError, isSqliteUnavailableError } from './sqlite.js';

const STATE_DB_RELATIVE = join('User', 'globalStorage', 'state.vscdb');
const ACCESS_TOKEN_KEY = 'cursorAuth/accessToken';
const SESSION_COOKIE = 'WorkosCursorSessionToken';
const CSV_PATH = '/api/dashboard/export-usage-events-csv';
const EVENTS_PATH = '/api/dashboard/get-filtered-usage-events';
const PAGE_SIZE = 1000;
// Cursor's dashboard pages the events endpoint; 200k events is far above any
// real personal account. Hitting the cap means the fallback is incomplete, so
// the run is skipped instead of pruning incremental state with a partial view.
const MAX_PAGES = 200;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Rolling window (issue #131). cursor.com builds the whole-account export in
// time proportional to its rows (60k rows / 6.5 MB / 99s measured 2026-11-04),
// so every sync now re-reads only the last 7 days, and history is filled in
// weekly blocks when it is missing: first run, Cursor account switch, or no
// successful Cursor sync for more than 6 days. The export filters on
// `startDate` / `endDate` in **milliseconds**, both ends inclusive (verified
// row for row against the whole export); seconds silently return nothing.
const RECENT_MS = 7 * DAY_MS;
const GAP_LIMIT_MS = 6 * DAY_MS;
const BACKFILL_BLOCK_MS = 7 * DAY_MS;
const BACKFILL_FLOOR = Date.parse('2024-01-01T00:00:00Z');
// No new history block starts once Cursor has spent this long in one sync
// (uploads not included); a started block finishes. A heavy week measured
// ~12k rows, roughly 8-19s.
const BACKFILL_BUDGET_MS = 40_000;

// Cursor 3.27+ (behind its remote flag `cursor_auth_token_encryption_at_rest`,
// rolled out in batches, on every platform) rewrites `cursorAuth/*` in
// state.vscdb as `cursor-safe-storage:<version>:<base64>` on its next start.
// Sent as a cookie that is a guaranteed 401, which then told the user to sign
// in again -- useless, since signing in writes the same ciphertext. Decided
// 2026-11-07 (issue #144): no local decryption (no `Local State`, DPAPI or
// Keychain); recognize the whole prefix family, skip Cursor with a notice,
// and keep its recorded progress.
const ENCRYPTED_TOKEN_PREFIX = 'cursor-safe-storage:';
const ENCRYPTED_TOKEN_WARNING =
  'cursor: 新版 Cursor 已加密保存登录凭证，vibe-usage 暂不支持读取，Cursor 用量暂停同步，其他工具照常同步。'
  + '重新登录 Cursor 无法解决，进展见 https://github.com/vibe-cafe/vibe-usage/issues/144';

export function isEncryptedCursorToken(token) {
  return typeof token === 'string' && token.startsWith(ENCRYPTED_TOKEN_PREFIX);
}

function getDefaultStateDbPath() {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Cursor', STATE_DB_RELATIVE);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Cursor', STATE_DB_RELATIVE);
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(xdgConfigHome, 'Cursor', STATE_DB_RELATIVE);
}

export function getCursorStateDbPath() {
  const explicit = process.env.CURSOR_STATE_DB_PATH?.trim();
  if (explicit) {
    const resolved = resolve(explicit);
    return existsSync(resolved) ? resolved : null;
  }

  const configDirs = process.env.CURSOR_CONFIG_DIR?.trim();
  const candidates = configDirs
    ? configDirs.split(',').map(v => v.trim()).filter(Boolean).map(v => {
        const r = resolve(v);
        return r.endsWith('.vscdb') ? r : join(r, STATE_DB_RELATIVE);
      })
    : [getDefaultStateDbPath()];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Cursor stores this value as TEXT on most builds, but some (notably newer
 * Windows builds) write the ASCII token as a UTF-16LE BLOB. `node:sqlite`
 * returns a Uint8Array then, while the sqlite3 CLI returns a JS string whose
 * characters carry interleaved NULs. Both used to read as "no token", which
 * made Cursor silently stop syncing after a fresh sign-in.
 */
export function decodeTokenValue(value) {
  if (typeof value === 'string') {
    if (value.includes('\u0000')) {
      const bytes = Buffer.from(value, 'latin1');
      if (bytes.length % 2 === 0) {
        const decoded = bytes.toString('utf16le').replace(/\u0000/g, '').trim();
        if (decoded) return decoded;
      }
      return value.replace(/\u0000/g, '').trim() || null;
    }
    return value.trim() || null;
  }

  if (value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    if (bytes.length === 0) return null;
    // ASCII UTF-16LE has a zero high byte for every character. Check that
    // before UTF-8: the byte stream is also valid UTF-8, just with NULs.
    let utf16 = bytes.length % 2 === 0;
    for (let i = 0; utf16 && i < bytes.length; i += 2) {
      if (bytes[i + 1] !== 0) utf16 = false;
    }
    const decoded = utf16
      ? bytes.toString('utf16le').replace(/\u0000/g, '')
      : bytes.toString('utf8');
    return decoded.trim() || null;
  }

  // Defensive: a wrapper that JSON-encodes SQLite BLOBs.
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
    return decodeTokenValue(Uint8Array.from(value.data));
  }
  return null;
}

function readAccessToken(dbPath) {
  // Cursor app holds a write lock; queryDbJsonSnapshotOnLock copies the WAL set
  // to a temp dir and retries on "database is locked".
  // Older sqlite3 CLIs truncate BLOB JSON strings at the first NUL. Hex keeps
  // UTF-16 bytes intact on both the CLI fallback and node:sqlite.
  const sql = `SELECT hex(value) AS tokenHex FROM ItemTable WHERE key = '${ACCESS_TOKEN_KEY}' LIMIT 1`;
  const rows = queryDbJsonSnapshotOnLock(dbPath, sql, {
    tempPrefix: 'vibe-usage-cursor-',
    opts: { maxBuffer: 4 * 1024 * 1024, timeout: 15000 },
  });
  const tokenHex = rows[0]?.tokenHex;
  return typeof tokenHex === 'string' ? decodeTokenValue(Buffer.from(tokenHex, 'hex')) : null;
}

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

function decodeJwtSub(token) {
  const json = decodeJwtPayload(token);
  return typeof json?.sub === 'string' ? json.sub.trim() : null;
}

/** Local-only account label for warnings/status. Never uploaded. */
export function cursorAccountLabel(sub) {
  if (!sub) return null;
  const [provider, id] = sub.includes('|') ? [sub.split('|')[0], sub.split('|').pop()] : [null, sub];
  const trimmed = id || '';
  const masked = trimmed.length > 12 ? `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}` : trimmed;
  return provider ? `${provider}|${masked}` : masked;
}

// cursor.com's CSV export is computed over the whole account, so it gets
// slower the more usage the account has: heavy users time out on every run,
// not intermittently. 10s (v0.7.11) and then 30s (#72) were both still short
// enough to lock those accounts out permanently -- a user with ~13B tokens/30d
// needed 120s to complete a single export, and every default-timeout run of
// his silently uploaded nothing. Budget for the slow accounts; a healthy
// export returns in a second or two, so this ceiling only costs wall-clock
// time on the runs that were failing anyway.
const DEFAULT_FETCH_TIMEOUT_MS = 120_000;
const MAX_FETCH_TIMEOUT_MS = 2_147_483_647;

export function resolveCursorFetchTimeout(value) {
  const timeout = Number(value);
  return Number.isInteger(timeout) && timeout > 0 && timeout <= MAX_FETCH_TIMEOUT_MS
    ? timeout
    : DEFAULT_FETCH_TIMEOUT_MS;
}

const FETCH_TIMEOUT_MS = resolveCursorFetchTimeout(process.env.VIBE_USAGE_CURSOR_FETCH_TIMEOUT_MS);

function usageNetworkError(error, signal) {
  // Node fetch usually exposes only "fetch failed" at the top level. DNS,
  // TLS and connection codes live in cause (or AggregateError.errors when
  // both IPv4 and IPv6 fail). Report codes, not raw messages that may contain
  // URLs with proxy credentials or authentication headers.
  const codes = new Set();
  const seen = new Set();
  function visit(err) {
    if (!err || typeof err !== 'object' || seen.has(err)) return;
    seen.add(err);
    if (typeof err.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(err.code)) {
      codes.add(err.code);
    }
    visit(err.cause);
    if (Array.isArray(err.errors)) err.errors.forEach(visit);
  }
  visit(error);

  const timedOut = error?.name === 'TimeoutError' || signal.reason?.name === 'TimeoutError';
  const reason = timedOut
    ? `timeout after ${FETCH_TIMEOUT_MS}ms`
    : `network: ${[...codes].join(', ') || 'fetch failed'}`;
  let hint = '请检查终端网络和代理配置；浏览器能访问 Cursor 不代表 Node.js 使用了相同代理。';
  if (timedOut) {
    hint = 'Cursor 用量导出超时，请稍后重试；可通过 VIBE_USAGE_CURSOR_FETCH_TIMEOUT_MS 增大导出等待时间。';
  } else if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')) {
    hint = '域名解析失败，请检查 DNS 和终端代理配置。';
  } else if ([...codes].some(code => /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS_/.test(code))) {
    hint = 'TLS 证书校验失败，请检查系统时间及代理或公司网络的 CA 证书配置。';
  }
  const err = new Error(`Cursor usage export skipped (${reason}). ${hint}`);
  err.skip = true;
  return err;
}

function skipped(message) {
  const err = new Error(message);
  err.skip = true;
  return err;
}

function baseHeaders(accept) {
  return {
    Accept: accept,
    Origin: 'https://cursor.com',
    Referer: 'https://cursor.com/dashboard?tab=usage',
    // Node's default UA is a common target for intermittent WAF blocks on
    // cursor.com; match what the dashboard sends.
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  };
}

function credentialAttempts(token) {
  const sub = decodeJwtSub(token);
  // The dashboard API authenticates via the WorkosCursorSessionToken cookie in
  // `{sub}%3A%3A{jwt}` form (what the browser sends). Bearer and bare-token
  // cookies now return 401, so they're kept only as last-resort fallbacks.
  const userId = sub?.includes('|') ? sub.split('|').pop() : null;
  const cookieValues = [
    ...(sub ? [`${sub}%3A%3A${token}`] : []),
    ...(userId ? [`${userId}%3A%3A${token}`] : []),
    token,
  ];
  const attempts = cookieValues.map(value => ({ Cookie: `${SESSION_COOKIE}=${value}` }));
  attempts.push({ Authorization: `Bearer ${token}` });
  return attempts;
}

function cursorWebBase() {
  return (process.env.CURSOR_WEB_BASE_URL?.trim() || 'https://cursor.com').replace(/\/+$/, '');
}

function authRejected(status, statusText) {
  const err = new Error(`auth rejected (${status} ${statusText})`);
  err.authRejected = true;
  return err;
}

async function fetchCsv(headers, signal, range) {
  const url = `${cursorWebBase()}${CSV_PATH}?startDate=${range.startDate}&endDate=${range.endDate}&strategy=tokens`;
  let resp;
  try {
    resp = await fetch(url, { headers: { ...baseHeaders('text/csv,*/*;q=0.8'), ...headers }, signal });
    // The export may time out or disconnect after headers have arrived.
    // Keep body consumption under the same deadline and soft-skip handling.
    if (resp.ok) return await resp.text();
  } catch (err) {
    throw usageNetworkError(err, signal);
  }
  if (resp.status === 401 || resp.status === 403) throw authRejected(resp.status, resp.statusText);
  // 429/5xx are transient server-side states — soft-skip like network errors
  // instead of surfacing them as auth failures every daemon cycle.
  throw skipped(`Cursor usage export skipped (HTTP ${resp.status} ${resp.statusText})`);
}

async function fetchUsageCsv(token, range) {
  const failures = [];
  for (const headers of credentialAttempts(token)) {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    try {
      return await fetchCsv(headers, signal, range);
    } catch (err) {
      if (err?.authRejected) {
        failures.push(String(err.message).replace(/^auth rejected /, ''));
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `Cursor session rejected (${failures.join('; ')}). Open Cursor and sign in again (Cursor Settings → Account), then re-run sync.`,
  );
}

function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); field = ''; row = []; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function parseDate(value) {
  if (!value) return null;
  const t = String(value).trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return new Date(`${t}T00:00:00Z`);
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
}

function parseInt0(value) {
  if (value == null) return 0;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Parse the legacy CSV export. Returns `unusable` (with a reason) when Cursor
 * changed the header, returned no rows, or returned rows whose token columns
 * are all empty — the caller then tries the events API instead of uploading an
 * empty snapshot that would prune history.
 */
function entriesFromCsv(csv) {
  const rows = parseCsv(String(csv).replace(/^\uFEFF/, ''));
  if (rows.length < 2) return { entries: [], events: 0, latestEventAt: null, unusable: '返回了空表' };

  const header = rows[0].map(h => h.trim());
  const idx = (name) => header.indexOf(name);
  const dateIdx = idx('Date');
  const modelIdx = idx('Model');
  const inputCacheWriteIdx = idx('Input (w/ Cache Write)');
  const inputNoCacheIdx = idx('Input (w/o Cache Write)');
  const cacheReadIdx = idx('Cache Read');
  const outputIdx = idx('Output Tokens');

  // A renamed column used to degrade silently: every row then parsed as zero
  // tokens, the run uploaded an empty snapshot, and sync.js pruned Cursor's
  // incremental state as if the account had gone quiet — the dashboard just
  // stopped counting Cursor. Treat a header we do not recognise as unusable
  // and try the events API before giving up.
  const hasTokenColumn =
    inputCacheWriteIdx >= 0 || inputNoCacheIdx >= 0 || cacheReadIdx >= 0 || outputIdx >= 0;
  if (dateIdx < 0 || modelIdx < 0 || !hasTokenColumn) {
    return {
      entries: [],
      events: 0,
      latestEventAt: null,
      headerMismatch: true,
      unusable: `导出表头与预期不符（当前表头: ${header.slice(0, 8).join(', ')}）`,
    };
  }

  const entries = [];
  let latestEventAt = null;
  let latestTokenAt = null;
  let eventCount = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 1 && row[0].trim() === '') continue;
    const timestamp = parseDate(row[dateIdx]);
    const model = row[modelIdx]?.trim();
    if (!timestamp || !model) continue;
    eventCount++;
    if (!latestEventAt || timestamp > latestEventAt) latestEventAt = timestamp;

    const inputCacheWrite = inputCacheWriteIdx >= 0 ? parseInt0(row[inputCacheWriteIdx]) : 0;
    const inputNoCache = inputNoCacheIdx >= 0 ? parseInt0(row[inputNoCacheIdx]) : 0;
    const cacheRead = cacheReadIdx >= 0 ? parseInt0(row[cacheReadIdx]) : 0;
    const output = outputIdx >= 0 ? parseInt0(row[outputIdx]) : 0;

    if (inputCacheWrite + inputNoCache + cacheRead + output === 0) continue;
    if (!latestTokenAt || timestamp > latestTokenAt) latestTokenAt = timestamp;

    entries.push({
      source: 'cursor',
      model,
      project: 'unknown',
      // Cursor usage is pulled from the cloud API — it reflects the same account
      // data on every machine. Use a fixed sentinel so all machines share one row
      // per (model, bucket_start) rather than duplicating per hostname.
      hostname: 'cursor-cloud',
      timestamp,
      inputTokens: inputCacheWrite + inputNoCache,
      outputTokens: output,
      cachedInputTokens: cacheRead,
      reasoningOutputTokens: 0,
    });
  }

  if (entries.length === 0) {
    return {
      entries,
      events: eventCount,
      latestEventAt,
      latestTokenAt,
      unusable: eventCount > 0 ? `返回了 ${eventCount} 行，但没有任何 token 计数` : '没有返回任何用量行',
    };
  }
  return { entries, events: eventCount, latestEventAt, latestTokenAt };
}

function tokenCount(value) {
  if (value == null) return 0;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function eventTimestamp(value) {
  if (value == null) return null;
  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw === '') return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    // The dashboard serializes Unix milliseconds as a string.
    const date = new Date(numeric);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function eventDedupKey(event) {
  if (typeof event?.usageEventId === 'string' && event.usageEventId) return event.usageEventId;
  return JSON.stringify([event?.timestamp, event?.model, event?.tokenUsage]);
}

async function fetchAllEventPages(headers, signal, { startDate = '0' } = {}) {
  const url = `${cursorWebBase()}${EVENTS_PATH}`;
  const endDate = String(Date.now());
  const events = [];
  const seen = new Set();
  let total = null;
  let rawCount = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { ...baseHeaders('application/json'), 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ page, pageSize: PAGE_SIZE, startDate, endDate }),
        signal,
      });
    } catch (err) {
      throw usageNetworkError(err, signal);
    }

    if (resp.status === 401 || resp.status === 403) throw authRejected(resp.status, resp.statusText);
    if (!resp.ok) {
      throw skipped(`Cursor usage request skipped (HTTP ${resp.status} ${resp.statusText})`);
    }

    let json;
    try {
      json = await resp.json();
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw skipped('Cursor usage request skipped (dashboard returned invalid JSON; the API may have changed).');
      }
      throw usageNetworkError(err, signal);
    }

    // An empty query window returns `{}` with no fields at all.
    const pageEvents = json && typeof json === 'object' ? json.usageEventsDisplay : undefined;
    if (!Array.isArray(pageEvents)) {
      if (json && typeof json === 'object' && Object.keys(json).length === 0) {
        total = 0;
        break;
      }
      const reported = Number(json?.totalUsageEventsCount);
      if (Number.isFinite(reported) && reported === 0) {
        total = 0;
        break;
      }
      throw skipped(
        'Cursor usage request skipped (dashboard response has no usageEventsDisplay; the API may have changed). '
        + `Keys: ${json && typeof json === 'object' ? Object.keys(json).slice(0, 8).join(', ') : typeof json}`,
      );
    }

    const reported = Number(json.totalUsageEventsCount);
    if (Number.isFinite(reported) && reported >= 0) total = reported;

    rawCount += pageEvents.length;
    for (const event of pageEvents) {
      const key = eventDedupKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }

    if (pageEvents.length < PAGE_SIZE) break;
    if (total != null && rawCount >= total) break;
    if (page === MAX_PAGES) {
      throw skipped(`Cursor usage request skipped (more than ${MAX_PAGES * PAGE_SIZE} events; history left unchanged).`);
    }
  }

  if (total != null && rawCount < total) {
    throw skipped(
      `Cursor usage request skipped (received ${rawCount} of ${total} events; history left unchanged).`,
    );
  }
  return { events, total: total ?? events.length };
}

async function fetchUsageEvents(token, options = {}) {
  const failures = [];
  for (const headers of credentialAttempts(token)) {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    try {
      return await fetchAllEventPages(headers, signal, options);
    } catch (err) {
      if (err?.authRejected) {
        failures.push(String(err.message).replace(/^auth rejected /, ''));
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `Cursor session rejected (${failures.join('; ')}). Open Cursor and sign in again (Cursor Settings → Account), then re-run sync.`,
  );
}

/**
 * Fallback for accounts whose CSV export is empty or uses an unknown format
 * (observed on some X Subscription / unified accounts, 2026-10). The events
 * endpoint is the dashboard's own paginated source. Its `model` field is less
 * accurate for older rows (`default` instead of `auto`/Composer), so it is only
 * used when the CSV cannot provide usable data.
 */
function entriesFromEvents(events) {
  const entries = [];
  let latestEventAt = null;
  let latestTokenAt = null;
  let tokenEventCount = 0;

  for (const event of events) {
    const timestamp = eventTimestamp(event?.timestamp);
    if (timestamp && (!latestEventAt || timestamp > latestEventAt)) latestEventAt = timestamp;

    const model = typeof event?.model === 'string' ? event.model.trim() : '';
    if (!timestamp || !model) continue;

    const usage = event?.tokenUsage;
    if (!usage || typeof usage !== 'object') continue;

    const inputTokens = tokenCount(usage.inputTokens) + tokenCount(usage.cacheWriteTokens);
    const outputTokens = tokenCount(usage.outputTokens);
    const cachedInputTokens = tokenCount(usage.cacheReadTokens);
    if (inputTokens + outputTokens + cachedInputTokens === 0) continue;
    if (!latestTokenAt || timestamp > latestTokenAt) latestTokenAt = timestamp;

    tokenEventCount++;
    entries.push({
      source: 'cursor',
      model,
      project: 'unknown',
      hostname: 'cursor-cloud',
      timestamp,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningOutputTokens: 0,
    });
  }

  return { entries, latestEventAt, latestTokenAt, tokenEventCount };
}

function laterDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a > b ? a : b;
}

function resultInfo({ account, latestEventAt, latestTokenAt, events, tokenEvents, fallbackLatestAt, syncedAt, backfill }) {
  return {
    ...(account ? { account } : {}),
    ...(latestEventAt ? { latestEventAt: new Date(latestEventAt).toISOString() } : {}),
    ...(latestTokenAt ? { latestTokenAt: new Date(latestTokenAt).toISOString() } : {}),
    events,
    tokenEvents,
    ...(fallbackLatestAt ? { fallbackLatestAt } : {}),
    ...(syncedAt ? { syncedAt: new Date(syncedAt).toISOString() } : {}),
    ...(backfill ? { backfill: { before: new Date(backfill.before).toISOString(), until: new Date(backfill.until).toISOString() } } : {}),
  };
}

const windowOf = time => roundToHalfHour(new Date(time)).getTime();

/**
 * Which history still has to be read, as `{ before, until }` (ms): the weekly
 * blocks of `[until, before)`, newest first. Without a recorded `syncedAt`
 * (first run, reset, re-bind, Cursor account switch) that is everything down
 * to BACKFILL_FLOOR; after more than 6 days without a successful Cursor sync,
 * the gap since then. Otherwise the recorded progress, or nothing.
 */
export function planBackfill(previousInfo, now, recentStart) {
  const syncedAt = Date.parse(previousInfo?.syncedAt);
  const before = Date.parse(previousInfo?.backfill?.before);
  const until = Date.parse(previousInfo?.backfill?.until);
  const current = Number.isFinite(before) && Number.isFinite(until) ? { before, until } : null;
  if (!Number.isFinite(syncedAt)) return { before: recentStart, until: BACKFILL_FLOOR };
  if (now - syncedAt > GAP_LIMIT_MS) {
    const gapUntil = windowOf(syncedAt - DAY_MS);
    return { before: recentStart, until: current ? Math.min(current.until, gapUntil) : gapUntil };
  }
  return current;
}

/**
 * The recent CSV path: windows starting at or after `recentStart`, plus the
 * existing stale-gap probe. The CSV can be valid but stop growing (observed
 * after account switches/unification): when its newest token row is 24h-7d
 * old, take dashboard events newer than that row -- only newer ones, since the
 * events API labels history `default` and re-adding it would double-count.
 */
async function recentFromCsv(csvResult, { token, previousInfo, recentStart }) {
  let entries = csvResult.entries;
  let latest = csvResult.latestEventAt;
  let latestToken = csvResult.latestTokenAt ?? csvResult.latestEventAt;
  let events = csvResult.events;
  let fallbackLatestAt = previousInfo?.fallbackLatestAt;
  const warnings = [];

  const boundaryMs = latestToken ? latestToken.getTime() : NaN;
  const now = Date.now();
  if (Number.isFinite(boundaryMs) && now - boundaryMs > DAY_MS && now - boundaryMs <= 7 * DAY_MS) {
    try {
      const probe = await fetchUsageEvents(token, { startDate: String(Math.max(0, boundaryMs - HOUR_MS)) });
      const newer = probe.events.filter((event) => {
        const timestamp = eventTimestamp(event?.timestamp);
        return timestamp && timestamp.getTime() > boundaryMs;
      });
      const extra = entriesFromEvents(newer);
      if (extra.entries.length > 0) {
        entries = entries.concat(extra.entries);
        if (extra.latestEventAt && (!latest || extra.latestEventAt > latest)) latest = extra.latestEventAt;
        if (extra.latestTokenAt && (!latestToken || extra.latestTokenAt > latestToken)) latestToken = extra.latestTokenAt;
        events += newer.length;
        const probedThrough = Date.parse(fallbackLatestAt);
        if (!Number.isFinite(probedThrough) || probedThrough < latestToken.getTime()) {
          warnings.push(
            `cursor: CSV 最新 token 事件停在 ${new Date(boundaryMs).toISOString()}，`
            + `已从仪表盘事件接口补回 ${extra.tokenEventCount} 个更新的 token 事件；`
            + '这些事件的模型名可能不完整（不影响 token 总量）。',
          );
        }
        fallbackLatestAt = latestToken.toISOString();
      }
    } catch {
      // The CSV data is still valid; a failed freshness probe must not
      // discard it or fail the whole sync.
    }
  }

  return {
    entries: entries.filter(entry => windowOf(entry.timestamp) >= recentStart),
    latestEventAt: latest,
    latestTokenAt: latestToken,
    events,
    tokenEvents: entries.length,
    fallbackLatestAt,
    warnings,
  };
}

/**
 * The events fallback (#140, unchanged rules) for a recent CSV that is empty or
 * unusable. Its output is not limited to the recent window: an account whose
 * CSV is always empty may have events older than it after the collector was
 * off for a while. Only events newer than the previous sync's newest event
 * count as new usage (the events API labels history `default`); on a first
 * run it is bounded to the last seven days. Every half-hour window that holds
 * a new token event is rebuilt from all of its events, so a later upload never
 * replaces 10 + 20 with 20 under the same key.
 *
 * Known cost: on the run where the CSV first comes back empty, a rebuilt
 * window can hold events the CSV already uploaded under another model name
 * (`auto` there, `default` here); that part counts twice. At most one window
 * per switch from a usable to an empty export.
 */
async function eventsFallback(csvResult, { token, previousInfo }) {
  const previousLatest = Date.parse(previousInfo?.latestTokenAt ?? previousInfo?.latestEventAt);
  const hasPreviousLatest = Number.isFinite(previousLatest);
  // Two hours back holds every event of any window a new event lands in: a
  // window starts at most 90 minutes before its events (roundToHalfHour() on
  // the night clocks fall back), and a new event is after `previousLatest`.
  const fallbackStart = hasPreviousLatest
    ? Math.max(0, previousLatest - 2 * HOUR_MS)
    : Date.now() - 7 * DAY_MS;
  // An empty export with a recognized header is the normal idle week; only a
  // changed header or token-less rows mean the export itself is in doubt.
  const idle = !csvResult.headerMismatch && csvResult.events === 0;

  let events;
  try {
    events = await fetchUsageEvents(token, { startDate: String(fallbackStart) });
  } catch (err) {
    if (err && err.skip) {
      return {
        entries: [],
        events: 0,
        warnings: [`cursor: CSV 导出不可用（${csvResult.unusable}）；事件接口也失败：${err.message}`],
      };
    }
    throw err;
  }

  const eventTime = event => eventTimestamp(event?.timestamp)?.getTime() ?? NaN;
  const candidateEvents = hasPreviousLatest
    ? events.events.filter(event => eventTime(event) > previousLatest)
    : events.events;
  const fallback = entriesFromEvents(candidateEvents);
  const newWindows = new Set(fallback.entries.map(entry => windowOf(entry.timestamp)));
  const windowEntries = hasPreviousLatest
    ? entriesFromEvents(events.events.filter(event => newWindows.has(windowOf(eventTime(event))))).entries
    : fallback.entries;
  const windowLabel = hasPreviousLatest ? `${new Date(previousLatest).toISOString()} 之后` : '最近 7 天';

  const warnings = [];
  if (fallback.entries.length > 0) {
    warnings.push(
      `cursor: CSV 导出不可用（${csvResult.unusable}），已从仪表盘事件接口补回${windowLabel}的 `
      + `${fallback.tokenEventCount} 个 token 事件；这些事件的模型名可能显示为 default（不影响 token 总量）。`,
    );
  } else if (!idle) {
    warnings.push(
      `cursor: CSV 导出不可用（${csvResult.unusable}），事件接口在${windowLabel}也没有读到 token 用量。`
      + '如果刚切换到 X 订阅，Cursor 的用量可能并入 grok.com/dashboard；本次已跳过以保留历史。',
    );
  }
  return {
    entries: windowEntries,
    events: candidateEvents.length,
    latestEventAt: fallback.latestEventAt,
    latestTokenAt: fallback.latestTokenAt,
    warnings,
  };
}

function exportSkipped(err) {
  // Network/timeout → skip with diagnostics, no info: sync.js keeps Cursor's
  // state and the recorded progress for the next run.
  return { buckets: [], sessions: [], skipped: true, warnings: [`cursor: ${err.message}`] };
}

export async function parse({ previousInfo } = {}) {
  const dbPath = getCursorStateDbPath();
  let token = null;
  let sqliteUnavailable = false;

  if (dbPath) {
    try {
      token = readAccessToken(dbPath);
    } catch (err) {
      if (!isSqliteUnavailableError(err)) throw err;
      sqliteUnavailable = true;
    }
  }
  if (!token) {
    if (sqliteUnavailable) throw sqliteUnavailableError('Cursor');
    return { buckets: [], sessions: [] };
  }
  if (isEncryptedCursorToken(token)) {
    // No request and no info: sync.js then keeps every Cursor state key and
    // the recorded parserMeta (syncedAt, backfill) untouched, so once a
    // readable token is back, planBackfill() fills the paused weeks. Printed
    // on every run (parser warnings are never filtered); nothing from the
    // token itself goes into the message.
    return { buckets: [], sessions: [], skipped: true, warnings: [ENCRYPTED_TOKEN_WARNING] };
  }

  const sub = decodeJwtSub(token);
  const account = cursorAccountLabel(sub);
  // A different Cursor account: forget the old account's times before any
  // path reads them. Otherwise the events fallback filtered the new account's
  // events by the old account's newest time and dropped everything before it.
  const accountChanged = Boolean(previousInfo?.account && account && previousInfo.account !== account);
  const prev = accountChanged ? {} : (previousInfo ?? {});

  const startedAt = Date.now();
  const recentStart = windowOf(startedAt - RECENT_MS);
  let backfill = planBackfill(prev, startedAt, recentStart);

  // 1. Recent CSV: windows from `recentStart` on.
  let csvResult;
  try {
    csvResult = entriesFromCsv(await fetchUsageCsv(token, { startDate: recentStart, endDate: startedAt }));
  } catch (err) {
    // Auth failure → bubble up so the user sees they need to re-login.
    if (err && err.skip) return exportSkipped(err);
    throw err;
  }
  const warnings = [];
  let csvEntries = [];
  let fallbackEntries = [];
  let latestEventAt = null;
  let latestTokenAt = null;
  let fallbackLatestAt = prev.fallbackLatestAt;
  let events = 0;
  let tokenEvents = 0;

  if (!csvResult.unusable) {
    const recent = await recentFromCsv(csvResult, { token, previousInfo: prev, recentStart });
    csvEntries = recent.entries;
    latestEventAt = recent.latestEventAt;
    latestTokenAt = recent.latestTokenAt;
    fallbackLatestAt = recent.fallbackLatestAt;
    events += recent.events;
    tokenEvents += recent.tokenEvents;
    warnings.push(...recent.warnings);
  } else {
    // 2. Events fallback: once per sync, output not limited to the window.
    const fallback = await eventsFallback(csvResult, { token, previousInfo: prev });
    fallbackEntries = fallback.entries;
    latestEventAt = laterDate(fallback.latestEventAt, csvResult.latestEventAt);
    latestTokenAt = laterDate(fallback.latestTokenAt, csvResult.latestTokenAt);
    events += fallback.events;
    tokenEvents += fallback.entries.length;
    warnings.push(...fallback.warnings);
  }

  // 3. History blocks: `[until, before)`, newest first, within the budget.
  if (backfill) {
    let { before } = backfill;
    while (before > backfill.until && Date.now() - startedAt < BACKFILL_BUDGET_MS) {
      const start = Math.max(backfill.until, before - BACKFILL_BLOCK_MS);
      let block;
      try {
        block = entriesFromCsv(await fetchUsageCsv(token, { startDate: start, endDate: before - 1 }));
      } catch (err) {
        if (!(err && err.skip)) throw err;
        warnings.push(`cursor: 历史补齐本次暂停，下次同步继续（${err.message}）`);
        break;
      }
      if (block.headerMismatch) break;
      csvEntries = csvEntries.concat(block.entries.filter((entry) => {
        const window = windowOf(entry.timestamp);
        return window >= start && window < before;
      }));
      latestEventAt = laterDate(latestEventAt, block.latestEventAt);
      latestTokenAt = laterDate(latestTokenAt, block.latestTokenAt);
      events += block.events;
      tokenEvents += block.entries.length;
      before = start;
    }
    backfill = before > backfill.until ? { before, until: backfill.until } : null;
  }

  // One source per half-hour window: a window with any CSV row is built from
  // the CSV alone; the fallback's events for it are dropped, never added.
  const csvWindows = new Set(csvEntries.map(entry => windowOf(entry.timestamp)));
  const entries = csvEntries.concat(fallbackEntries.filter(entry => !csvWindows.has(windowOf(entry.timestamp))));

  const carried = value => (Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)) : null);
  return {
    buckets: aggregateToBuckets(entries),
    sessions: [],
    // Recent windows and history blocks only, never a whole-account view:
    // upload these, keep every older Cursor state key (no pruning).
    skipped: true,
    warnings,
    info: resultInfo({
      account,
      latestEventAt: laterDate(latestEventAt, carried(prev.latestEventAt)),
      latestTokenAt: laterDate(latestTokenAt, carried(prev.latestTokenAt)),
      events,
      tokenEvents,
      fallbackLatestAt,
      syncedAt: startedAt,
      backfill,
    }),
  };
}
