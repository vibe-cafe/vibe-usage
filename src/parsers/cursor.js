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

// Incremental CSV (issue #131). cursor.com builds the export over the whole
// account, so a heavy account's full CSV (9.5 MB / 84k rows / 137s observed)
// outgrows any fixed timeout and its download held every other tool's upload
// hostage. Once a run has seen this account's newest token event, the next run
// asks only for the tail after it.
//
// Re-read this much history before the previous newest token event, so an
// event that reached the export after the last sync but carries an earlier
// timestamp (a long agent request) still lands in its window.
const INCREMENTAL_OVERLAP_MS = DAY_MS;
// Requested before the first emitted window and then discarded, so a server
// that rounds `startDate` a little later still returns the first window whole.
const INCREMENTAL_MARGIN_MS = HOUR_MS;

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

function csvUrl(range) {
  // Same `startDate` / `endDate` (Unix ms) filter the dashboard's own date
  // picker sends. Without a range this is the unchanged whole-account export.
  const params = range
    ? `startDate=${range.startDate}&endDate=${range.endDate}&strategy=tokens`
    : 'strategy=tokens';
  return `${cursorWebBase()}${CSV_PATH}?${params}`;
}

async function fetchCsv(headers, signal, range) {
  const url = csvUrl(range);
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
  const err = skipped(`Cursor usage export skipped (HTTP ${resp.status} ${resp.statusText})`);
  err.status = resp.status;
  throw err;
}

// A ranged request the server refuses outright (4xx other than auth and rate
// limiting) says nothing about the whole export: if cursor.com ever stops
// accepting the date range, take the whole export instead of skipping Cursor
// on every run.
function rangeRejected(err) {
  return Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 && err.status !== 429;
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
      unusable: `导出表头与预期不符（当前表头: ${header.slice(0, 8).join(', ')}）`,
    };
  }

  const entries = [];
  // Every dated row's time, token-bearing or not. The incremental path counts
  // the rows it has not seen before so `status` keeps an account-wide total.
  const eventTimes = [];
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
    eventTimes.push(timestamp.getTime());
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
      eventTimes,
      latestEventAt,
      latestTokenAt,
      unusable: eventCount > 0 ? `返回了 ${eventCount} 行，但没有任何 token 计数` : '没有返回任何用量行',
    };
  }
  return { entries, events: eventCount, eventTimes, latestEventAt, latestTokenAt };
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

function resultInfo({ account, latestEventAt, latestTokenAt, events, tokenEvents, fallbackLatestAt }) {
  return {
    ...(account ? { account } : {}),
    ...(latestEventAt ? { latestEventAt: new Date(latestEventAt).toISOString() } : {}),
    ...(latestTokenAt ? { latestTokenAt: new Date(latestTokenAt).toISOString() } : {}),
    events,
    tokenEvents,
    ...(fallbackLatestAt ? { fallbackLatestAt } : {}),
  };
}

/**
 * Plan an incremental CSV request from the previous run's diagnostics, or
 * return null for the unchanged whole-account export. The tail needs the same
 * signed-in account and the newest token event that run already saw, so a
 * first run, a reset (state.json cleared), a re-bind (parserMeta dropped with
 * the old identity) and an account switch all take the full export.
 *
 * Only whole half-hour windows starting at `emitFrom` are emitted. Earlier
 * windows are not requested completely, and the server upserts by bucket key:
 * a partial window would replace the complete value it already holds.
 */
export function incrementalCsvPlan(previousInfo, account, now = Date.now()) {
  if (!account || previousInfo?.account !== account) return null;
  const anchor = Date.parse(previousInfo?.latestTokenAt);
  if (!Number.isFinite(anchor) || anchor > now) return null;
  // Same window function as aggregateToBuckets(), so `emitFrom` is always a
  // real bucket boundary on this machine.
  const emitFrom = roundToHalfHour(new Date(anchor - INCREMENTAL_OVERLAP_MS)).getTime();
  return {
    anchor,
    emitFrom,
    range: { startDate: emitFrom - INCREMENTAL_MARGIN_MS, endDate: now },
  };
}

/**
 * A tail may stand in for the whole export only when it overlaps history a
 * previous run already saw: at least one token row between `emitFrom` and the
 * previous newest token event. Anything else is ambiguous -- an idle account
 * and an X Subscription account whose export went empty look the same; so do a
 * CSV that stopped growing and a server that answered a different range -- so
 * the caller takes the full export and the 0.14.5 rules for those cases.
 */
function tailContinuesHistory(csvResult, plan) {
  if (csvResult.unusable) return false;
  return csvResult.entries.some((entry) => {
    const time = entry.timestamp.getTime();
    return time >= plan.emitFrom && time <= plan.anchor;
  });
}

function earliest(times) {
  let min = Infinity;
  for (const time of times) if (time < min) min = time;
  return min;
}

function knownCount(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * A usable CSV -- the whole export, or (with `plan`) a tail that continues
 * known history. The stale-gap probe below runs identically for both: a tail
 * that overlaps known history contains the export's newest token row, so the
 * probe sees the same boundary the full export would have given it.
 */
async function fromUsableCsv(csvResult, { token, account, previousInfo, plan = null }) {
  let entries = csvResult.entries;
  let eventTimes = csvResult.eventTimes;
  let latest = csvResult.latestEventAt;
  let latestToken = csvResult.latestTokenAt ?? csvResult.latestEventAt;
  let eventCount = csvResult.events;
  let fallbackLatestAt = previousInfo?.fallbackLatestAt;
  const warnings = [];

  // The CSV can be valid but stop growing (observed after account
  // switches/unification). Probe the dashboard events endpoint for the gap,
  // but only take events after the CSV's newest *token* row: historical rows
  // there are labelled `default`, and re-adding them would double-count
  // history. Bounded to a recent gap so an idle account does not probe
  // forever.
  const boundaryMs = latestToken ? latestToken.getTime() : NaN;
  const now = Date.now();
  if (Number.isFinite(boundaryMs) && now - boundaryMs > DAY_MS && now - boundaryMs <= 7 * DAY_MS) {
    try {
      const probe = await fetchUsageEvents(token, {
        startDate: String(Math.max(0, boundaryMs - HOUR_MS)),
      });
      const newer = probe.events.filter((event) => {
        const timestamp = eventTimestamp(event?.timestamp);
        return timestamp && timestamp.getTime() > boundaryMs;
      });
      const extra = entriesFromEvents(newer);
      if (extra.entries.length > 0) {
        entries = entries.concat(extra.entries);
        eventTimes = eventTimes.concat(newer.map(event => eventTimestamp(event.timestamp).getTime()));
        if (extra.latestEventAt && (!latest || extra.latestEventAt > latest)) {
          latest = extra.latestEventAt;
        }
        if (extra.latestTokenAt && (!latestToken || extra.latestTokenAt > latestToken)) {
          latestToken = extra.latestTokenAt;
        }
        eventCount += newer.length;
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

  if (!plan) {
    return {
      buckets: aggregateToBuckets(entries),
      sessions: [],
      warnings,
      info: resultInfo({
        account,
        latestEventAt: latest,
        latestTokenAt: latestToken,
        events: eventCount,
        tokenEvents: entries.length,
        fallbackLatestAt,
      }),
    };
  }

  // Which windows the tail holds whole. Judged by each entry's window start,
  // not its raw time: on the night clocks fall back, roundToHalfHour() can
  // place an event up to 90 minutes before its own timestamp, so an event
  // just after `emitFrom` can belong to a window that started before it --
  // and that window's earlier events were never requested.
  //
  // A window that starts before the first row the server actually returned is
  // skipped too: if cursor.com started the range later than asked (beyond the
  // one-hour margin), that window is cut. Ordinarily the first row lies in the
  // margin and this changes nothing; when the margin hour was idle, the
  // skipped window is one an earlier run already uploaded whole. Windows that
  // hold rows newer than the previous newest token event, and that event's own
  // window, are always rebuilt -- they hold what this run exists to send.
  const firstRowAt = earliest(csvResult.eventTimes);
  const anchorWindow = roundToHalfHour(new Date(plan.anchor)).getTime();
  const windowOfEntry = entry => roundToHalfHour(entry.timestamp).getTime();
  const newWindows = new Set(entries.filter(entry => entry.timestamp.getTime() > plan.anchor).map(windowOfEntry));
  const emitted = entries.filter((entry) => {
    const start = windowOfEntry(entry);
    if (start < plan.emitFrom) return false;
    return start >= anchorWindow || newWindows.has(start) || !(firstRowAt > start);
  });
  // `status` shows the account's event count. A tail only sees recent rows, so
  // add the rows newer than what the previous run had already counted instead
  // of reporting the tail's size as if the account had shrunk.
  const previousEvents = knownCount(previousInfo?.events);
  const previousTokenEvents = knownCount(previousInfo?.tokenEvents);
  const countedThrough = Date.parse(previousInfo?.latestEventAt);
  const eventFloor = Number.isFinite(countedThrough) ? countedThrough : plan.anchor;
  const events = previousEvents === null
    ? eventTimes.filter(time => time >= plan.emitFrom).length
    : previousEvents + eventTimes.filter(time => time > eventFloor).length;
  const tokenEvents = previousTokenEvents === null
    ? emitted.length
    : previousTokenEvents + entries.filter(entry => entry.timestamp.getTime() > plan.anchor).length;

  return {
    buckets: aggregateToBuckets(emitted),
    sessions: [],
    // A tail is a partial view by construction. `skipped` keeps sync.js from
    // pruning Cursor's older state keys -- the windows this run did not ask
    // for -- so they are neither forgotten nor re-sent later; every bucket
    // above is still diffed and uploaded as usual. The next full export
    // (account switch, reset, re-bind, ambiguous tail) is a complete view and
    // prunes normally.
    skipped: true,
    warnings,
    info: resultInfo({
      account,
      latestEventAt: latest,
      latestTokenAt: latestToken,
      events,
      tokenEvents,
      fallbackLatestAt,
    }),
  };
}

function exportSkipped(err) {
  // Network/timeout → skip with diagnostics. Tell sync.js this was not a
  // successful empty snapshot so it preserves Cursor's incremental state
  // instead of pruning it as dead history.
  return {
    buckets: [],
    sessions: [],
    skipped: true,
    warnings: [`cursor: ${err.message}`],
  };
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

  const sub = decodeJwtSub(token);
  const account = cursorAccountLabel(sub);

  const plan = incrementalCsvPlan(previousInfo, account);
  if (plan) {
    let tail;
    try {
      tail = entriesFromCsv(await fetchUsageCsv(token, plan.range));
    } catch (err) {
      // Auth failure → bubble up so the user sees they need to re-login.
      if (!rangeRejected(err)) {
        if (err && err.skip) return exportSkipped(err);
        throw err;
      }
      tail = null;
    }
    if (tail && tailContinuesHistory(tail, plan)) {
      return fromUsableCsv(tail, { token, account, previousInfo, plan });
    }
    // Ambiguous tail: fall through to the whole-account export, unchanged.
  }

  let csvResult;
  try {
    csvResult = entriesFromCsv(await fetchUsageCsv(token));
  } catch (err) {
    // Auth failure → bubble up so user sees they need to re-login in Cursor.
    if (err && err.skip) return exportSkipped(err);
    throw err;
  }

  if (!csvResult.unusable) {
    return fromUsableCsv(csvResult, { token, account, previousInfo });
  }

  // The CSV parsed but contained no usable usage events. Try the dashboard's
  // events API before treating the account as empty. "New usage" -- what the
  // warning reports and what decides whether this run uploads at all -- is
  // only events newer than the previous sync's newest event: the events API
  // labels many older rows as model `default`, and re-adding known history
  // under that name would double-count it as a second set of buckets. On a
  // first run (no previous info) the fallback is bounded to the last seven
  // days for the same reason.
  //
  // One deliberate exception (#131): the previous newest event's own window
  // is rebuilt from every event in it. Before, the request started at that
  // event, so each fallback run rebuilt the window from only the newer events
  // and the partial value replaced the complete one (or, being smaller, was
  // refused and the newer events were lost) whenever activity crossed a sync.
  // The cost: when the CSV first comes back empty, that window was last
  // uploaded from the CSV; if the events API names its model differently
  // (`default` vs `auto`), the rebuilt copy is a second key and the part of
  // that window before the previous newest event counts twice. One window --
  // and one more each time the export flips between empty and non-empty.
  const previousLatest = Date.parse(previousInfo?.latestTokenAt ?? previousInfo?.latestEventAt);
  const hasPreviousLatest = Number.isFinite(previousLatest);
  // The newest events the previous run saw stay the anchor until newer ones
  // arrive. Dropping them on a run without new events sent the next run back
  // to "the last seven days". Not carried across an account switch: a new
  // account starts like a first run.
  const sameAccount = !previousInfo?.account || previousInfo.account === account;
  const carried = (value) => {
    const time = sameAccount ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? new Date(time) : null;
  };
  const previousEventAt = carried(previousInfo?.latestEventAt);
  const previousTokenAt = carried(previousInfo?.latestTokenAt);
  const windowStart = roundToHalfHour(
    new Date(hasPreviousLatest ? previousLatest : Date.now() - 7 * DAY_MS),
  ).getTime();
  const fallbackStart = hasPreviousLatest ? Math.max(0, windowStart - HOUR_MS) : windowStart;
  let events;
  try {
    events = await fetchUsageEvents(token, { startDate: String(fallbackStart) });
  } catch (err) {
    if (err && err.skip) {
      return {
        buckets: [],
        sessions: [],
        skipped: true,
        warnings: [
          `cursor: CSV 导出不可用（${csvResult.unusable}）；事件接口也失败：${err.message}`,
        ],
        info: resultInfo({
          account,
          latestEventAt: laterDate(csvResult.latestEventAt, previousEventAt),
          latestTokenAt: laterDate(csvResult.latestTokenAt, previousTokenAt),
          events: csvResult.events,
          tokenEvents: csvResult.entries.length,
        }),
      };
    }
    throw err;
  }

  const eventTime = (event) => eventTimestamp(event?.timestamp)?.getTime() ?? NaN;
  const candidateEvents = hasPreviousLatest
    ? events.events.filter(event => eventTime(event) > previousLatest)
    : events.events;
  const fallback = entriesFromEvents(candidateEvents);
  // What is uploaded: every event of every window from the previous newest
  // event's window on, plus any earlier window that holds a new event, each
  // rebuilt whole. Judged by window start, not raw time: on the night clocks
  // fall back a new event can belong to a window that began before the
  // previous newest event (see the tail filter above). Every such window
  // starts after `fallbackStart`, so all of its events were requested.
  const windowOf = (event) => roundToHalfHour(new Date(eventTime(event))).getTime();
  const newWindows = new Set(candidateEvents.map(windowOf));
  const windowEntries = hasPreviousLatest
    ? entriesFromEvents(events.events.filter((event) => {
      const start = windowOf(event);
      return start >= windowStart || newWindows.has(start);
    })).entries
    : fallback.entries;
  const windowLabel = hasPreviousLatest
    ? `${new Date(previousLatest).toISOString()} 之后`
    : '最近 7 天';
  const info = resultInfo({
    account,
    latestEventAt: laterDate(laterDate(fallback.latestEventAt, csvResult.latestEventAt), previousEventAt),
    latestTokenAt: laterDate(laterDate(fallback.latestTokenAt, csvResult.latestTokenAt), previousTokenAt),
    events: candidateEvents.length,
    tokenEvents: fallback.tokenEventCount,
  });

  if (fallback.entries.length === 0) {
    return {
      buckets: [],
      sessions: [],
      skipped: true,
      warnings: [
        `cursor: CSV 导出不可用（${csvResult.unusable}），事件接口在${windowLabel}也没有读到 token 用量。`
        + '如果刚切换到 X 订阅，Cursor 的用量可能并入 grok.com/dashboard；本次已跳过以保留历史。',
      ],
      info,
    };
  }

  return {
    buckets: aggregateToBuckets(windowEntries),
    sessions: [],
    // Recent windows only, never the whole history: keep sync.js from pruning
    // Cursor's older state keys, which would re-send all of them the next time
    // the CSV is usable again.
    skipped: true,
    warnings: [
      `cursor: CSV 导出不可用（${csvResult.unusable}），已从仪表盘事件接口补回${windowLabel}的 `
      + `${fallback.tokenEventCount} 个 token 事件；这些事件的模型名可能显示为 default（不影响 token 总量）。`,
    ],
    info,
  };
}
