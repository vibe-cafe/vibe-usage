import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { aggregateToBuckets } from './index.js';

const STATE_DB_RELATIVE = join('User', 'globalStorage', 'state.vscdb');
const ACCESS_TOKEN_KEY = 'cursorAuth/accessToken';
const SESSION_COOKIE = 'WorkosCursorSessionToken';

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

function readAccessToken(dbPath) {
  let snapshotDir = null;
  let queryPath = dbPath;
  try {
    return queryAccessToken(queryPath);
  } catch (err) {
    // Cursor app holds a write lock; copy WAL set to a temp dir and retry
    if (!isLockError(err)) throw err;
    snapshotDir = mkdtempSync(join(tmpdir(), 'vibe-usage-cursor-'));
    queryPath = join(snapshotDir, 'state.vscdb');
    copyFileSync(dbPath, queryPath);
    for (const suffix of ['-shm', '-wal']) {
      const companion = `${dbPath}${suffix}`;
      if (existsSync(companion)) copyFileSync(companion, `${queryPath}${suffix}`);
    }
    try {
      return queryAccessToken(queryPath);
    } finally {
      rmSync(snapshotDir, { recursive: true, force: true });
    }
  }
}

function queryAccessToken(dbPath) {
  const sql = `SELECT value FROM ItemTable WHERE key = '${ACCESS_TOKEN_KEY}' LIMIT 1`;
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], {
    encoding: 'utf-8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 15000,
  });
  const trimmed = out.trim();
  if (!trimmed || trimmed === '[]') return null;
  const rows = JSON.parse(trimmed);
  const value = rows[0]?.value;
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t || null;
}

function isLockError(err) {
  return err && typeof err.message === 'string' && /database is locked/i.test(err.message);
}

function decodeJwtSub(token) {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
    const json = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
    return typeof json.sub === 'string' ? json.sub.trim() : null;
  } catch {
    return null;
  }
}

async function fetchUsageCsv(token) {
  const url = `${(process.env.CURSOR_WEB_BASE_URL?.trim() || 'https://cursor.com').replace(/\/+$/, '')}/api/dashboard/export-usage-events-csv?strategy=tokens`;
  const sub = decodeJwtSub(token);
  const cookieValues = sub ? [token, `${sub}::${token}`] : [token];

  const attempts = [{ Authorization: `Bearer ${token}` }];
  for (const cv of cookieValues) {
    attempts.push({ Cookie: `${SESSION_COOKIE}=${cv}` });
    attempts.push({ Authorization: `Bearer ${token}`, Cookie: `${SESSION_COOKIE}=${cv}` });
  }

  const failures = [];
  for (const headers of attempts) {
    let resp;
    try {
      resp = await fetch(url, { headers: { Accept: 'text/csv,*/*;q=0.8', ...headers } });
    } catch (e) {
      failures.push(`network: ${e.message}`);
      continue;
    }
    if (resp.ok) return await resp.text();
    failures.push(`${resp.status} ${resp.statusText}`);
  }
  throw new Error(`Cursor usage export failed (${failures.join('; ')})`);
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

export async function parse() {
  const dbPath = getCursorStateDbPath();
  if (!dbPath) return { buckets: [], sessions: [] };

  let token;
  try {
    token = readAccessToken(dbPath);
  } catch (err) {
    if (err && typeof err.message === 'string' && err.message.includes('ENOENT')) {
      throw new Error('sqlite3 CLI not found. Install sqlite3 to sync Cursor data.');
    }
    throw err;
  }
  if (!token) return { buckets: [], sessions: [] };

  const csv = await fetchUsageCsv(token);
  const rows = parseCsv(csv);
  if (rows.length < 2) return { buckets: [], sessions: [] };

  const header = rows[0].map(h => h.trim());
  const idx = (name) => header.indexOf(name);
  const dateIdx = idx('Date');
  const modelIdx = idx('Model');
  const inputCacheWriteIdx = idx('Input (w/ Cache Write)');
  const inputNoCacheIdx = idx('Input (w/o Cache Write)');
  const cacheReadIdx = idx('Cache Read');
  const outputIdx = idx('Output Tokens');

  if (dateIdx < 0 || modelIdx < 0) return { buckets: [], sessions: [] };

  const entries = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 1 && row[0].trim() === '') continue;
    const timestamp = parseDate(row[dateIdx]);
    const model = row[modelIdx]?.trim();
    if (!timestamp || !model) continue;

    const inputCacheWrite = inputCacheWriteIdx >= 0 ? parseInt0(row[inputCacheWriteIdx]) : 0;
    const inputNoCache = inputNoCacheIdx >= 0 ? parseInt0(row[inputNoCacheIdx]) : 0;
    const cacheRead = cacheReadIdx >= 0 ? parseInt0(row[cacheReadIdx]) : 0;
    const output = outputIdx >= 0 ? parseInt0(row[outputIdx]) : 0;

    if (inputCacheWrite + inputNoCache + cacheRead + output === 0) continue;

    entries.push({
      source: 'cursor',
      model,
      project: 'unknown',
      timestamp,
      inputTokens: inputCacheWrite + inputNoCache,
      outputTokens: output,
      cachedInputTokens: cacheRead,
      reasoningOutputTokens: 0,
    });
  }

  return { buckets: aggregateToBuckets(entries), sessions: [] };
}
