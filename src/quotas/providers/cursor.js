import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isEncryptedCursorToken } from '../../parsers/cursor.js';
import { desktopAppOlderThan } from '../../client-meta.js';
import { systemProxyConfigured } from '../../system-proxy.js';
import { CURSOR_USER_AGENT, cursorApiBase, cursorRefreshURL, cursorSignInBlock, cursorUserId, cursorWebBase, endStoredCursorLogin, freshCursorLogin, resolveCursorLogin } from '../../cursor-login.js';
import { queryDbJsonSnapshotOnLock } from '../../parsers/sqlite.js';
import { attachCacheScope, loadCursorPlan, preferCursorWebSummary, quotaCacheScope, rememberMeterlessCursorPeriod, saveCursorPlan } from '../cache.js';
import { quotaResult } from '../schema.js';
import { InvalidQuotaResponse, parseQuotaPayload, requestFailureReason } from '../response.js';

const summaryURL = environment => `${cursorWebBase(environment)}/api/usage-summary`;
// These app releases added api2.cursor.sh to the hosts they resolve through PAC.
function dashboardService(environment) {
  if (desktopAppOlderThan({ 'mac-app': '0.8.1', 'windows-app': '0.7.10' }, environment)
      && systemProxyConfigured({ env: environment })) return null;
  return `${cursorApiBase(environment)}/aiserver.v1.DashboardService`;
}
const plans = { free: 'Free', free_trial: 'Pro Trial', pro_student: 'Pro Student', express: 'Express',
  pro: 'Pro', premium: 'Pro', pro_plus: 'Pro+', ultra: 'Ultra', enterprise: 'Enterprise', team: 'Team' };
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
  const date = value => typeof value === 'string' ? Date.parse(value) : NaN;
  const { plan, overall, onDemand } = payload.individualUsage || {};
  return cursorMeters({ start: date(payload.billingCycleStart), end: date(payload.billingCycleEnd),
    plan, overall, onDemand, pooled: payload.teamUsage?.pooled });
}

function periodMeters(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new InvalidQuotaResponse();
  const plan = payload?.planUsage;
  const spend = payload?.spendLimitUsage;
  // Connect JSON int64s are decimal strings; the editor passes these milliseconds to Date.
  const date = value => Number(value) > 0 ? new Date(Number(value)).getTime() : NaN;
  return cursorMeters({
    start: date(payload?.billingCycleStart), end: date(payload?.billingCycleEnd),
    plan: plan && { ...plan, used: plan.includedSpend },
    overall: { used: spend?.overallUsed, limit: spend?.overallLimit },
    pooled: { used: spend?.pooledUsed, limit: spend?.pooledLimit },
    // individualUsed is a non-optional int32: protobuf can omit its zero value.
    onDemand: { used: spend?.individualUsed ?? 0, limit: spend?.individualLimit },
  });
}

function cursorMeters({ start, end, plan, overall, pooled, onDemand }) {
  const meters = [];
  const resetsAt = Number.isFinite(end) ? new Date(end).toISOString() : undefined;
  // The real cycle length lets the card draw the same elapsed-time bar as Codex.
  const windowSeconds = Number.isFinite(start) && end > start ? (end - start) / 1000 : undefined;
  const add = (id, label, value, extra = {}) => {
    if (finite(value)) meters.push({ id, label, utilization: value, resetsAt, windowSeconds, ...extra });
  };
  const ratio = item => item?.enabled !== false && finite(item?.used) && finite(item?.limit) && item.limit > 0
    ? item.used / item.limit * 100 : undefined;
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
    add('personal', 'Month', ratio(overall));
    if (!meters.length) add('team', 'Team', ratio(pooled));
  }
  add('on-demand', 'On-demand', ratio(onDemand));
  return meters;
}

/**
 * Every host that could receive credentials, including fallback and renewal.
 */
export function cursorQuotaNetworkURLs({ environment = process.env } = {}) {
  const login = resolveCursorLogin(environment);
  const service = dashboardService(environment);
  const urls = service ? [`${service}/GetCurrentPeriodUsage`, `${service}/GetPlanInfo`] : [];
  urls.push(summaryURL(environment));
  return login?.kind === 'stored' && !login.unusable ? [...urls, cursorRefreshURL(environment)] : urls;
}

async function readPayload(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new InvalidQuotaResponse('Oversized response');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function fetchCursorQuota({
  environment = process.env, home = homedir(), platform = process.platform,
  fetchImpl = globalThis.fetch, now = new Date(), timeoutMs = 10000, sleep,
} = {}) {
  const result = (status, extra = {}) => quotaResult({ id: 'cursor', status, fetchedAt: now, ...extra });
  const expired = () => result('unsupported', { failureReason: 'credentialsRejected', message: LOGIN_EXPIRED_MESSAGE, signIn: 'expired' });
  const renewalFailed = () => result('retryable_error', { failureReason: 'loginRefreshFailed',
    message: 'Cursor sign-in renewal did not complete; retrying later' });
  // The separate Vibe Usage sign-in first (the app's, else the stored one).
  const login = resolveCursorLogin(environment);
  if (login?.unusable) return expired();
  if (login) {
    if (login.kind === 'stored') {
      // The registry already applied the environment's proxy; a terminal or
      // background run on a machine with a system proxy it was not told
      // about must not send the stored sign-in direct.
      const block = cursorSignInBlock([], { env: environment, blockFor: () => null });
      if (block) return result('unsupported', { pauseReason: 'proxyUnsupported', message: block.message });
    }
    const options = { env: environment, fetchImpl, now, ...(sleep ? { sleep } : {}) };
    const fresh = await freshCursorLogin(login, options);
    if (fresh.expired) return expired();
    if (fresh.retryable) return renewalFailed();
    // The token changes on every renewal; the account does not.
    let answer = await readCursorQuota(fresh.credential.accessToken, `user:${fresh.credential.userId}`);
    if (answer.status !== 'unauthorized') return answer;
    if (login.kind !== 'stored') return expired();
    let rejected = fresh.credential;
    if (!fresh.refreshed) {
      const renewed = await freshCursorLogin(login, { ...options, force: true });
      if (renewed.expired) return expired();
      if (renewed.retryable) return renewalFailed();
      answer = await readCursorQuota(renewed.credential.accessToken, `user:${renewed.credential.userId}`);
      if (answer.status !== 'unauthorized') return answer;
      rejected = renewed.credential;
    }
    await endStoredCursorLogin({ kind: 'stored', credential: rejected }, environment, sleep ? { sleep } : {});
    return expired();
  }

  let token;
  try { token = readCursorQuotaToken(cursorQuotaDbPath(environment, home, platform)); }
  catch { return result('retryable_error', { failureReason: 'credentialsUnreadable', message: 'Cursor login could not be read' }); }
  if (!token) return result('missing_credentials', { message: 'Open Cursor and sign in, then retry' });
  // Ciphertext cannot authenticate either request and carries no cache scope.
  if (isEncryptedCursorToken(token)) {
    return result('unsupported', { failureReason: 'credentialsEncrypted', message: ENCRYPTED_TOKEN_MESSAGE, signIn: 'required' });
  }
  // Apps resolve their own PAC. A terminal using the editor's token needs the
  // same system-proxy check as one using a separately stored sign-in.
  if (!/-app$/.test(environment.VIBE_USAGE_SURFACE || '')) {
    const block = cursorSignInBlock([], { env: environment, blockFor: () => null });
    if (block) return result('unsupported', { pauseReason: 'proxyUnsupported', message: block.message });
  }
  return readCursorQuota(token, token);

  async function readCursorQuota(sessionToken, scope) {
    const service = dashboardService(environment);
    const userId = cursorUserId(sessionToken);
    const accountScope = quotaCacheScope('cursor', userId ? `user:${userId}` : sessionToken);
    if (service && !preferCursorWebSummary(accountScope, now.getTime(), environment)) {
      const connect = {
        method: 'POST', body: '{}', headers: { Authorization: `Bearer ${sessionToken}`,
          'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'User-Agent': CURSOR_USER_AGENT },
        redirect: 'error',
      };
      const dashboard = attachCacheScope(await request(`${service}/GetCurrentPeriodUsage`, connect, periodMeters), scope);
      if (dashboard.status === 'unauthorized') return dashboard;
      if (dashboard.status === 'ok') {
        const cached = loadCursorPlan(accountScope, dashboard.cacheScope, environment, now);
        const label = cached ? cached.label : await readPlanLabel(`${service}/GetPlanInfo`, connect);
        if (!cached) saveCursorPlan(accountScope, label, now.getTime(), environment);
        if (label) dashboard.planLabel = label;
        return dashboard;
      }
      if (dashboard.status === 'no_data') {
        rememberMeterlessCursorPeriod(accountScope, now.getTime(), environment);
      } else {
        const clientError = dashboard.httpStatus >= 400 && dashboard.httpStatus < 500 && dashboard.httpStatus !== 429;
        if (!clientError && dashboard.failureReason !== 'unrecognizedResponse') return dashboard;
      }
    }
    const signal = AbortSignal.timeout(timeoutMs);
    let summary;
    for (const cookie of cursorSessionCookies(sessionToken)) {
      summary = await request(summaryURL(environment), { headers: { Cookie: cookie, Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0', Origin: 'https://cursor.com', Referer: 'https://cursor.com/dashboard?tab=usage' },
        signal }, parseCursorQuota);
      if (summary.status !== 'unauthorized') break;
    }
    if (summary.planLabel) saveCursorPlan(accountScope, summary.planLabel, now.getTime(), environment, 'web');
    return attachCacheScope(summary, scope);
  }

  async function readPlanLabel(url, connect) {
    // Plan & Usage reads this field separately. A failed title lookup must
    // still deliver the current meters, even when this RPC rejects the login.
    try {
      const response = await fetchImpl(url, { ...connect, signal: AbortSignal.timeout(Math.min(2500, timeoutMs)) });
      if (response.status !== 200) { await response.body?.cancel(); return; }
      const name = (await readPayload(response))?.planInfo?.planName;
      return typeof name === 'string' ? name.trim() || null : null;
    } catch (error) {
      // Even an empty HTTP 200 completes the lookup. A broken connection while
      // receiving the body still gets the shorter transport retry.
      if (requestFailureReason(error) === 'unrecognizedResponse') return null;
    }
  }

  async function request(url, init, parseMeters) {
    try {
      const response = await fetchImpl(url, { ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
      if (!response.ok || (parseMeters === periodMeters && response.status !== 200)) {
        try { await response.body?.cancel(); } catch { /* the HTTP status is already known */ }
        if ([401, 403].includes(response.status)) {
          return result('unauthorized', { message: 'Open Cursor and sign in again, then retry' });
        }
        return result('retryable_error', { failureReason: 'httpStatus', httpStatus: response.status,
          message: `Cursor quota API returned HTTP ${response.status}` });
      }
      const payload = await readPayload(response);
      const meters = parseQuotaPayload(parseMeters, payload);
      return result(meters.length ? 'ok' : 'no_data', { meters, planLabel: parseMeters === parseCursorQuota ? plans[payload.membershipType] : undefined,
        ...(meters.length ? {} : { emptyReason: 'noWindow' }) });
    } catch (error) {
      return result('retryable_error', { failureReason: requestFailureReason(error),
        message: 'Cursor quota request failed; retry after checking the connection' });
    }
  }
}
