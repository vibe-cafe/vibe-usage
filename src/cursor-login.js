// Cursor separate sign-in ("单独登录"), approved 2026-11-25 by the maintainer
// (Hogan); plan: the maintenance workspace's 交接笔记/Cursor-加密凭据-方案.md.
//
// Cursor 3.27+ encrypts the login it keeps in state.vscdb (issue #144) and the
// decision is not to decrypt it. Instead the user signs in to Cursor once more,
// for Vibe Usage, through the browser sign-in Cursor's own CLI uses (OpenUsage
// 0.8.0 does the same): `cursor.com/loginDeepControl` with a PKCE challenge,
// then `api2.cursor.sh/auth/poll` until the user confirms. Cursor sees a
// "Cursor CLI" sign-in (`redirectTarget=cli`, Cursor's public client id for
// renewal); no header pretends to be the editor or a browser. Nothing of
// Cursor's own (state.vscdb, Local State, its Keychain items) is read here.
//
// Where the sign-in lives:
// - the desktop apps keep it in their own Keychain item / Credential Manager
//   entry and hand it over on stdin (`--cursor-login-stdin`) on every run; the
//   CLI then never writes it anywhere and never renews it (the app runs
//   `login cursor --refresh --json`, which prints the renewed one back);
// - CLI-only users: `~/.vibe-usage/cursor-login.json`, mode 0600, renewed here
//   under a cross-process lock.
// It never enters logs, warnings, state.json, the quota cache, a child
// process's environment or argv.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { COLLECTOR_VERSION } from './client-meta.js';
import { chosenProxies, envProxyBlockFor } from './env-proxy.js';
import { systemProxyConfigured } from './system-proxy.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Cursor's own public client id; Cursor's editor renews with it too. */
export const CURSOR_CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';
/** Renew this long before the sign-in's `exp` (about 60 days after sign-in). */
export const REFRESH_LEAD_MS = 7 * DAY_MS;
/** After a renewal that failed for a temporary reason, wait this long. */
export const REFRESH_HOLD_MS = 6 * HOUR_MS;
export const POLL_INTERVAL_MS = 2_000;
export const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
// Consecutive network failures while waiting for the user before giving up.
const MAX_POLL_NETWORK_ERRORS = 5;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 16_384;
const LOCK_STALE_MS = 60_000;
// Up to 20 s: longer than one renewal request (15 s), so a login or logout
// waits for a renewal in flight instead of racing it.
const LOCK_RETRIES = 200;
const LOCK_RETRY_MS = 100;
// Honest identification for the requests this module adds (sign-in, profile,
// renewal); the existing usage reads are unchanged.
export const CURSOR_USER_AGENT = `vibe-usage/${COLLECTOR_VERSION}`;

export function cursorWebBase(env = process.env) {
  return (env.CURSOR_WEB_BASE_URL?.trim() || 'https://cursor.com').replace(/\/+$/, '');
}

// Test hook only: a local stand-in server on a loopback address. Anything
// else is ignored, so a stray value cannot send a sign-in to another host.
export function cursorApiBase(env = process.env) {
  const override = env.VIBE_USAGE_CURSOR_API_BASE_URL?.trim();
  if (override) {
    try {
      const url = new URL(override);
      if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return url.origin;
    } catch { /* ignored */ }
  }
  return 'https://api2.cursor.sh';
}

/** The URLs sign-in and renewal request, for `envProxyBlockFor()`. */
export function cursorLoginNetworkURLs(env = process.env) {
  return [`${cursorApiBase(env)}/auth/poll`, `${cursorApiBase(env)}/oauth/token`, `${cursorWebBase(env)}/api/auth/me`];
}

/** The URL renewal requests. */
export function cursorRefreshURL(env = process.env) {
  return `${cursorApiBase(env)}/oauth/token`;
}

const SYSTEM_PROXY_BLOCK = Object.freeze({
  reason: 'systemProxy',
  message: 'A system proxy is configured but this process was given no proxy variables; not sent, to avoid a direct connection. Set HTTPS_PROXY first.',
  notice: '检测到系统代理，但这个进程没有收到代理环境变量（终端里请先设置 HTTPS_PROXY），为避免直连已跳过',
});

/**
 * Why the sign-in's own requests (sign-in, renewal, and reads with a stored
 * sign-in) must not be sent now, or null. On top of `envProxyBlockFor()`: a
 * terminal or background run without proxy variables on a machine with a
 * system proxy / PAC (`system-proxy.js`) would go direct. The desktop apps
 * pass their sign-in on stdin and turn the system proxy into variables
 * themselves, so this is not applied to them.
 */
export function cursorSignInBlock(urls, { env = process.env, blockFor = envProxyBlockFor, systemProxy = systemProxyConfigured } = {}) {
  const block = blockFor(urls, { env });
  if (block) return block;
  if (!chosenProxies(env).https && systemProxy({ env })) return SYSTEM_PROXY_BLOCK;
  return null;
}

// --- Tokens -----------------------------------------------------------------

function cleanToken(value) {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  if (!token || token.length > MAX_TOKEN_LENGTH || /[\x00-\x20\x7f]/.test(token)) return null;
  return token;
}

function jwtClaims(token) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
  } catch {
    return null;
  }
}

/** Cursor's user id: the part of the JWT `sub` after `|` (`auth0|user_…`). */
export function cursorUserId(token) {
  const sub = jwtClaims(token)?.sub;
  if (typeof sub !== 'string' || !sub.trim()) return null;
  return sub.trim().split('|').pop().trim() || null;
}

function tokenExpiryMs(token) {
  const exp = jwtClaims(token)?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
}

function validEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim();
  return email.length <= 320 && /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+$/.test(email) ? email : null;
}

function validDate(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * A credential record from fresh tokens, or null when they are not a Cursor
 * sign-in. Cursor's access token is a JWT that doubles as its refresh token
 * (renewal answers with an access token only), so a missing refresh token
 * falls back to the access token.
 */
export function cursorCredential({ accessToken, refreshToken, email, obtainedAt, refreshedAt, now = new Date() }) {
  const access = cleanToken(accessToken);
  if (!access) return null;
  const userId = cursorUserId(access);
  if (!userId) return null;
  const refresh = cleanToken(refreshToken) || access;
  const expires = tokenExpiryMs(access);
  const credential = {
    version: 1,
    accessToken: access,
    refreshToken: refresh,
    userId,
    obtainedAt: validDate(obtainedAt) || now.toISOString(),
  };
  if (expires) credential.expiresAt = new Date(expires).toISOString();
  const mail = validEmail(email);
  if (mail) credential.email = mail;
  const refreshed = validDate(refreshedAt);
  if (refreshed) credential.refreshedAt = refreshed;
  return credential;
}

/** Validate a stored or app-provided record; derived fields come from the token. */
export function normalizeCursorCredential(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return cursorCredential(raw);
}

/** The cookie cursor.com's dashboard API takes (what the browser sends). */
export function cursorSessionCookie(token) {
  return `WorkosCursorSessionToken=${cursorUserId(token)}%3A%3A${token}`;
}

// --- Network ------------------------------------------------------------------

async function readBody(response) {
  if (!response?.body) return '';
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Oversized response');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function discard(response) {
  try { await response?.body?.cancel(); } catch { /* nothing to free */ }
}

export class CursorLoginError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

/** A new sign-in: the browser URL plus what the poll needs (kept in memory). */
export function cursorLoginRequest(env = process.env) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const uuid = randomUUID();
  const url = new URL(`${cursorWebBase(env)}/loginDeepControl`);
  url.searchParams.set('challenge', challenge);
  url.searchParams.set('uuid', uuid);
  url.searchParams.set('mode', 'login');
  url.searchParams.set('redirectTarget', 'cli');
  return { uuid, verifier, challenge, url: url.href };
}

/**
 * Wait for the user to confirm in the browser. 404 / 202 mean "not yet"; a
 * 200 carrying both tokens is the sign-in. Every 2 s for at most 5 minutes.
 */
export async function pollCursorLogin({
  uuid, verifier, env = process.env, fetchImpl = globalThis.fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now(),
  intervalMs = POLL_INTERVAL_MS, timeoutMs = POLL_TIMEOUT_MS,
} = {}) {
  const deadline = now() + timeoutMs;
  const url = `${cursorApiBase(env)}/auth/poll?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`;
  let networkErrors = 0;
  for (;;) {
    let response = null;
    try {
      response = await fetchImpl(url, {
        headers: { Accept: 'application/json', 'User-Agent': CURSOR_USER_AGENT },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      networkErrors += 1;
      if (networkErrors >= MAX_POLL_NETWORK_ERRORS) throw new CursorLoginError('network');
    }
    if (response) {
      networkErrors = 0;
      if (response.status === 404 || response.status === 202) {
        await discard(response);
      } else if (response.ok) {
        let payload = null;
        try { payload = JSON.parse(await readBody(response)); } catch { /* checked below */ }
        const accessToken = cleanToken(payload?.accessToken);
        const refreshToken = cleanToken(payload?.refreshToken);
        if (accessToken && refreshToken) return { accessToken, refreshToken };
        throw new CursorLoginError('failed', 'invalid response');
      } else {
        await discard(response);
        throw new CursorLoginError('failed', `HTTP ${response.status}`);
      }
    }
    if (now() + intervalMs >= deadline) throw new CursorLoginError('timeout');
    await sleep(intervalMs);
  }
}

/** The account's email, only for showing which account is signed in. */
export async function fetchCursorEmail(accessToken, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  try {
    const response = await fetchImpl(`${cursorWebBase(env)}/api/auth/me`, {
      headers: { Cookie: cursorSessionCookie(accessToken), Accept: 'application/json', 'User-Agent': CURSOR_USER_AGENT },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      await discard(response);
      return null;
    }
    return validEmail(JSON.parse(await readBody(response))?.email);
  } catch {
    return null;
  }
}

/**
 * Renew a sign-in. `ok` with the new record, `expired` when Cursor ended the
 * session (`shouldLogout`, 400/401/403, or a different account), `retryable`
 * for anything temporary. `reason` is a fixed, token-free phrase.
 */
export async function refreshCursorCredential(credential, {
  env = process.env, fetchImpl = globalThis.fetch, now = new Date(),
} = {}) {
  let response;
  try {
    response = await fetchImpl(cursorRefreshURL(env), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': CURSOR_USER_AGENT },
      body: JSON.stringify({ grant_type: 'refresh_token', client_id: CURSOR_CLIENT_ID, refresh_token: credential.refreshToken }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { status: 'retryable', reason: `network: ${error?.name === 'TimeoutError' ? 'timeout' : 'fetch failed'}` };
  }
  let payload = null;
  try { payload = JSON.parse(await readBody(response)); } catch { /* checked below */ }
  if (payload?.shouldLogout === true || [400, 401, 403].includes(response.status)) return { status: 'expired' };
  if (!response.ok) return { status: 'retryable', reason: `skipped (HTTP ${response.status})` };
  const next = cursorCredential({
    accessToken: payload?.access_token,
    refreshToken: payload?.refresh_token,
    email: credential.email,
    obtainedAt: credential.obtainedAt,
    refreshedAt: now.toISOString(),
    now,
  });
  if (!next) return { status: 'retryable', reason: 'invalid response' };
  // Never switch accounts behind the user's back.
  if (next.userId !== credential.userId) return { status: 'expired' };
  return { status: 'ok', credential: next };
}

// --- The stored sign-in (CLI-only users) -------------------------------------

export function cursorLoginPath(env = process.env) {
  const dir = env.VIBE_USAGE_CONFIG_DIR?.trim() || join(homedir(), '.vibe-usage');
  return join(dir, env.VIBE_USAGE_DEV === '1' ? 'cursor-login.dev.json' : 'cursor-login.json');
}

/**
 * null when there is none; `{ credential, refreshHeldUntil }`; `{ rejected }`
 * after Cursor ended it (the tokens are already gone then); `{ invalid }` for
 * an unreadable file.
 */
export function readStoredCursorLogin(env = process.env) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(cursorLoginPath(env), 'utf8'));
  } catch (error) {
    return error?.code === 'ENOENT' ? null : { invalid: true };
  }
  if (raw && typeof raw === 'object' && validDate(raw.rejectedAt)) {
    return { rejected: true, rejectedAt: validDate(raw.rejectedAt), email: validEmail(raw.email) };
  }
  const credential = normalizeCursorCredential(raw);
  if (!credential) return { invalid: true };
  return { credential, refreshHeldUntil: validDate(raw.refreshHeldUntil) };
}

function atomicWrite(path, value) {
  const dir = dirname(path);
  // A directory we create is ours alone; an existing one keeps its mode.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let descriptor = -1;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = -1;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor >= 0) {
      try { closeSync(descriptor); } catch { /* already failing */ }
    }
    try { unlinkSync(temporary); } catch { /* never created */ }
    throw error;
  }
}

export function writeStoredCursorLogin(credential, env = process.env, { refreshHeldUntil } = {}) {
  atomicWrite(cursorLoginPath(env), refreshHeldUntil ? { ...credential, refreshHeldUntil } : credential);
}

/** Cursor ended the session: drop the tokens, keep only what `status` shows. */
export function markStoredCursorLoginRejected(env = process.env, { email, userId, now = new Date() } = {}) {
  const record = { version: 1, rejectedAt: now.toISOString() };
  if (validEmail(email)) record.email = validEmail(email);
  if (typeof userId === 'string' && userId) record.userId = userId;
  try { atomicWrite(cursorLoginPath(env), record); } catch { /* the next rejection tries again */ }
}

export function deleteStoredCursorLogin(env = process.env) {
  try {
    unlinkSync(cursorLoginPath(env));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function acquireLock(path, sleep) {
  const lock = `${path}.lock`;
  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt += 1) {
    try {
      mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
      mkdirSync(lock, { mode: 0o700 });
      try { writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 }); } catch { /* stale check falls back to the mtime */ }
      return () => {
        try { unlinkSync(join(lock, 'owner.json')); } catch { /* gone */ }
        try { rmdirSync(lock); } catch { /* gone */ }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') return null;
      let owner = null;
      try { owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')); } catch { /* none yet */ }
      let stale = false;
      try { stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS; } catch { continue; }
      if (stale || owner?.pid && !processIsAlive(Number(owner.pid))) {
        try { unlinkSync(join(lock, 'owner.json')); } catch { /* gone */ }
        try { rmdirSync(lock); } catch { /* someone else removed it */ }
        continue;
      }
      if (attempt < LOCK_RETRIES) await sleep(LOCK_RETRY_MS);
    }
  }
  return null;
}

// --- The sign-in handed over by a desktop app (stdin) -------------------------

let provided = null;

/** `--cursor-login-stdin`: the record the app keeps. Invalid input is remembered as unusable. */
export function setProvidedCursorLogin(text) {
  let credential = null;
  try { credential = normalizeCursorCredential(JSON.parse(String(text))); } catch { /* unusable */ }
  provided = credential ? { credential } : { unusable: true };
  return Boolean(credential);
}

export function resetProvidedCursorLoginForTests() {
  provided = null;
}

/**
 * The Vibe Usage sign-in to use, or null when there is none (then the local
 * Cursor login is read as before). The app's wins over the stored one.
 * `unusable` means it exists but cannot be used (Cursor ended it, unreadable).
 */
export function resolveCursorLogin(env = process.env) {
  if (provided) return provided.credential ? { kind: 'provided', credential: provided.credential } : { kind: 'provided', unusable: true };
  const stored = readStoredCursorLogin(env);
  if (!stored) return null;
  if (stored.rejected || stored.invalid) return { kind: 'stored', unusable: true };
  return { kind: 'stored', credential: stored.credential, refreshHeldUntil: stored.refreshHeldUntil };
}

/**
 * The token to read with, renewing a stored sign-in when it is due (or when
 * `force`, after Cursor rejected `login.credential`). Returns
 * `{ credential, refreshed? }`, `{ expired: true }` (sign in again) or
 * `{ retryable: true, reason }` (skip this run, try again next time). A
 * provided (app) sign-in is never renewed here: the app does that. After a
 * renewal that failed for a temporary reason nothing is asked for 6 hours,
 * forced or not; the current token is used while it is still valid.
 */
export async function freshCursorLogin(login, {
  env = process.env, fetchImpl = globalThis.fetch, now = new Date(), force = false,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (!login || login.unusable) return { expired: true };
  const nowMs = now.getTime();
  const isLive = credential => {
    const expiresMs = Date.parse(credential.expiresAt);
    return !Number.isFinite(expiresMs) || expiresMs > nowMs;
  };
  const isDue = credential => {
    const expiresMs = Date.parse(credential.expiresAt);
    return force || Number.isFinite(expiresMs) && expiresMs - nowMs <= REFRESH_LEAD_MS;
  };
  const isHeld = until => Boolean(until) && Date.parse(until) > nowMs;
  const heldAnswer = credential => (isLive(credential) && !force
    ? { credential } : { retryable: true, reason: 'held' });

  if (login.kind === 'provided') return isLive(login.credential) && !force ? { credential: login.credential } : { expired: true };
  if (!isDue(login.credential)) return { credential: login.credential };
  if (isHeld(login.refreshHeldUntil)) return heldAnswer(login.credential);

  const release = await acquireLock(cursorLoginPath(env), sleep);
  if (!release) return isLive(login.credential) && !force ? { credential: login.credential } : { retryable: true, reason: 'lock busy' };
  try {
    const latest = readStoredCursorLogin(env);
    // Signed out (or ended) by another process meanwhile.
    if (!latest || latest.rejected || latest.invalid) return { expired: true };
    // Another process renewed it, or the user signed in again, meanwhile.
    if (latest.credential.accessToken !== login.credential.accessToken) {
      return { credential: latest.credential, refreshed: true };
    }
    if (isHeld(latest.refreshHeldUntil)) return heldAnswer(latest.credential);
    const outcome = await refreshCursorCredential(latest.credential, { env, fetchImpl, now });
    // Write back only over the very sign-in the request was made with: a
    // logout or a new sign-in during the request wins (they take this lock
    // too, but do not wait for it forever).
    const unchanged = () => readStoredCursorLogin(env)?.credential?.accessToken === latest.credential.accessToken;
    if (outcome.status === 'ok') {
      if (unchanged()) {
        try { writeStoredCursorLogin(outcome.credential, env); } catch { /* this run still has it */ }
        return { credential: outcome.credential, refreshed: true };
      }
      // Signed out meanwhile: the renewed token is dropped, nothing more is
      // read with it. Signed in again: use that one.
      const current = readStoredCursorLogin(env);
      return current?.credential ? { credential: current.credential, refreshed: true } : { expired: true };
    }
    if (outcome.status === 'expired') {
      if (unchanged()) markStoredCursorLoginRejected(env, { email: latest.credential.email, userId: latest.credential.userId, now });
      return { expired: true };
    }
    if (unchanged()) {
      try {
        writeStoredCursorLogin(latest.credential, env, { refreshHeldUntil: new Date(nowMs + REFRESH_HOLD_MS).toISOString() });
      } catch { /* tries again next run */ }
    }
    return isLive(latest.credential) && !force ? { credential: latest.credential } : { retryable: true, reason: outcome.reason };
  } finally {
    release();
  }
}

/**
 * The stored sign-in was rejected again right after renewal: end it, under
 * the lock, unless the file meanwhile holds another sign-in (a new login,
 * another renewal).
 */
export async function endStoredCursorLogin(login, env = process.env, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (login?.kind !== 'stored' || !login.credential) return;
  const release = await acquireLock(cursorLoginPath(env), sleep);
  try {
    if (readStoredCursorLogin(env)?.credential?.accessToken !== login.credential.accessToken) return;
    markStoredCursorLoginRejected(env, { email: login.credential.email, userId: login.credential.userId });
  } finally {
    release?.();
  }
}

// --- Commands -----------------------------------------------------------------

const LOGIN_NOTE = '以 Cursor 命令行的身份登录，只用来读用量。';

function writeJsonLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * `vibe-usage login cursor [--json] [--no-browser]`
 * `vibe-usage login cursor --refresh --json --cursor-login-stdin` (desktop apps)
 *
 * With `--json` the sign-in is printed (one JSON object per line) for the app
 * to keep, and nothing is written; without it, it is saved to
 * `~/.vibe-usage/cursor-login.json`.
 */
export async function runCursorLogin(args, {
  env = process.env, fetchImpl = globalThis.fetch, blockFor = envProxyBlockFor, systemProxy = systemProxyConfigured,
  openBrowser, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const json = args.includes('--json');
  const refresh = args.includes('--refresh');
  const noBrowser = args.includes('--no-browser');
  const unknown = args.filter(arg => !['--json', '--refresh', '--no-browser'].includes(arg));
  const fail = (code, message) => {
    if (json) writeJsonLine({ event: 'error', code, message });
    else console.error(message);
    process.exitCode = 1;
  };
  if (unknown.length) return fail('usage', `Unknown login option: ${unknown[0]}`);

  // A desktop app (it sets VIBE_USAGE_SURFACE to mac-app / windows-app) has
  // turned the system proxy into variables already; any other caller, with
  // or without --json, gets the system-proxy check too.
  const urls = refresh ? [cursorRefreshURL(env)] : cursorLoginNetworkURLs(env);
  const fromApp = /-app$/.test(env.VIBE_USAGE_SURFACE?.trim() || '');
  const block = fromApp ? blockFor(urls, { env }) : cursorSignInBlock(urls, { env, blockFor, systemProxy });
  if (block) return fail('proxy', `无法按你的代理设置连接 Cursor，未发送任何请求：${block.notice}`);

  if (refresh) {
    if (!json) return fail('usage', 'login cursor --refresh is for the desktop apps: use it with --json and --cursor-login-stdin.');
    const login = provided?.credential;
    if (!login) return fail('usage', 'No Cursor sign-in on stdin (--cursor-login-stdin).');
    const outcome = await refreshCursorCredential(login, { env, fetchImpl });
    if (outcome.status === 'ok') return writeJsonLine({ event: 'credential', credential: outcome.credential });
    if (outcome.status === 'expired') return writeJsonLine({ event: 'expired' });
    return fail('retryable', `Cursor sign-in renewal did not complete (${outcome.reason}).`);
  }

  const request = cursorLoginRequest(env);
  if (json) {
    writeJsonLine({ event: 'open', url: request.url });
  } else {
    console.log(`请在浏览器里确认登录 Cursor（${LOGIN_NOTE}）`);
    console.log(`如果浏览器没有打开，复制这个链接：${request.url}`);
    console.log('等待确认…（最多 5 分钟，Ctrl+C 取消）');
    if (!noBrowser) openBrowser?.(request.url);
  }

  let tokens;
  try {
    tokens = await pollCursorLogin({ uuid: request.uuid, verifier: request.verifier, env, fetchImpl });
  } catch (error) {
    const code = error instanceof CursorLoginError ? error.code : 'failed';
    const message = code === 'timeout' ? '5 分钟内没有在浏览器里确认，已取消登录。'
      : code === 'network' ? '连不上 Cursor，登录没有完成；请检查网络和代理后重试。'
        : 'Cursor 没有完成登录，请重试。';
    return fail(code, message);
  }
  const email = await fetchCursorEmail(tokens.accessToken, { env, fetchImpl });
  const credential = cursorCredential({ ...tokens, email });
  if (!credential) return fail('failed', 'Cursor 返回的登录无法识别，请重试。');

  if (json) return writeJsonLine({ event: 'credential', credential });
  const release = await acquireLock(cursorLoginPath(env), sleep);
  try {
    writeStoredCursorLogin(credential, env);
  } catch {
    return fail('failed', `登录成功，但保存失败：无法写入 ${cursorLoginPath(env)}`);
  } finally {
    release?.();
  }
  const until = credential.expiresAt ? `，有效期至 ${credential.expiresAt.slice(0, 10)}，到期前会自动续期` : '';
  console.log(`已登录 Cursor：${credential.email || 'Cursor 账号'}${until}。`);
}

/** `vibe-usage logout cursor`: forget the stored sign-in. */
export async function runCursorLogout(args, { env = process.env, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (args.length) {
    console.error(`Unknown logout option: ${args[0]}`);
    process.exitCode = 1;
    return;
  }
  // Under the renewal lock, so a renewal in flight cannot write it back.
  const release = await acquireLock(cursorLoginPath(env), sleep);
  let removed;
  try {
    removed = deleteStoredCursorLogin(env);
  } finally {
    release?.();
  }
  console.log(removed ? '已退出 Cursor 登录，本机保存的登录已删除。' : '本机没有保存 Cursor 登录。');
  // Measured 2026-11-25 on the maintainer's account: Cursor lists this sign-in
  // as "Desktop App", adds one more per renewal, and a revocation takes up to
  // 10 minutes.
  console.log('Cursor 官网上的这条登录可在 cursor.com 设置的 Sessions 里撤销：它显示为「Desktop App」（每续期一次多一条，按时间认，别撤正在用的 Cursor 编辑器那条），最多 10 分钟生效。');
}

/** One line for `status`, or null when there is no stored sign-in. Never prints a token. */
export function cursorLoginStatusLine(env = process.env) {
  const stored = readStoredCursorLogin(env);
  if (!stored) return null;
  if (stored.rejected) return `Cursor 登录：已失效${stored.email ? `（${stored.email}）` : ''}，运行 vibe-usage login cursor 重新登录`;
  if (stored.invalid) return 'Cursor 登录：保存的登录无法读取，运行 vibe-usage login cursor 重新登录';
  const { credential } = stored;
  const until = credential.expiresAt ? `，有效期至 ${credential.expiresAt.slice(0, 10)}` : '';
  return `Cursor 登录：${credential.email || 'Cursor 账号'}${until}`;
}
