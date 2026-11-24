import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { attachCacheScope } from '../cache.js';
import { canonicalizeMeters, quotaResult } from '../schema.js';

const PRODUCT_ID = 'kimi-code';
const DEFAULT_USAGE_URL = 'https://api.kimi.com/coding/v1/usages';
const DEFAULT_OAUTH_HOST = 'https://auth.kimi.com';
const KIMI_CODE_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const MIN_REFRESH_THRESHOLD_SECONDS = 300;
const REFRESH_THRESHOLD_RATIO = 0.5;
const RETRYABLE_REFRESH_STATUSES = new Set([429, 500, 502, 503, 504]);
const REFRESH_LOCK_RETRIES = 50;
const REFRESH_LOCK_RETRY_MS = 100;
const REFRESH_LOCK_STALE_MS = 120_000;

class RefreshUnauthorizedError extends Error {}
class RefreshRetryableError extends Error {}
class RefreshNonRetryableError extends Error {}
class RefreshPersistenceError extends Error {}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resetDate(data, now = new Date()) {
  for (const key of ['reset_at', 'resetAt', 'reset_time', 'resetTime']) {
    const value = data?.[key];
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'number') {
      const millis = value > 10_000_000_000 ? value : value * 1000;
      if (Number.isFinite(millis)) return new Date(millis);
    }
    const millis = Date.parse(String(value));
    if (!Number.isNaN(millis)) return new Date(millis);
  }
  const seconds = number(data?.reset_in ?? data?.resetIn ?? data?.ttl);
  return seconds !== null && seconds > 0 ? new Date(now.getTime() + seconds * 1000) : null;
}

function durationSeconds(item, detail) {
  const window = item?.window && typeof item.window === 'object' ? item.window : {};
  const duration = number(window.duration ?? item?.duration ?? detail?.duration);
  if (duration === null || duration <= 0) return null;
  const unit = String(window.timeUnit ?? item?.timeUnit ?? detail?.timeUnit ?? '').toUpperCase();
  if (unit.includes('MINUTE')) return duration * 60;
  if (unit.includes('HOUR')) return duration * 3600;
  if (unit.includes('DAY')) return duration * 86400;
  if (unit.includes('WEEK')) return duration * 7 * 86400;
  return duration;
}

function labelFor(item, detail, index) {
  for (const key of ['name', 'title', 'scope']) {
    const value = item?.[key] ?? detail?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const seconds = durationSeconds(item, detail);
  if (seconds && seconds % (7 * 86400) === 0) return `${seconds / (7 * 86400)}w`;
  if (seconds && seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds && seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds && seconds % 60 === 0) return `${seconds / 60}m`;
  return `Quota ${index + 1}`;
}

function meterFrom(data, item, index, defaultLabel, now) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const limit = number(data.limit);
  let used = number(data.used);
  if (used === null && limit !== null) {
    const remaining = number(data.remaining);
    if (remaining !== null) used = limit - remaining;
  }
  if (limit === null || limit <= 0 || used === null) return null;
  const label = String(data.name || data.title || defaultLabel).trim();
  const rawIdentifier = String(data.id || item?.id || label)
    .trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const meter = {
    id: `${index}-${rawIdentifier || 'quota'}`,
    label,
    utilization: Math.max(0, Math.min(100, used / limit * 100)),
  };
  const resetsAt = resetDate(data, now) || resetDate(item, now);
  if (resetsAt) meter.resetsAt = resetsAt.toISOString();
  const seconds = durationSeconds(item, data);
  if (seconds) meter.windowSeconds = seconds;
  return meter;
}

export function parseKimiUsage(payload, now = new Date()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Kimi usage response is not an object');
  }
  const meters = [];
  if (payload.usages && typeof payload.usages === 'object' && !Array.isArray(payload.usages)) {
    const currentMeters = [
      ['limit_5h', '5h', 5 * 3600],
      ['limit_7d', '7d', 7 * 86400],
      ['limit_month_total', 'Monthly', null],
      ['limit_month_code', 'Monthly Code', null],
    ];
    for (const [key, label, windowSeconds] of currentMeters) {
      const entry = payload.usages[key];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const ratio = number(entry.used_ratio ?? entry.usedRatio);
      if (ratio === null) continue;
      const meter = {
        id: key.replaceAll('_', '-'),
        label,
        utilization: Math.max(0, Math.min(100, ratio * 100)),
      };
      const resetsAt = resetDate(entry, now);
      if (resetsAt) meter.resetsAt = resetsAt.toISOString();
      if (windowSeconds) meter.windowSeconds = windowSeconds;
      meters.push(meter);
    }
  }
  if (payload.usage && typeof payload.usage === 'object' && !Array.isArray(payload.usage)) {
    const summary = meterFrom(payload.usage, payload.usage, 0, 'Weekly', now);
    if (summary) meters.push(summary);
  }
  if (Array.isArray(payload.limits)) {
    const offset = meters.length;
    for (const [index, item] of payload.limits.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const detail = item.detail && typeof item.detail === 'object' && !Array.isArray(item.detail)
        ? item.detail : item;
      const meter = meterFrom(detail, item, index + offset,
        labelFor(item, detail, index), now);
      if (meter) meters.push(meter);
    }
  }
  const seen = new Set();
  return canonicalizeMeters(meters).filter(meter => {
    const key = `${meter.label}\0${meter.windowSeconds || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Kimi Code has two credential locations in the wild: the current CLI (2.x)
// writes `$KIMI_CODE_HOME/credentials/kimi-code.json`, defaulting to
// `~/.kimi-code` -- the same home the session parser already resolves -- while
// kimi-cli (1.x) keeps `$KIMI_SHARE_DIR/credentials/kimi-code.json`, defaulting
// to `~/.kimi`. Reading only the legacy path reported `missing_credentials` for
// every 2.x user whose login sits in the new home (issue #112), while their
// usage parsed fine, so the quota card contradicted the token tables.
export function kimiCredentialPaths(environment = process.env, home = homedir()) {
  const codeHome = environment.KIMI_CODE_HOME?.trim() || join(home, '.kimi-code');
  const legacyHome = environment.KIMI_SHARE_DIR?.trim() || join(home, '.kimi');
  return [...new Set([codeHome, legacyHome]
    .map(directory => join(directory, 'credentials', 'kimi-code.json')))];
}

// The file to read and, on refresh, to rotate atomically: the first existing
// login, current home before legacy, so a stale `KIMI_SHARE_DIR` cannot shadow
// the CLI the user actually runs. With no login anywhere the current CLI's path
// is returned, so `missing_credentials` (and any rotation after a later login)
// names the file the installed CLI writes.
export function kimiCredentialPath(environment = process.env, home = homedir()) {
  const paths = kimiCredentialPaths(environment, home);
  for (const path of paths) {
    try {
      if (statSync(path).isFile()) return path;
    } catch {}
  }
  return paths[0];
}

function readCredentials(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function accessToken(credentials) {
  return typeof credentials?.access_token === 'string' ? credentials.access_token.trim() : '';
}

function refreshToken(credentials) {
  return typeof credentials?.refresh_token === 'string' ? credentials.refresh_token.trim() : '';
}

function refreshThreshold(credentials) {
  const expiresIn = number(credentials?.expires_in);
  return Math.max(
    MIN_REFRESH_THRESHOLD_SECONDS,
    expiresIn !== null && expiresIn > 0 ? expiresIn * REFRESH_THRESHOLD_RATIO : 0,
  );
}

function shouldRefresh(credentials, now, force = false) {
  if (force) return true;
  if (!accessToken(credentials)) return true;
  const expiresAt = number(credentials?.expires_at);
  if (expiresAt === null || expiresAt <= 0) return false;
  return expiresAt * 1000 - now.getTime() <= refreshThreshold(credentials) * 1000;
}

function credentialsWereRotated(latest, previous) {
  const latestRefresh = refreshToken(latest);
  const previousRefresh = refreshToken(previous);
  if (latestRefresh && latestRefresh !== previousRefresh) return true;
  return Boolean(accessToken(latest) && accessToken(latest) !== accessToken(previous));
}

function atomicWriteCredentials(path, credentials) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  let descriptor = -1;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(credentials)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = -1;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor >= 0) {
      try { closeSync(descriptor); } catch {}
    }
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function assertCredentialStoreWritable(path) {
  // Check this before rotating a refresh token. A successful refresh can
  // invalidate the old token, so discovering a read-only credential store only
  // after the network request could log the user out of Kimi Code.
  try {
    accessSync(dirname(path), fsConstants.W_OK);
  } catch {
    throw new RefreshPersistenceError();
  }
}

function lockPathFor(credentialsPath) {
  return `${credentialsPath}.vibe-usage-refresh-lock`;
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

function removeAbandonedLock(path, nowMs) {
  try {
    let owner = null;
    try { owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')); } catch {}
    const isOrphan = owner?.pid && !processIsAlive(Number(owner.pid));
    const isStale = nowMs - statSync(path).mtimeMs > REFRESH_LOCK_STALE_MS;
    if (!isOrphan && !isStale) return false;
    try { unlinkSync(join(path, 'owner.json')); } catch {}
    rmdirSync(path);
    return true;
  } catch {
    return false;
  }
}

async function acquireRefreshLock(credentialsPath, sleepImpl) {
  const path = lockPathFor(credentialsPath);
  for (let attempt = 0; attempt <= REFRESH_LOCK_RETRIES; attempt += 1) {
    try {
      mkdirSync(path, { mode: 0o700 });
      try {
        writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: process.pid }), {
          encoding: 'utf8',
          mode: 0o600,
        });
      } catch {
        try { unlinkSync(join(path, 'owner.json')); } catch {}
        try { rmdirSync(path); } catch {}
        throw new RefreshPersistenceError();
      }
      return () => {
        try { unlinkSync(join(path, 'owner.json')); } catch {}
        try { rmdirSync(path); } catch {}
      };
    } catch (error) {
      if (error instanceof RefreshPersistenceError) throw error;
      if (error?.code !== 'EEXIST') throw new RefreshPersistenceError();
      if (removeAbandonedLock(path, Date.now())) continue;
      if (attempt < REFRESH_LOCK_RETRIES) await sleepImpl(REFRESH_LOCK_RETRY_MS);
    }
  }
  throw new RefreshRetryableError();
}

function refreshedCredentials(payload, previous, now) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RefreshRetryableError();
  }
  const nextAccessToken = typeof payload.access_token === 'string' ? payload.access_token.trim() : '';
  const nextRefreshToken = typeof payload.refresh_token === 'string'
    ? payload.refresh_token.trim() : refreshToken(previous);
  const expiresIn = number(payload.expires_in);
  if (!nextAccessToken || !nextRefreshToken || expiresIn === null || expiresIn <= 0) {
    throw new RefreshRetryableError();
  }
  return {
    access_token: nextAccessToken,
    refresh_token: nextRefreshToken,
    expires_at: now.getTime() / 1000 + expiresIn,
    scope: typeof payload.scope === 'string' ? payload.scope : String(previous.scope || ''),
    token_type: typeof payload.token_type === 'string'
      ? payload.token_type : String(previous.token_type || 'Bearer'),
    expires_in: expiresIn,
  };
}

async function requestTokenRefresh({
  credentials,
  fetchImpl,
  oauthURL,
  now,
  timeoutMs,
  sleepImpl,
}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(oauthURL, {
        method: 'POST',
        // A refresh token is never handed on to wherever a redirect points.
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: KIMI_CODE_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: refreshToken(credentials),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      let payload = {};
      try { payload = await response.json(); } catch {}
      if (response.status === 401 || response.status === 403) {
        throw new RefreshUnauthorizedError();
      }
      if (!response.ok) {
        if (payload?.error === 'invalid_grant') throw new RefreshUnauthorizedError();
        if (!RETRYABLE_REFRESH_STATUSES.has(response.status)) throw new RefreshNonRetryableError();
        lastError = new RefreshRetryableError();
      } else {
        return refreshedCredentials(payload, credentials, now);
      }
    } catch (error) {
      if (error instanceof RefreshUnauthorizedError) throw error;
      if (error instanceof RefreshNonRetryableError) throw new RefreshRetryableError();
      lastError = error;
    }
    if (attempt < 2) await sleepImpl(2 ** attempt * 1000);
  }
  throw new RefreshRetryableError(undefined, { cause: lastError });
}

async function ensureFreshCredentials({
  credentialsPath,
  credentials,
  fetchImpl,
  oauthURL,
  now,
  timeoutMs,
  sleepImpl,
  force = false,
}) {
  if (!shouldRefresh(credentials, now, force)) return credentials;
  if (!refreshToken(credentials)) return credentials;

  let release;
  try {
    release = await acquireRefreshLock(credentialsPath, sleepImpl);
    const latest = readCredentials(credentialsPath) || credentials;
    if (credentialsWereRotated(latest, credentials)) return latest;
    if (!shouldRefresh(latest, now, force)) return latest;
    assertCredentialStoreWritable(credentialsPath);

    let refreshed;
    try {
      refreshed = await requestTokenRefresh({
        credentials: latest,
        fetchImpl,
        oauthURL,
        now,
        timeoutMs,
        sleepImpl,
      });
    } catch (error) {
      if (error instanceof RefreshUnauthorizedError) {
        // A Kimi process may have rotated and persisted the token while our
        // request was in flight. Re-read once before reporting a stale refresh
        // token as rejected.
        await sleepImpl(1000);
        const concurrent = readCredentials(credentialsPath);
        if (concurrent && credentialsWereRotated(concurrent, latest)) return concurrent;
      }
      throw error;
    }

    const concurrent = readCredentials(credentialsPath);
    if (concurrent && credentialsWereRotated(concurrent, latest)) return concurrent;
    try {
      atomicWriteCredentials(credentialsPath, refreshed);
    } catch {
      throw new RefreshPersistenceError();
    }
    return refreshed;
  } finally {
    release?.();
  }
}

export function kimiOAuthURL(environment = process.env) {
  return `${(environment.KIMI_CODE_OAUTH_HOST || environment.KIMI_OAUTH_HOST
    || DEFAULT_OAUTH_HOST).replace(/\/$/, '')}/api/oauth/token`;
}

/** The URLs a quota read may request, resolved the same way the read does. */
export function kimiCodeNetworkURLs({
  environment = process.env,
  usageURL = DEFAULT_USAGE_URL,
  oauthURL = kimiOAuthURL(environment),
} = {}) {
  return [usageURL, oauthURL];
}

export async function fetchKimiCodeQuota({
  environment = process.env,
  home = homedir(),
  fetchImpl = globalThis.fetch,
  usageURL = DEFAULT_USAGE_URL,
  oauthURL = kimiOAuthURL(environment),
  now = new Date(),
  timeoutMs = 10_000,
  sleepImpl = sleep,
} = {}) {
  const credentialsPath = kimiCredentialPath(environment, home);
  let credentials = readCredentials(credentialsPath);
  if (!credentials) {
    return quotaResult({ id: PRODUCT_ID, status: 'missing_credentials',
      message: 'Kimi Code is not logged in', fetchedAt: now });
  }

  try {
    credentials = await ensureFreshCredentials({
      credentialsPath,
      credentials,
      fetchImpl,
      oauthURL,
      now,
      timeoutMs,
      sleepImpl,
    });
  } catch (error) {
    const token = accessToken(credentials);
    if (error instanceof RefreshUnauthorizedError) {
      return attachCacheScope(quotaResult({ id: PRODUCT_ID, status: 'unauthorized',
        message: 'Kimi Code login refresh was rejected', fetchedAt: now }), token);
    }
    const message = error instanceof RefreshPersistenceError
      ? 'Kimi Code could not securely save the refreshed login'
      : 'Kimi Code login refresh failed';
    return attachCacheScope(quotaResult({ id: PRODUCT_ID, status: 'retryable_error',
      message, fetchedAt: now }), token);
  }

  let token = accessToken(credentials);
  if (!token) {
    return quotaResult({ id: PRODUCT_ID, status: 'missing_credentials',
      message: 'Kimi Code access token is missing', fetchedAt: now });
  }
  const expiresAt = number(credentials.expires_at);
  if (expiresAt !== null && expiresAt > 0 && expiresAt * 1000 <= now.getTime()) {
    return attachCacheScope(quotaResult({ id: PRODUCT_ID, status: 'expired_credentials',
      message: 'Kimi Code access token is expired and no refresh token is available',
      fetchedAt: now }), token);
  }

  try {
    let response = await fetchImpl(usageURL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 && refreshToken(credentials)) {
      try {
        credentials = await ensureFreshCredentials({
          credentialsPath,
          credentials,
          fetchImpl,
          oauthURL,
          now,
          timeoutMs,
          sleepImpl,
          force: true,
        });
        token = accessToken(credentials);
        response = await fetchImpl(usageURL, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (error instanceof RefreshUnauthorizedError) {
          return attachCacheScope(quotaResult({ id: PRODUCT_ID, status: 'unauthorized',
            message: 'Kimi Code login refresh was rejected', fetchedAt: now }), token);
        }
        const message = error instanceof RefreshPersistenceError
          ? 'Kimi Code could not securely save the refreshed login'
          : 'Kimi Code login refresh failed';
        return attachCacheScope(quotaResult({ id: PRODUCT_ID, status: 'retryable_error',
          message, fetchedAt: now }), token);
      }
    }
    if (response.status === 401 || response.status === 403) {
      return quotaResult({ id: PRODUCT_ID, status: 'unauthorized',
        message: 'Kimi Code rejected the saved login', fetchedAt: now });
    }
    if (!response.ok) {
      return attachCacheScope(quotaResult({ id: PRODUCT_ID, status: 'retryable_error',
        message: `Kimi usage API returned HTTP ${response.status}`, fetchedAt: now }), token);
    }
    const meters = parseKimiUsage(await response.json(), now);
    return attachCacheScope(quotaResult({
      id: PRODUCT_ID,
      status: meters.length ? 'ok' : 'no_data',
      meters,
      fetchedAt: now,
      dataAsOf: now,
    }), token);
  } catch (error) {
    return attachCacheScope(quotaResult({ id: PRODUCT_ID, status: 'retryable_error',
      message: error?.name === 'TimeoutError' ? 'Kimi usage request timed out' : 'Kimi usage request failed',
      fetchedAt: now }), token);
  }
}
