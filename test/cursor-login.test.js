// Cursor separate sign-in (cursor-login.js), approved 2026-11-25.
// Synthetic tokens and local stand-in servers only: nothing here reaches
// cursor.com or reads a real Cursor login. HOME and the config dir are
// temporary directories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURSOR_CLIENT_ID, CursorLoginError, REFRESH_HOLD_MS, cursorApiBase, cursorCredential, cursorLoginPath, cursorLoginRequest,
  freshCursorLogin, markStoredCursorLoginRejected, pollCursorLogin, readStoredCursorLogin,
  refreshCursorCredential, resetProvidedCursorLoginForTests, resolveCursorLogin, setProvidedCursorLogin,
  writeStoredCursorLogin,
} from '../src/cursor-login.js';
import * as cursor from '../src/parsers/cursor.js';
import { fetchCursorQuota, cursorQuotaNetworkURLs } from '../src/quotas/providers/cursor.js';
import { fetchQuotaProducts } from '../src/quotas/registry.js';
import { envProxyBlock } from '../src/env-proxy.js';
import { systemProxyConfigured } from '../src/system-proxy.js';
import { quotaResult } from '../src/quotas/schema.js';

const DAY = 24 * 60 * 60 * 1000;
const CLI = join(process.cwd(), 'bin', 'vibe-usage.js');

function jwt(claims) {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture-signature`;
}
const tokenFor = (user, expiresInMs = 60 * DAY, nonce = 'a') =>
  jwt({ sub: `auth0|${user}`, exp: Math.floor((Date.now() + expiresInMs) / 1000), nonce });

function tempDir(t, prefix = 'vbu-cursor-login-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// The process-wide environment the sync parser reads.
function isolateParser(t, extra = {}) {
  const dir = tempDir(t);
  const keys = ['VIBE_USAGE_CONFIG_DIR', 'CURSOR_STATE_DB_PATH', 'CURSOR_WEB_BASE_URL', 'VIBE_USAGE_CURSOR_API_BASE_URL', 'VIBE_USAGE_SYSTEM_PROXY'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.VIBE_USAGE_CONFIG_DIR = dir;
  process.env.CURSOR_STATE_DB_PATH = join(dir, 'no-cursor-here', 'state.vscdb');
  delete process.env.CURSOR_WEB_BASE_URL;
  delete process.env.VIBE_USAGE_CURSOR_API_BASE_URL;
  // No system proxy unless a test says so (system-proxy.js would ask the OS).
  process.env.VIBE_USAGE_SYSTEM_PROXY = '0';
  Object.assign(process.env, extra);
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    resetProvidedCursorLoginForTests();
  });
  return dir;
}

async function writeEncryptedCursorDb(dir) {
  const dbPath = join(dir, 'state.vscdb');
  const sql = `CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', 'cursor-safe-storage:v1:${Buffer.from('synthetic').toString('base64')}');`;
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* sqlite3 CLI below */ }
  if (DatabaseSync) { const db = new DatabaseSync(dbPath); try { db.exec(sql); } finally { db.close(); } }
  else execFileSync('sqlite3', [dbPath, sql]);
  return dbPath;
}

const CSV = (at = Date.now() - 3 * 60 * 60 * 1000) => [
  'Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens',
  `${new Date(at).toISOString()},fixture-model,10,20,30,40`,
].join('\n');
const RECENT_INFO = user => ({ account: cursor.cursorAccountLabel(`auth0|${user}`), syncedAt: new Date().toISOString() });
const cookieToken = init => /WorkosCursorSessionToken=[^;]*%3A%3A([^;\s]+)/.exec(init?.headers?.Cookie || '')?.[1];

// --- Sign-in request and poll ---------------------------------------------------

test('a sign-in opens Cursor\'s CLI login page with a PKCE challenge of the verifier', () => {
  const request = cursorLoginRequest({});
  const url = new URL(request.url);
  assert.equal(url.origin + url.pathname, 'https://cursor.com/loginDeepControl');
  assert.equal(url.searchParams.get('mode'), 'login');
  assert.equal(url.searchParams.get('redirectTarget'), 'cli');
  assert.equal(url.searchParams.get('uuid'), request.uuid);
  assert.equal(url.searchParams.get('challenge'), createHash('sha256').update(request.verifier).digest('base64url'));
  assert.ok(!request.url.includes(request.verifier), 'the verifier never goes to the browser');
  assert.notEqual(cursorLoginRequest({}).verifier, request.verifier);
});

test('the poll waits through 404 / 202, then returns both tokens', async () => {
  const answers = [new Response('', { status: 404 }), new Response('', { status: 202 }),
    json({ accessToken: 'access.token.value', refreshToken: 'refresh.token.value', authId: 'x' })];
  const requests = [];
  let clock = 0;
  const tokens = await pollCursorLogin({
    uuid: 'u-1', verifier: 'v-1', env: {},
    fetchImpl: async (url, init) => { requests.push([url, init]); return answers.shift(); },
    sleep: async ms => { clock += ms; }, now: () => clock,
  });
  assert.deepEqual(tokens, { accessToken: 'access.token.value', refreshToken: 'refresh.token.value' });
  assert.equal(requests.length, 3);
  assert.equal(requests[0][0], 'https://api2.cursor.sh/auth/poll?uuid=u-1&verifier=v-1');
  assert.match(requests[0][1].headers['User-Agent'], /^vibe-usage\//);
  assert.equal(clock, 4000, 'every 2 seconds');
});

test('the poll gives up after 5 minutes, on another status, or after repeated network failures', async () => {
  let clock = 0;
  let polls = 0;
  await assert.rejects(pollCursorLogin({ uuid: 'u', verifier: 'v', env: {},
    fetchImpl: async () => { polls++; return new Response('', { status: 404 }); },
    sleep: async ms => { clock += ms; }, now: () => clock }), err => err instanceof CursorLoginError && err.code === 'timeout');
  assert.equal(polls, 150);
  await assert.rejects(pollCursorLogin({ uuid: 'u', verifier: 'v', env: {},
    fetchImpl: async () => new Response('', { status: 500 }), sleep: async () => {} }), { code: 'failed' });
  await assert.rejects(pollCursorLogin({ uuid: 'u', verifier: 'v', env: {},
    fetchImpl: async () => json({ accessToken: 'only-one' }), sleep: async () => {} }), { code: 'failed' });
  let failures = 0;
  await assert.rejects(pollCursorLogin({ uuid: 'u', verifier: 'v', env: {},
    fetchImpl: async () => { failures++; throw new TypeError('fetch failed'); }, sleep: async () => {} }), { code: 'network' });
  assert.equal(failures, 5);
});

// --- Renewal --------------------------------------------------------------------

test('renewal posts Cursor\'s refresh grant and keeps the new token as the next refresh token', async () => {
  const old = cursorCredential({ accessToken: tokenFor('user_a', 3 * DAY, 'old'), refreshToken: 'refresh-old', email: 'a@example.com' });
  const next = tokenFor('user_a', 60 * DAY, 'new');
  let request;
  const outcome = await refreshCursorCredential(old, { env: {}, fetchImpl: async (url, init) => {
    request = { url, init };
    return json({ access_token: next });
  } });
  assert.equal(request.url, 'https://api2.cursor.sh/oauth/token');
  assert.equal(request.init.method, 'POST');
  assert.deepEqual(JSON.parse(request.init.body), { grant_type: 'refresh_token', client_id: CURSOR_CLIENT_ID, refresh_token: 'refresh-old' });
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.credential.accessToken, next);
  assert.equal(outcome.credential.refreshToken, next);
  assert.equal(outcome.credential.email, 'a@example.com');
  assert.equal(outcome.credential.userId, 'user_a');
});

test('renewal: shouldLogout, 400/401/403 or another account end the sign-in; anything else is temporary', async () => {
  const old = cursorCredential({ accessToken: tokenFor('user_a'), refreshToken: 'r' });
  const run = response => refreshCursorCredential(old, { env: {}, fetchImpl: async () => {
    if (response instanceof Error) throw response;
    return response;
  } });
  assert.equal((await run(json({ shouldLogout: true }))).status, 'expired');
  for (const status of [400, 401, 403]) assert.equal((await run(json({}, status))).status, 'expired');
  assert.equal((await run(json({ access_token: tokenFor('user_b') }))).status, 'expired');
  assert.deepEqual(await run(json({}, 503)), { status: 'retryable', reason: 'skipped (HTTP 503)' });
  assert.deepEqual(await run(new TypeError('fetch failed')), { status: 'retryable', reason: 'network: fetch failed' });
  assert.equal((await run(json({ access_token: 'not-a-jwt' }))).status, 'retryable');
});

// --- The stored sign-in -----------------------------------------------------------

test('the stored sign-in is 0600, and an ended one keeps no token', t => {
  const env = { VIBE_USAGE_CONFIG_DIR: join(tempDir(t), 'fresh-dir') };
  const credential = cursorCredential({ accessToken: tokenFor('user_a'), refreshToken: 'r', email: 'a@example.com' });
  writeStoredCursorLogin(credential, env);
  const path = cursorLoginPath(env);
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(env.VIBE_USAGE_CONFIG_DIR)).mode & 0o777, 0o700);
  }
  assert.equal(readStoredCursorLogin(env).credential.accessToken, credential.accessToken);
  markStoredCursorLoginRejected(env, { email: credential.email, userId: credential.userId });
  const text = readFileSync(path, 'utf8');
  assert.ok(!text.includes(credential.accessToken) && !text.includes('"r"'));
  assert.equal(readStoredCursorLogin(env).rejected, true);
  assert.deepEqual(resolveCursorLogin(env), { kind: 'stored', unusable: true });
  writeFileSync(path, '{not json');
  assert.deepEqual(resolveCursorLogin(env), { kind: 'stored', unusable: true });
});

test('a stored sign-in is renewed only within 7 days of expiry, and a temporary failure holds it for 6 hours', async t => {
  const env = { VIBE_USAGE_CONFIG_DIR: tempDir(t) };
  const now = new Date();
  const far = cursorCredential({ accessToken: tokenFor('user_a', 30 * DAY), refreshToken: 'r' });
  writeStoredCursorLogin(far, env);
  let calls = 0;
  const noRequest = async () => { calls++; throw new Error('not due'); };
  assert.equal((await freshCursorLogin(resolveCursorLogin(env), { env, fetchImpl: noRequest, now })).credential.accessToken, far.accessToken);
  assert.equal(calls, 0);

  const near = cursorCredential({ accessToken: tokenFor('user_a', 2 * DAY, 'near'), refreshToken: 'r' });
  writeStoredCursorLogin(near, env);
  const down = await freshCursorLogin(resolveCursorLogin(env), { env, now, fetchImpl: async () => json({}, 503) });
  assert.equal(down.credential.accessToken, near.accessToken, 'keeps reading with the current one');
  const held = readStoredCursorLogin(env).refreshHeldUntil;
  assert.equal(Date.parse(held) - now.getTime(), REFRESH_HOLD_MS);
  calls = 0;
  await freshCursorLogin(resolveCursorLogin(env), { env, fetchImpl: noRequest, now });
  assert.equal(calls, 0, 'held: no request');

  const later = new Date(now.getTime() + REFRESH_HOLD_MS + 1000);
  const renewed = tokenFor('user_a', 60 * DAY, 'renewed');
  const ok = await freshCursorLogin(resolveCursorLogin(env), { env, now: later, fetchImpl: async () => json({ access_token: renewed }) });
  assert.equal(ok.refreshed, true);
  assert.equal(readStoredCursorLogin(env).credential.accessToken, renewed);
  assert.equal(readStoredCursorLogin(env).refreshHeldUntil, null);

  writeStoredCursorLogin(near, env);
  assert.deepEqual(await freshCursorLogin(resolveCursorLogin(env), { env, now, fetchImpl: async () => json({ shouldLogout: true }) }), { expired: true });
  assert.equal(readStoredCursorLogin(env).rejected, true);
});

test('an app\'s sign-in is never renewed by the CLI and wins over the stored one', async t => {
  const env = { VIBE_USAGE_CONFIG_DIR: tempDir(t) };
  t.after(() => resetProvidedCursorLoginForTests());
  writeStoredCursorLogin(cursorCredential({ accessToken: tokenFor('user_stored'), refreshToken: 'r' }), env);
  const near = cursorCredential({ accessToken: tokenFor('user_app', 2 * DAY), refreshToken: 'r', email: 'app@example.com' });
  assert.equal(setProvidedCursorLogin(JSON.stringify(near)), true);
  const login = resolveCursorLogin(env);
  assert.equal(login.kind, 'provided');
  const fetchImpl = async () => { throw new Error('the app renews its own'); };
  assert.equal((await freshCursorLogin(login, { env, fetchImpl })).credential.userId, 'user_app');
  assert.deepEqual(await freshCursorLogin(login, { env, fetchImpl, force: true }), { expired: true });
  const lapsed = cursorCredential({ accessToken: tokenFor('user_app', -DAY), refreshToken: 'r' });
  setProvidedCursorLogin(JSON.stringify(lapsed));
  assert.deepEqual(await freshCursorLogin(resolveCursorLogin(env), { env, fetchImpl }), { expired: true });
  assert.equal(setProvidedCursorLogin('not json'), false);
  assert.deepEqual(resolveCursorLogin(env), { kind: 'provided', unusable: true });
});

// --- Sync parser --------------------------------------------------------------------

test('sync reads Cursor with the Vibe Usage sign-in when the local login is encrypted', async t => {
  const dir = isolateParser(t);
  process.env.CURSOR_STATE_DB_PATH = await writeEncryptedCursorDb(dir);
  const credential = cursorCredential({ accessToken: tokenFor('user_a'), refreshToken: 'r' });
  writeStoredCursorLogin(credential, process.env);
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push([String(url), cookieToken(init)]);
    return new Response(CSV());
  });
  const result = await cursor.parse({ previousInfo: RECENT_INFO('user_a') });
  assert.equal(result.buckets.length, 1);
  assert.equal(result.info.account, cursor.cursorAccountLabel('auth0|user_a'));
  assert.ok(seen.length >= 1);
  for (const [url, token] of seen) {
    assert.match(url, /^https:\/\/cursor\.com\/api\/dashboard\//);
    assert.equal(token, credential.accessToken);
  }
  assert.ok(!JSON.stringify(result).includes(credential.accessToken));
});

test('sync: an ended sign-in sends nothing; a rejected one is renewed once, then ended', async t => {
  isolateParser(t);
  markStoredCursorLoginRejected(process.env, { email: 'a@example.com' });
  const none = t.mock.method(globalThis, 'fetch', async () => { throw new Error('no request'); });
  const ended = await cursor.parse({ previousInfo: RECENT_INFO('user_a') });
  assert.equal(none.mock.callCount(), 0);
  assert.deepEqual(Object.keys(ended).sort(), ['buckets', 'sessions', 'skipped', 'warnings']);
  assert.match(ended.warnings[0], /Cursor 登录已失效/);
  none.mock.restore();

  const first = cursorCredential({ accessToken: tokenFor('user_a', 30 * DAY, 'first'), refreshToken: 'r' });
  const second = tokenFor('user_a', 60 * DAY, 'second');
  writeStoredCursorLogin(first, process.env);
  let refreshes = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/oauth/token')) { refreshes++; return json({ access_token: second }); }
    return cookieToken(init) === second ? new Response(CSV()) : new Response('', { status: 401 });
  });
  const renewed = await cursor.parse({ previousInfo: RECENT_INFO('user_a') });
  assert.equal(refreshes, 1);
  assert.equal(renewed.buckets.length, 1);
  assert.equal(readStoredCursorLogin(process.env).credential.accessToken, second);

  t.mock.method(globalThis, 'fetch', async url => (String(url).endsWith('/oauth/token')
    ? json({ access_token: tokenFor('user_a', 60 * DAY, 'third') }) : new Response('', { status: 401 })));
  const rejected = await cursor.parse({ previousInfo: RECENT_INFO('user_a') });
  assert.match(rejected.warnings[0], /Cursor 登录已失效/);
  assert.equal(rejected.info, undefined);
  assert.equal(readStoredCursorLogin(process.env).rejected, true);
});

test('sync: an app\'s sign-in that Cursor rejects is reported, not renewed', async t => {
  isolateParser(t);
  setProvidedCursorLogin(JSON.stringify(cursorCredential({ accessToken: tokenFor('user_app'), refreshToken: 'r' })));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => { calls.push(String(url)); return new Response('', { status: 401 }); });
  const result = await cursor.parse({ previousInfo: RECENT_INFO('user_app') });
  assert.match(result.warnings[0], /Cursor 登录已失效/);
  assert.ok(calls.every(url => !url.endsWith('/oauth/token')));
  assert.ok(!existsSync(cursorLoginPath(process.env)), 'nothing written for an app sign-in');
});

test('sync: a proxy the CLI cannot follow stops the sign-in path before renewal', async t => {
  isolateParser(t);
  writeStoredCursorLogin(cursorCredential({ accessToken: tokenFor('user_a', DAY), refreshToken: 'r' }), process.env);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('no request'); });
  const result = await cursor.parse({ previousInfo: RECENT_INFO('user_a'), envProxyBlock: envProxyBlock('socks') });
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.match(result.warnings[0], /Cursor 本次未同步/);
});

// --- Quota --------------------------------------------------------------------------

const periodPath = '/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const periodURL = 'https://api2.cursor.sh' + periodPath;
const planPath = '/aiserver.v1.DashboardService/GetPlanInfo';
const planURL = 'https://api2.cursor.sh' + planPath;
const summaryURL = 'https://cursor.com/api/usage-summary';
const period = {
  billingCycleStart: String(Date.parse('2026-11-05T00:00:00Z')),
  billingCycleEnd: Date.parse('2026-12-05T00:00:00Z'),
  planUsage: { totalPercentUsed: 6, autoPercentUsed: 0, apiPercentUsed: .36 },
  spendLimitUsage: { individualUsed: 125, individualLimit: 500 },
};

test('quota: one dashboard request replaces a zero summary in the same account cache', async t => {
  const home = tempDir(t);
  const environment = { VIBE_USAGE_CONFIG_DIR: home, VIBE_USAGE_QUOTA_CACHE_DIR: home };
  const token = tokenFor('user_dashboard');
  setProvidedCursorLogin(JSON.stringify(cursorCredential({ accessToken: token })));
  t.after(resetProvidedCursorLoginForTests);
  const now = new Date('2026-11-28');
  const calls = [];
  let primary;
  let webStatus = 200;
  const read = async () => (await fetchQuotaProducts(['cursor'], { environment, now, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url === periodURL) {
      if (primary instanceof Error) throw primary;
      return primary;
    }
    return json({ membershipType: 'free_trial', individualUsage: { plan: { totalPercentUsed: 0 } } }, webStatus);
  } })).products[0];

  for (const unavailable of [json({}, 503), new TypeError('connection reset'), json({ planUsage: {} }), new Response('<html>')]) {
    primary = unavailable;
    calls.length = 0;
    const legacy = await read();
    assert.deepEqual(calls.map(call => call.url), [periodURL, summaryURL]);
    assert.equal(cookieToken(calls[1].init), token);
    assert.equal(legacy.planLabel, 'Pro Trial');
    assert.equal(legacy.meters[0].utilization, 0);
  }
  calls.length = 0;
  primary = json(period);
  const current = await read();
  assert.deepEqual(calls.map(call => call.url), [periodURL]);
  assert.equal(current.planLabel, 'Pro Trial', 'reuse the plan just read from the web fallback');
  const { method, headers, body, redirect } = calls[0].init;
  assert.equal(method, 'POST');
  assert.deepEqual(headers, { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' });
  assert.equal(body, '{}');
  assert.equal(redirect, 'error');
  const cycle = { resetsAt: '2026-12-05T00:00:00.000Z', windowSeconds: 30 * 86400 };
  assert.deepEqual(current.meters, [
    { id: 'plan', label: 'Month', utilization: 6, ...cycle, breakdown: [
      { id: 'auto', label: 'Cursor models', utilization: 0 },
      { id: 'api', label: 'Third-party models', utilization: .36 },
    ] },
    { id: 'on-demand', label: 'On-demand', utilization: 25, ...cycle },
  ]);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'quota-cache.json'))).products.cursor.meters, current.meters);
  for (const code of [401, 403]) {
    primary = json({}, code);
    calls.length = 0;
    const rejected = await read();
    assert.deepEqual(calls.map(call => call.url), [periodURL]);
    assert.equal(rejected.signIn, 'expired');
    assert.equal(rejected.failureReason, 'credentialsRejected');
  }
  primary = json({}, 503);
  webStatus = 401;
  calls.length = 0;
  assert.equal((await read()).signIn, 'expired');
  assert.deepEqual(calls.map(call => call.url), [periodURL, summaryURL, summaryURL]);
  assert.equal(calls[1].init.signal, calls[2].init.signal);
  for (const [index, value] of [[1, `auth0|user_dashboard::${token}`], [2, token]]) {
    assert.deepEqual(calls[index].init.headers, {
      Cookie: `WorkosCursorSessionToken=${encodeURIComponent(value)}`, Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0', Origin: 'https://cursor.com', Referer: 'https://cursor.com/dashboard?tab=usage',
    });
  }
});

test('quota: a rejected web cookie can still read the summary with the bare token', async t => {
  const home = tempDir(t);
  const environment = { VIBE_USAGE_CONFIG_DIR: home, VIBE_USAGE_QUOTA_CACHE_DIR: home };
  const token = tokenFor('user_web');
  setProvidedCursorLogin(JSON.stringify(cursorCredential({ accessToken: token })));
  t.after(resetProvidedCursorLoginForTests);
  const calls = [];
  const answer = await fetchCursorQuota({ environment, fetchImpl: async (url, init) => {
    calls.push(url);
    if (url === periodURL) return json({}, 503);
    if (init.headers.Cookie !== `WorkosCursorSessionToken=${token}`) return json({}, 403);
    return json({ membershipType: 'ultra', individualUsage: { plan: { totalPercentUsed: 7 } } });
  } });
  assert.deepEqual(calls, [periodURL, summaryURL, summaryURL]);
  assert.equal(answer.planLabel, 'Ultra');
  assert.equal(answer.meters[0].utilization, 7);
});

test('quota: plan names follow the account, expire independently of quota refreshes, and fail independently', async t => {
  const home = tempDir(t);
  const environment = { VIBE_USAGE_CONFIG_DIR: home, VIBE_USAGE_QUOTA_CACHE_DIR: home };
  t.after(resetProvidedCursorLoginForTests);
  const start = Date.parse('2026-11-28T00:00:00Z');
  const calls = [];
  let plan = json({ planInfo: { planName: 'Pro' }, nextUpgrade: { name: 'Ultra' } });
  const read = async (user, offset, nonce = 'a') => {
    const token = tokenFor(user, 60 * DAY, nonce);
    setProvidedCursorLogin(JSON.stringify(cursorCredential({ accessToken: token })));
    calls.length = 0;
    const { products: [answer] } = await fetchQuotaProducts(['cursor'], { environment, now: new Date(start + offset),
      fetchImpl: async (url, init) => {
        calls.push(url);
        if (url === periodURL) return json(period);
        if (url === planURL) {
          assert.equal(init.method, 'POST');
          assert.equal(init.body, '{}');
          assert.equal(init.redirect, 'error');
          assert.deepEqual(init.headers, { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' });
          return plan;
        }
        throw new Error('unexpected URL');
      } });
    assert.equal(answer.status, 'ok');
    assert.equal(answer.source, 'live');
    assert.equal(answer.meters[0].utilization, 6);
    return answer.planLabel;
  };
  assert.equal(await read('account_a', 0), 'Pro');
  assert.deepEqual(calls, [periodURL, planURL]);
  plan = json({ planInfo: { planName: 'Ultra' } });
  assert.equal(await read('account_b', 1000), 'Ultra');
  assert.deepEqual(calls, [periodURL, planURL]);
  assert.equal(await read('account_a', DAY, 'renewed'), 'Pro');
  assert.deepEqual(calls, [periodURL]);
  plan = json({}, 401);
  assert.equal(await read('account_a', DAY + 1), undefined);
  assert.deepEqual(calls, [periodURL, planURL]);
  assert.equal(await read('account_a', DAY + 60000), undefined);
  assert.deepEqual(calls, [periodURL]);
  plan = json({ planInfo: { planName: 'Pro+' } });
  assert.equal(await read('account_a', DAY + 3600000), 'Pro+');
  assert.deepEqual(calls, [periodURL, planURL]);
  const cache = readFileSync(join(home, 'quota-cache.json'), 'utf8');
  assert.doesNotMatch(cache, /account_a|account_b|fixture-signature|nextUpgrade/);
});

test('quota: upgrading reuses a web plan label only until 24 hours after its original read', async t => {
  const home = tempDir(t);
  const environment = { VIBE_USAGE_CONFIG_DIR: home, VIBE_USAGE_QUOTA_CACHE_DIR: home };
  setProvidedCursorLogin(JSON.stringify(cursorCredential({ accessToken: tokenFor('user_legacy_cache') })));
  t.after(resetProvidedCursorLoginForTests);
  const fetchedAt = '2026-11-28T00:00:00Z';
  const scope = createHash('sha256').update('cursor\0user:user_legacy_cache').digest('hex');
  writeFileSync(join(home, 'quota-cache.json'), JSON.stringify({ version: 1, products: { cursor: {
    id: 'cursor', status: 'ok', meters: [], scope, fetchedAt, planLabel: 'Pro',
  } } }));
  const calls = [];
  const read = async offset => (await fetchQuotaProducts(['cursor'], { environment, now: new Date(Date.parse(fetchedAt) + offset),
    fetchImpl: async url => {
      calls.push(url);
      return json(url === planURL ? { planInfo: { planName: 'Ultra' } } : period);
    } })).products[0];
  assert.equal((await read(DAY - 1)).planLabel, 'Pro');
  assert.equal((await read(DAY + 1)).planLabel, 'Ultra');
  assert.deepEqual(calls, [periodURL, periodURL, planURL]);
});

test('quota: spend limits and pooled usage keep the desktop meter identities', async t => {
  const home = tempDir(t);
  const environment = { VIBE_USAGE_CONFIG_DIR: home, VIBE_USAGE_QUOTA_CACHE_DIR: home };
  setProvidedCursorLogin(JSON.stringify(cursorCredential({ accessToken: tokenFor('user_limits') })));
  t.after(resetProvidedCursorLoginForTests);
  for (const [payload, expected] of [
    [{ planUsage: { totalPercentUsed: 0, includedSpend: 25, limit: 100 } }, [['plan', 0]]],
    [{ planUsage: { includedSpend: 25, limit: 100 } }, [['plan', 25]]],
    [{ spendLimitUsage: { overallUsed: 1, overallLimit: 4, pooledUsed: 3, pooledLimit: 4 } }, [['personal', 25]]],
    [{ spendLimitUsage: { pooledUsed: 3, pooledLimit: 4, individualLimit: 100 } }, [['team', 75], ['on-demand', 0]]],
  ]) {
    const result = await fetchCursorQuota({ environment, fetchImpl: async url => {
      assert.ok(url === periodURL || url === planURL);
      return json(url === planURL ? { planInfo: { planName: 'Pro' } } : payload);
    } });
    assert.deepEqual(result.meters.map(m => [m.id, m.utilization]), expected);
  }
});

test('quota: apps predating the dashboard PAC host keep the web route on a system proxy', async t => {
  const home = tempDir(t);
  setProvidedCursorLogin(JSON.stringify(cursorCredential({ accessToken: tokenFor('user_legacy') })));
  t.after(resetProvidedCursorLoginForTests);
  for (const [surface, before, after, membershipType, label] of [
    ['mac-app', '0.8.0', '0.8.1', 'pro_student', 'Pro Student'],
    ['windows-app', '0.7.9', '0.7.10', 'express', 'Express'],
  ]) {
    const environment = { VIBE_USAGE_CONFIG_DIR: home, VIBE_USAGE_QUOTA_CACHE_DIR: home, VIBE_USAGE_SYSTEM_PROXY: '1',
      VIBE_USAGE_SURFACE: surface, VIBE_USAGE_SURFACE_VERSION: before };
    assert.deepEqual(cursorQuotaNetworkURLs({ environment }), [summaryURL]);
    const calls = [];
    const result = await fetchCursorQuota({ environment, fetchImpl: async url => {
      calls.push(url);
      return json({ membershipType, individualUsage: { plan: { totalPercentUsed: 6 } } });
    } });
    assert.deepEqual(calls, [summaryURL]);
    assert.equal(result.planLabel, label);
    environment.VIBE_USAGE_SURFACE_VERSION = after;
    assert.deepEqual(cursorQuotaNetworkURLs({ environment }), [periodURL, planURL, summaryURL]);
  }
});

test('quota reads with the Vibe Usage sign-in, scoped to the account, and says when it ended', async t => {
  const dir = tempDir(t);
  const environment = { VIBE_USAGE_CONFIG_DIR: dir, VIBE_USAGE_QUOTA_CACHE_DIR: dir, CURSOR_STATE_DB_PATH: join(dir, 'none.vscdb'), VIBE_USAGE_SYSTEM_PROXY: '0' };
  const payload = { planUsage: { totalPercentUsed: 12 } };
  const first = cursorCredential({ accessToken: tokenFor('user_a', 30 * DAY, 'first'), refreshToken: 'r' });
  writeStoredCursorLogin(first, environment);
  assert.deepEqual(cursorQuotaNetworkURLs({ environment }), [periodURL, planURL, summaryURL, 'https://api2.cursor.sh/oauth/token']);
  const used = [];
  const ok = await fetchCursorQuota({ environment, fetchImpl: async (url, init) => {
    used.push([url, init.headers.Authorization]);
    return json(url === planURL ? { planInfo: { planName: 'Ultra' } } : payload);
  } });
  assert.equal(ok.status, 'ok');
  assert.deepEqual(used, [periodURL, planURL].map(url => [url, `Bearer ${first.accessToken}`]));

  const second = tokenFor('user_a', 60 * DAY, 'second');
  const attempts = [];
  const renewed = await fetchCursorQuota({ environment, fetchImpl: async (url, init) => {
    attempts.push(url);
    if (String(url).endsWith('/oauth/token')) return json({ access_token: second });
    return init.headers.Authorization === `Bearer ${second}` ? json(payload) : json({}, 401);
  } });
  assert.equal(renewed.status, 'ok');
  assert.deepEqual(attempts, [periodURL, 'https://api2.cursor.sh/oauth/token', periodURL]);
  assert.equal(renewed.cacheScope, ok.cacheScope, 'a renewed token is the same account');

  const ended = await fetchCursorQuota({ environment, fetchImpl: async url => (String(url).endsWith('/oauth/token')
    ? json({ shouldLogout: true }) : json({}, 401)) });
  assert.equal(ended.status, 'unsupported');
  assert.equal(ended.signIn, 'expired');
  assert.equal(ended.failureReason, 'credentialsRejected');
  assert.equal(ended.cacheScope, undefined);
  assert.equal(readStoredCursorLogin(environment).rejected, true);
  const again = await fetchCursorQuota({ environment, fetchImpl: async () => assert.fail('no request once ended') });
  assert.equal(again.signIn, 'expired');
  assert.deepEqual(cursorQuotaNetworkURLs({ environment }), [periodURL, planURL, summaryURL]);
});

test('`signIn` is a closed vocabulary that rides only on `unsupported`', () => {
  assert.equal(quotaResult({ id: 'cursor', status: 'unsupported', signIn: 'required' }).signIn, 'required');
  assert.equal(quotaResult({ id: 'cursor', status: 'unsupported', signIn: 'expired' }).signIn, 'expired');
  assert.equal('signIn' in quotaResult({ id: 'cursor', status: 'ok' }), false);
  assert.throws(() => quotaResult({ id: 'cursor', status: 'ok', signIn: 'required' }));
  assert.throws(() => quotaResult({ id: 'cursor', status: 'unsupported', signIn: 'maybe' }));
});

// --- Commands (child processes against a local stand-in for Cursor) ------------------

async function standIn(t, { pollsBeforeConfirm = 1, user = 'user_cli' } = {}) {
  const state = { polls: 0, cookies: [], refreshBodies: [], accessToken: tokenFor(user, 60 * DAY, 'login') };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
      const url = new URL(req.url, 'http://local');
      if (url.pathname === '/auth/poll') {
        state.polls++;
        if (!url.searchParams.get('uuid') || !url.searchParams.get('verifier')) return send(400, {});
        return state.polls <= pollsBeforeConfirm ? send(404) : send(200, { accessToken: state.accessToken, refreshToken: 'refresh-from-poll' });
      }
      if (url.pathname === '/api/auth/me') { state.cookies.push(req.headers.cookie); return send(200, { email: 'fixture@example.com', name: 'Fixture' }); }
      if (url.pathname === '/oauth/token') { state.refreshBodies.push(JSON.parse(body)); return send(200, { access_token: tokenFor(user, 60 * DAY, 'renewed') }); }
      if (url.pathname === periodPath) { state.dashboardAuth = req.headers.authorization; return send(200, { planUsage: { totalPercentUsed: 7 } }); }
      if (url.pathname === planPath) return send(200, { planInfo: { planName: 'Pro+' } });
      return send(404, {});
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const home = tempDir(t, 'vbu-cursor-login-cli-');
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(https?|all|no)_proxy$/i.test(key))),
    HOME: home, USERPROFILE: home, VIBE_USAGE_CONFIG_DIR: home, VIBE_USAGE_STATE_DIR: home,
    VIBE_USAGE_QUOTA_CACHE_DIR: home, VIBE_USAGE_DEV: '0', CURSOR_STATE_DB_PATH: join(home, 'none.vscdb'),
    CURSOR_WEB_BASE_URL: base, VIBE_USAGE_CURSOR_API_BASE_URL: base, VIBE_USAGE_SYSTEM_PROXY: '0',
  };
  const run = (args, input, extra = {}) => new Promise(resolve => {
    const child = execFile(process.execPath, [CLI, ...args], { env: { ...env, ...extra }, timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr });
    });
    child.stdin.end(input ?? '');
  });
  return { state, base, home, env, run };
}

test('`login cursor --json` prints the sign-in for the app and writes nothing', async t => {
  const { state, base, home, run } = await standIn(t);
  const { code, stdout, stderr } = await run(['login', 'cursor', '--json']);
  assert.equal(code, 0, stderr);
  const lines = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines[0].event, 'open');
  assert.ok(lines[0].url.startsWith(`${base}/loginDeepControl?`));
  assert.equal(new URL(lines[0].url).searchParams.get('redirectTarget'), 'cli');
  assert.equal(lines[1].event, 'credential');
  assert.equal(lines[1].credential.accessToken, state.accessToken);
  assert.equal(lines[1].credential.refreshToken, 'refresh-from-poll');
  assert.equal(lines[1].credential.email, 'fixture@example.com');
  assert.equal(lines[1].credential.userId, 'user_cli');
  assert.equal(state.polls, 2);
  assert.match(state.cookies[0], /^WorkosCursorSessionToken=user_cli%3A%3A/);
  assert.equal(existsSync(join(home, 'cursor-login.json')), false);
});

test('`login cursor` saves the sign-in; `status` names it; `logout cursor` removes it', async t => {
  const { state, home, run } = await standIn(t);
  const login = await run(['login', 'cursor', '--no-browser']);
  assert.equal(login.code, 0, login.stderr);
  assert.match(login.stdout, /以 Cursor 命令行的身份登录，只用来读用量/);
  assert.match(login.stdout, /已登录 Cursor：fixture@example\.com，有效期至 \d{4}-\d{2}-\d{2}/);
  assert.ok(!login.stdout.includes(state.accessToken));
  const path = join(home, 'cursor-login.json');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).accessToken, state.accessToken);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);

  const status = await run(['status']);
  assert.ok(!status.stdout.includes(state.accessToken));

  const logout = await run(['logout', 'cursor']);
  assert.equal(logout.code, 0);
  assert.match(logout.stdout, /已退出 Cursor 登录/);
  assert.match(logout.stdout, /Sessions 里撤销：它显示为「Desktop App」/);
  assert.equal(existsSync(path), false);
});

test('the app hands its sign-in over on stdin: quota reads with it, refresh prints the renewed one', async t => {
  const { state, run } = await standIn(t);
  const credential = cursorCredential({ accessToken: tokenFor('user_cli', 60 * DAY, 'app'), refreshToken: 'app-refresh', email: 'fixture@example.com' });
  const quota = await run(['quota', 'fetch', '--product', 'cursor', '--json', '--cursor-login-stdin'], JSON.stringify(credential));
  assert.equal(quota.code, 0, quota.stderr);
  const [product] = JSON.parse(quota.stdout).products;
  assert.equal(product.status, 'ok');
  assert.equal(product.meters[0].utilization, 7);
  assert.equal(product.planLabel, 'Pro+');
  assert.equal(state.dashboardAuth, `Bearer ${credential.accessToken}`);
  assert.ok(!quota.stdout.includes(credential.accessToken));

  const refresh = await run(['login', 'cursor', '--refresh', '--json', '--cursor-login-stdin'], JSON.stringify(credential));
  assert.equal(refresh.code, 0, refresh.stderr);
  const answer = JSON.parse(refresh.stdout.trim());
  assert.equal(answer.event, 'credential');
  assert.notEqual(answer.credential.accessToken, credential.accessToken);
  assert.deepEqual(state.refreshBodies, [{ grant_type: 'refresh_token', client_id: CURSOR_CLIENT_ID, refresh_token: 'app-refresh' }]);

  const unusable = await run(['quota', 'fetch', '--product', 'cursor', '--json', '--cursor-login-stdin'], 'garbage');
  assert.equal(JSON.parse(unusable.stdout).products[0].signIn, 'expired');
  assert.match(unusable.stderr, /无法识别/);
});

test('a terminal sign-in is refused on a system proxy the CLI was not told about; an app\'s is not', async t => {
  const { state, home, run } = await standIn(t);
  const terminal = await run(['login', 'cursor', '--no-browser'], '', { VIBE_USAGE_SYSTEM_PROXY: '1' });
  assert.equal(terminal.code, 1);
  assert.match(terminal.stderr, /检测到系统代理，但这个进程没有收到代理环境变量/);
  assert.equal(state.polls, 0, 'nothing sent');
  assert.equal(existsSync(join(home, 'cursor-login.json')), false);
  // --json alone is not an app: still refused.
  const script = await run(['login', 'cursor', '--json'], '', { VIBE_USAGE_SYSTEM_PROXY: '1' });
  assert.equal(script.code, 1);
  assert.equal(JSON.parse(script.stdout.trim()).code, 'proxy');
  assert.equal(state.polls, 0);
  // The apps turn the system proxy into variables before they start the CLI.
  const app = await run(['login', 'cursor', '--json'], '', { VIBE_USAGE_SYSTEM_PROXY: '1', VIBE_USAGE_SURFACE: 'mac-app' });
  assert.equal(app.code, 0, app.stderr);
  assert.ok(state.polls > 0);
});

// --- Cross-review round 1 (GPT-6.2 Astra, 2026-11-25) ---------------------------------

test('system proxy detection reads scutil / the registry, and an unknown answer is "not configured"', () => {
  const ask = (platform, out) => systemProxyConfigured({ platform, env: {}, run: () => out });
  assert.equal(ask('darwin', '<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n}'), true);
  assert.equal(ask('darwin', '<dictionary> {\n  ProxyAutoConfigEnable : 1\n}'), true);
  assert.equal(ask('darwin', '<dictionary> {\n  HTTPEnable : 0\n  HTTPSEnable : 0\n  ExceptionsList : <array> {}\n}'), false);
  assert.equal(ask('win32', '    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:7890'), true);
  assert.equal(ask('win32', '    ProxyEnable    REG_DWORD    0x0\r\n    AutoConfigURL    REG_SZ    http://127.0.0.1/pac'), true);
  assert.equal(ask('win32', '    ProxyEnable    REG_DWORD    0x0'), false);
  // A machine-wide policy: the HKLM settings count, not the user's.
  const windows = (policy, machine, user) => systemProxyConfigured({ platform: 'win32', env: {}, run: (file, [, key]) => {
    if (key.includes('Policies')) { if (policy === null) throw new Error('no key'); return policy; }
    return key.startsWith('HKLM') ? machine : user;
  } });
  assert.equal(windows('    ProxySettingsPerUser    REG_DWORD    0x0', '    ProxyEnable    REG_DWORD    0x1', '    ProxyEnable    REG_DWORD    0x0'), true);
  assert.equal(windows(null, '    ProxyEnable    REG_DWORD    0x1', '    ProxyEnable    REG_DWORD    0x0'), false);
  assert.equal(windows('    ProxySettingsPerUser    REG_DWORD    0x1', '    ProxyEnable    REG_DWORD    0x1', '    ProxyEnable    REG_DWORD    0x0'), false);
  assert.equal(ask('linux', 'anything'), false);
  // When unsure, do not send.
  assert.equal(systemProxyConfigured({ platform: 'darwin', env: {}, run: () => { throw new Error('no scutil'); } }), true);
  assert.equal(systemProxyConfigured({ platform: 'linux', env: {}, run: () => { throw new Error('none'); } }), false);
  assert.equal(systemProxyConfigured({ platform: 'darwin', env: { VIBE_USAGE_SYSTEM_PROXY: '1' }, run: () => '' }), true);
});

test('the api2 stand-in hook only takes a loopback address', () => {
  assert.equal(cursorApiBase({ VIBE_USAGE_CURSOR_API_BASE_URL: 'http://127.0.0.1:4321/' }), 'http://127.0.0.1:4321');
  assert.equal(cursorApiBase({ VIBE_USAGE_CURSOR_API_BASE_URL: 'https://example.com' }), 'https://api2.cursor.sh');
  assert.equal(cursorApiBase({ VIBE_USAGE_CURSOR_API_BASE_URL: 'not a url' }), 'https://api2.cursor.sh');
});

test('sync and quota: a stored sign-in sends nothing on a system proxy the process was not told about', async t => {
  isolateParser(t, { VIBE_USAGE_SYSTEM_PROXY: '1' });
  writeStoredCursorLogin(cursorCredential({ accessToken: tokenFor('user_a', DAY), refreshToken: 'r' }), process.env);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('no request'); });
  const result = await cursor.parse({ previousInfo: RECENT_INFO('user_a') });
  assert.match(result.warnings[0], /检测到系统代理/);
  const quota = await fetchCursorQuota({ environment: process.env, fetchImpl: async () => assert.fail('no request') });
  assert.equal(quota.status, 'unsupported');
  assert.match(quota.message, /system proxy/);
  assert.equal(quota.pauseReason, 'proxyUnsupported');
  assert.equal(fetchMock.mock.callCount(), 0);
  // An app's sign-in: the app has turned the system proxy into variables.
  setProvidedCursorLogin(JSON.stringify(cursorCredential({ accessToken: tokenFor('user_a'), refreshToken: 'r' })));
  fetchMock.mock.restore();
  t.mock.method(globalThis, 'fetch', async () => new Response(CSV()));
  assert.equal((await cursor.parse({ previousInfo: RECENT_INFO('user_a') })).buckets.length, 1);
});

test('sync: while a desktop app syncs Cursor with its own sign-in, a run with another account skips', async t => {
  isolateParser(t);
  writeStoredCursorLogin(cursorCredential({ accessToken: tokenFor('user_cli'), refreshToken: 'r' }), process.env);
  const appInfo = (ageMs = 60_000) => ({ account: cursor.cursorAccountLabel('auth0|user_app'), syncedAt: new Date().toISOString(),
    app: { account: cursor.cursorAccountLabel('auth0|user_app'), syncedAt: new Date(Date.now() - ageMs).toISOString() } });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(CSV()));
  const skipped = await cursor.parse({ previousInfo: appInfo() });
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.deepEqual(Object.keys(skipped).sort(), ['buckets', 'sessions', 'skipped', 'warnings']);
  assert.match(skipped.warnings[0], /正由桌面 App 用另一个账号同步/);
  // The app has not synced for over 7 days: this run takes over.
  const resumed = await cursor.parse({ previousInfo: appInfo(8 * DAY) });
  assert.ok(fetchMock.mock.callCount() > 0);
  assert.equal(resumed.info.account, cursor.cursorAccountLabel('auth0|user_cli'));
  assert.equal(resumed.info.app, undefined, 'a stale record is dropped');
  // The same account: nothing to protect, and the app's record is carried
  // forward, so a later switch to another account is still caught.
  writeStoredCursorLogin(cursorCredential({ accessToken: tokenFor('user_app'), refreshToken: 'r' }), process.env);
  const recorded = appInfo();
  const same = await cursor.parse({ previousInfo: recorded });
  assert.equal(same.buckets.length, 1);
  assert.deepEqual(same.info.app, recorded.app);
  writeStoredCursorLogin(cursorCredential({ accessToken: tokenFor('user_other'), refreshToken: 'r' }), process.env);
  assert.match((await cursor.parse({ previousInfo: same.info })).warnings[0], /正由桌面 App 用另一个账号同步/);
  // The app itself always reads, and records that it did.
  setProvidedCursorLogin(JSON.stringify(cursorCredential({ accessToken: tokenFor('user_app2'), refreshToken: 'r' })));
  const app = await cursor.parse({ previousInfo: appInfo() });
  assert.equal(app.info.app.account, cursor.cursorAccountLabel('auth0|user_app2'));
  assert.equal(app.info.account, cursor.cursorAccountLabel('auth0|user_app2'));
});

test('a renewal in flight never writes over a logout or a newer sign-in', async t => {
  const env = { VIBE_USAGE_CONFIG_DIR: tempDir(t) };
  const near = cursorCredential({ accessToken: tokenFor('user_a', 2 * DAY, 'near'), refreshToken: 'r' });
  writeStoredCursorLogin(near, env);
  // A logout lands while Cursor is answering the renewal.
  const renewed = await freshCursorLogin(resolveCursorLogin(env), { env, fetchImpl: async () => {
    rmSync(cursorLoginPath(env));
    return json({ access_token: tokenFor('user_a', 60 * DAY, 'renewed') });
  } });
  assert.deepEqual(renewed, { expired: true }, 'the renewed token is dropped, nothing more is read');
  assert.equal(existsSync(cursorLoginPath(env)), false, 'the logout stands');
  // A newer sign-in (account B) lands while A's renewal is being refused.
  writeStoredCursorLogin(near, env);
  const b = cursorCredential({ accessToken: tokenFor('user_b'), refreshToken: 'rb' });
  await freshCursorLogin(resolveCursorLogin(env), { env, fetchImpl: async () => {
    writeStoredCursorLogin(b, env);
    return json({ shouldLogout: true });
  } });
  assert.equal(readStoredCursorLogin(env).credential.accessToken, b.accessToken, 'A\'s refusal does not end B');
});

test('after a temporary renewal failure, a rejected read does not renew again within the hold', async t => {
  isolateParser(t);
  writeStoredCursorLogin(cursorCredential({ accessToken: tokenFor('user_a', 2 * DAY, 'near'), refreshToken: 'r' }), process.env);
  let refreshes = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).endsWith('/oauth/token')) { refreshes++; return json({}, 503); }
    return new Response('', { status: 401 });
  });
  const first = await cursor.parse({ previousInfo: RECENT_INFO('user_a') });
  assert.equal(refreshes, 1, 'one renewal per run');
  assert.match(first.warnings[0], /续期本次未完成/);
  await cursor.parse({ previousInfo: RECENT_INFO('user_a') });
  assert.equal(refreshes, 1, 'held for 6 hours');
  // A token already past its expiry is not renewed during the hold either.
  writeStoredCursorLogin(cursorCredential({ accessToken: tokenFor('user_a', -DAY, 'lapsed'), refreshToken: 'r' }), process.env,
    { refreshHeldUntil: new Date(Date.now() + REFRESH_HOLD_MS).toISOString() });
  const lapsed = await cursor.parse({ previousInfo: RECENT_INFO('user_a') });
  assert.equal(refreshes, 1);
  assert.match(lapsed.warnings[0], /续期本次未完成/);
});
