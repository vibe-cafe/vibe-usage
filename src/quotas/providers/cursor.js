import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { queryDbJsonSnapshotOnLock } from '../../parsers/sqlite.js';
import { attachCacheScope } from '../cache.js';
import { quotaResult } from '../schema.js';

const USAGE_URL = 'https://cursor.com/api/usage-summary';
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function cursorQuotaDbPath(environment = process.env, home = homedir(), platform = process.platform) {
  if (environment.CURSOR_STATE_DB_PATH?.trim()) return resolve(environment.CURSOR_STATE_DB_PATH.trim());
  const relative = join('User', 'globalStorage', 'state.vscdb');
  if (environment.CURSOR_CONFIG_DIR?.trim()) {
    const paths = environment.CURSOR_CONFIG_DIR.split(',').map(p => p.trim()).filter(Boolean)
      .map(p => p.endsWith('.vscdb') ? resolve(p) : resolve(p, relative));
    return paths.find(p => existsSync(p)) || paths[0];
  }
  const root = platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : platform === 'win32' ? environment.APPDATA || join(home, 'AppData', 'Roaming')
      : environment.XDG_CONFIG_HOME || join(home, '.config');
  return join(root, 'Cursor', relative);
}

export function readCursorQuotaToken(path) {
  if (!path || !existsSync(path)) return null;
  // Only the app's own access token, never browser cookies, refresh tokens,
  // account profile or unrelated database entries. Hex supports TEXT/BLOB.
  const rows = queryDbJsonSnapshotOnLock(path,
    "SELECT hex(value) AS token FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1",
    { tempPrefix: 'vibe-usage-cursor-quota-', opts: { timeout: 2000, maxBuffer: 65536 } });
  if (!rows[0]?.token) return null;
  const bytes = Buffer.from(rows[0].token, 'hex');
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe || bytes[1] === 0;
  const token = bytes.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '').trim();
  if (!token || token.length > 16384 || /[\x00-\x20\x7f]/.test(token)) return null;
  return token;
}

export function cursorSessionCookies(token) {
  let subject;
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
    if (typeof claims.sub === 'string' && claims.sub.trim()) subject = claims.sub.trim();
  } catch { /* A non-JWT session can still be accepted by Cursor. */ }
  return [...new Set([subject ? `${subject}::${token}` : token, token])]
    .map(value => `WorkosCursorSessionToken=${encodeURIComponent(value)}`);
}

export function parseCursorQuota(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || !payload.individualUsage && !payload.teamUsage) throw new Error('Invalid Cursor quota response');
  const meters = [];
  const date = value => typeof value === 'string' ? Date.parse(value) : NaN;
  const start = date(payload.billingCycleStart);
  const end = date(payload.billingCycleEnd);
  const resetsAt = Number.isFinite(end) ? new Date(end).toISOString() : undefined;
  // The real cycle length lets the card draw the same elapsed-time bar as Codex.
  const windowSeconds = Number.isFinite(start) && end > start ? (end - start) / 1000 : undefined;
  const add = (id, label, value, extra = {}) => {
    if (finite(value)) meters.push({ id, label, utilization: value, resetsAt, windowSeconds, ...extra });
  };
  const ratio = item => item?.enabled !== false && finite(item?.used) && finite(item?.limit) && item.limit > 0
    ? item.used / item.limit * 100 : undefined;
  const plan = payload.individualUsage?.plan;
  if (plan?.enabled !== false) {
    // Auto/API split the same allowance, so they ride along as detail of the
    // one Month row instead of reading as separate limits. Percentage units:
    // 0.36 means 0.36%, not 36%.
    const breakdown = [['auto', 'Cursor models', plan?.autoPercentUsed],
      ['api', 'Third-party models', plan?.apiPercentUsed]]
      .filter(([, , value]) => finite(value))
      .map(([id, label, utilization]) => ({ id, label, utilization }));
    add('plan', 'Month', finite(plan?.totalPercentUsed) ? plan.totalPercentUsed : ratio(plan),
      breakdown.length ? { breakdown } : {});
  }
  if (!meters.length) {
    add('personal', 'Month', ratio(payload.individualUsage?.overall));
    if (!meters.length) add('team', 'Team', ratio(payload.teamUsage?.pooled));
  }
  add('on-demand', 'On-demand', ratio(payload.individualUsage?.onDemand));
  return meters;
}

export async function fetchCursorQuota({
  environment = process.env, home = homedir(), platform = process.platform,
  fetchImpl = globalThis.fetch, now = new Date(), timeoutMs = 10000,
} = {}) {
  const result = (status, extra = {}) => quotaResult({ id: 'cursor', status, fetchedAt: now, ...extra });
  let token;
  try { token = readCursorQuotaToken(cursorQuotaDbPath(environment, home, platform)); }
  catch { return result('retryable_error', { message: 'Cursor login could not be read' }); }
  if (!token) return result('missing_credentials', { message: 'Open Cursor and sign in, then retry' });
  const scoped = (status, extra) => attachCacheScope(result(status, extra), token);
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    for (const cookie of cursorSessionCookies(token)) {
      const response = await fetchImpl(USAGE_URL, {
        headers: { Cookie: cookie, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0',
          Origin: 'https://cursor.com', Referer: 'https://cursor.com/dashboard?tab=usage' },
        signal, redirect: 'error',
      });
      if ([401, 403].includes(response.status)) { await response.body?.cancel(); continue; }
      if (!response.ok) {
        await response.body?.cancel();
        return scoped('retryable_error', { message: `Cursor quota API returned HTTP ${response.status}` });
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error('Oversized response');
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const meters = parseCursorQuota(payload);
      const plans = { free: 'Free', pro: 'Pro', premium: 'Pro', pro_plus: 'Pro+', ultra: 'Ultra',
        enterprise: 'Enterprise', team: 'Team' };
      return scoped(meters.length ? 'ok' : 'no_data', { meters,
        planLabel: plans[payload.membershipType],
        ...(meters.length ? {} : { emptyReason: 'noWindow' }) });
    }
    return scoped('unauthorized', { message: 'Open Cursor and sign in again, then retry' });
  } catch {
    return scoped('retryable_error', { message: 'Cursor quota request failed; retry after checking the connection' });
  }
}
