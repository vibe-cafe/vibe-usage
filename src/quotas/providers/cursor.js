import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isEncryptedCursorToken } from '../../parsers/cursor.js';
import { cursorRefreshURL, cursorSignInBlock, cursorWebBase, endStoredCursorLogin, freshCursorLogin, resolveCursorLogin } from '../../cursor-login.js';
import { queryDbJsonSnapshotOnLock } from '../../parsers/sqlite.js';
import { attachCacheScope } from '../cache.js';
import { quotaResult } from '../schema.js';

// `CURSOR_WEB_BASE_URL` is the test hook the sync parser already honors.
const usageURL = environment => `${cursorWebBase(environment)}/api/usage-summary`;
// Issue #144: same decision as the sync parser -- no local decryption, and
// signing in to Cursor again only writes the same ciphertext. The way back is
// the separate Vibe Usage sign-in (`cursor-login.js`): `signIn` tells the
// desktop apps to offer it.
const ENCRYPTED_TOKEN_MESSAGE = 'Cursor stores its local login encrypted; sign in to Cursor in Vibe Usage '
  + '(vibe-usage login cursor) to read its quota.';
const LOGIN_EXPIRED_MESSAGE = 'The Cursor sign-in saved by Vibe Usage has expired; sign in again (vibe-usage login cursor).';
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

/**
 * The URLs a quota read requests: the usage summary, plus the renewal URL when
 * a stored Vibe Usage sign-in may be renewed on the way.
 */
export function cursorQuotaNetworkURLs({ environment = process.env } = {}) {
  const login = resolveCursorLogin(environment);
  const urls = [usageURL(environment)];
  return login?.kind === 'stored' && !login.unusable ? [...urls, cursorRefreshURL(environment)] : urls;
}

export async function fetchCursorQuota({
  environment = process.env, home = homedir(), platform = process.platform,
  fetchImpl = globalThis.fetch, now = new Date(), timeoutMs = 10000, sleep,
} = {}) {
  const result = (status, extra = {}) => quotaResult({ id: 'cursor', status, fetchedAt: now, ...extra });
  const expired = () => result('unsupported', { message: LOGIN_EXPIRED_MESSAGE, signIn: 'expired' });
  // The separate Vibe Usage sign-in first (the app's, else the stored one).
  const login = resolveCursorLogin(environment);
  if (login?.unusable) return expired();
  if (login) {
    if (login.kind === 'stored') {
      // The registry already applied the environment's proxy; a terminal or
      // background run on a machine with a system proxy it was not told
      // about must not send the stored sign-in direct.
      const block = cursorSignInBlock([], { env: environment, blockFor: () => null });
      if (block) return result('unsupported', { message: block.message });
    }
    const options = { env: environment, fetchImpl, now, ...(sleep ? { sleep } : {}) };
    const fresh = await freshCursorLogin(login, options);
    if (fresh.expired) return expired();
    if (fresh.retryable) return result('retryable_error', { message: 'Cursor sign-in renewal did not complete; retrying later' });
    // The token changes on every renewal; the account does not.
    let answer = await readCursorQuota(fresh.credential.accessToken, `user:${fresh.credential.userId}`);
    if (answer.status !== 'unauthorized') return answer;
    if (login.kind !== 'stored') return expired();
    let rejected = fresh.credential;
    if (!fresh.refreshed) {
      const renewed = await freshCursorLogin(login, { ...options, force: true });
      if (renewed.expired) return expired();
      if (renewed.retryable) return result('retryable_error', { message: 'Cursor sign-in renewal did not complete; retrying later' });
      answer = await readCursorQuota(renewed.credential.accessToken, `user:${renewed.credential.userId}`);
      if (answer.status !== 'unauthorized') return answer;
      rejected = renewed.credential;
    }
    await endStoredCursorLogin({ kind: 'stored', credential: rejected }, environment, sleep ? { sleep } : {});
    return expired();
  }

  let token;
  try { token = readCursorQuotaToken(cursorQuotaDbPath(environment, home, platform)); }
  catch { return result('retryable_error', { message: 'Cursor login could not be read' }); }
  if (!token) return result('missing_credentials', { message: 'Open Cursor and sign in, then retry' });
  // Sent as a cookie the ciphertext is a certain 401 ("sign in again"). Like
  // missing_credentials this result carries no cache scope, so the registry
  // neither writes a cache entry for it nor falls back to an older one.
  if (isEncryptedCursorToken(token)) return result('unsupported', { message: ENCRYPTED_TOKEN_MESSAGE, signIn: 'required' });
  return readCursorQuota(token, token);

  async function readCursorQuota(sessionToken, scope) {
    const scoped = (status, extra) => attachCacheScope(result(status, extra), scope);
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      for (const cookie of cursorSessionCookies(sessionToken)) {
        const response = await fetchImpl(usageURL(environment), {
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
}
