import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { attachCacheScope } from '../cache.js';
import { quotaResult } from '../schema.js';
import { isSqliteUnavailableError, queryDbJson, sqliteUnavailableError } from '../../parsers/sqlite.js';

const PRODUCT_ID = 'opencode-go';
const INTEGRATION_ID = 'opencode-go';
const DEFAULT_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

// The endpoint reports the three windows OpenCode Go enforces (rolling /
// weekly / monthly). It does not return the rolling window length, but the
// official console labels the rolling window "5 hours", so the meter reuses
// that window name; weekly/monthly are calendar windows whose reset instant
// travels with the response.
const METER_ORDER = [
  ['rolling', '5h'],
  ['weekly', 'Weekly'],
  ['monthly', 'Monthly'],
];

/** Data roots scanned for the OpenCode credential store, in order. */
export function openCodeDataRoots(environment = process.env, home = homedir()) {
  const override = environment.VIBE_USAGE_OPENCODE_DIRS?.trim();
  if (override) {
    return override.split(delimiter).map(value => value.trim()).filter(Boolean);
  }
  return [join(home, '.local', 'share', 'opencode')];
}

export function openCodeDbPath(root) {
  return join(root, 'opencode.db');
}

function date(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Reads only the `opencode-go` integration key from OpenCode's credential
 * table. The value is the client's own JSON blob (`{ type: 'key', key }`);
 * nothing else in the row or database is selected, logged, cached, or
 * uploaded.
 */
function readCredentialTable(root) {
  const dbPath = openCodeDbPath(root);
  if (!existsSync(dbPath)) return { status: 'missing' };
  try {
    const rows = queryDbJson(dbPath, `SELECT value FROM credential
      WHERE integration_id = '${INTEGRATION_ID}'
      ORDER BY coalesce(active, 1) DESC, time_updated DESC
      LIMIT 1`);
    const raw = rows[0]?.value;
    if (typeof raw !== 'string' || !raw.trim()) return { status: 'missing' };
    let key = '';
    try {
      const parsed = JSON.parse(raw);
      key = typeof parsed?.key === 'string' ? parsed.key.trim() : '';
    } catch {
      key = '';
    }
    return key ? { status: 'ok', key } : { status: 'missing' };
  } catch (error) {
    if (isSqliteUnavailableError(error)) return { status: 'unavailable' };
    // An older/newer schema without the credential table simply has no login.
    if (/no such table|no such column/i.test(error?.message || '')) return { status: 'missing' };
    return { status: 'error' };
  }
}

/**
 * Fallback for the pre-2.x layout, which keeps the same key as plain JSON in
 * `auth.json` (`{"opencode": {"type": "api", "key": "sk-..."}}`). Only that one
 * entry is read; sibling provider credentials in the file are never inspected,
 * and the key is returned to the caller without ever being logged or cached.
 * The credential table stays authoritative when it has a Go row — it is the
 * Go-specific record, while `auth.json` also holds non-Go keys.
 */
function readAuthFile(root) {
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(join(root, 'auth.json'), 'utf8'));
  } catch {
    return { status: 'missing' };
  }
  const key = parsed?.opencode?.key;
  const trimmed = typeof key === 'string' ? key.trim() : '';
  return trimmed ? { status: 'ok', key: trimmed } : { status: 'missing' };
}

/**
 * The Go key for one data root, or a failure to report. The credential table
 * wins; `auth.json` covers stores that never migrated. A concrete table read
 * failure is preserved only when the fallback has no key either, so an
 * unreadable database cannot hide a perfectly good login.
 */
function readCredential(root) {
  const table = readCredentialTable(root);
  if (table.status === 'ok') return table;
  const authFile = readAuthFile(root);
  if (authFile.status === 'ok') return authFile;
  return table;
}

export function parseOpenCodeGoUsage(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('OpenCode usage response is not an object');
  }
  const usage = payload.usage;
  const meters = [];
  for (const [id, label] of METER_ORDER) {
    const item = usage?.[id];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const percent = Number(item.percent);
    if (!Number.isFinite(percent)) continue;
    const meter = { id, label, utilization: Math.max(0, Math.min(100, percent)) };
    const resetsAt = date(item.resetsAt);
    if (resetsAt) meter.resetsAt = resetsAt.toISOString();
    meters.push(meter);
  }
  return meters;
}

/** The URL a quota read requests. */
export function openCodeGoNetworkURLs({ usageURL = DEFAULT_USAGE_URL } = {}) {
  return [usageURL];
}

export async function fetchOpenCodeGoQuota({
  environment = process.env,
  home = homedir(),
  fetchImpl = globalThis.fetch,
  usageURL = DEFAULT_USAGE_URL,
  now = new Date(),
  timeoutMs = 10_000,
} = {}) {
  let credential = { status: 'missing' };
  for (const root of openCodeDataRoots(environment, home)) {
    const found = readCredential(root);
    if (found.status === 'ok') {
      credential = found;
      break;
    }
    // Keep the first concrete read failure; a missing database just means the
    // next configured root may hold the login.
    if (found.status !== 'missing' && credential.status === 'missing') credential = found;
  }
  if (credential.status === 'unavailable') {
    return quotaResult({
      id: PRODUCT_ID,
      status: 'retryable_error',
      message: sqliteUnavailableError('OpenCode Go').message,
      fetchedAt: now,
    });
  }
  if (credential.status === 'error') {
    return quotaResult({
      id: PRODUCT_ID,
      status: 'retryable_error',
      message: 'OpenCode credential store could not be read',
      fetchedAt: now,
    });
  }
  if (credential.status !== 'ok') {
    return quotaResult({
      id: PRODUCT_ID,
      status: 'missing_credentials',
      message: 'OpenCode Go is not logged in',
      fetchedAt: now,
    });
  }

  const token = credential.key;
  try {
    const response = await fetchImpl(usageURL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401) {
      return attachCacheScope(quotaResult({
        id: PRODUCT_ID,
        status: 'unauthorized',
        message: 'OpenCode Go rejected the saved API key',
        fetchedAt: now,
      }), token);
    }
    if (response.status === 403) {
      // A valid OpenCode key without an active Go subscription. The reason
      // travels machine-readably so a client can say "not subscribed" instead
      // of showing a neutral empty state.
      return attachCacheScope(quotaResult({
        id: PRODUCT_ID,
        status: 'no_data',
        emptyReason: 'notEntitled',
        message: 'OpenCode Go subscription is not active',
        fetchedAt: now,
      }), token);
    }
    if (!response.ok) {
      return attachCacheScope(quotaResult({
        id: PRODUCT_ID,
        status: 'retryable_error',
        message: `OpenCode usage API returned HTTP ${response.status}`,
        fetchedAt: now,
      }), token);
    }
    const meters = parseOpenCodeGoUsage(await response.json());
    return attachCacheScope(quotaResult({
      id: PRODUCT_ID,
      status: meters.length ? 'ok' : 'no_data',
      meters,
      message: meters.length ? undefined : 'OpenCode usage API returned no window',
      fetchedAt: now,
      dataAsOf: now,
    }), token);
  } catch (error) {
    return attachCacheScope(quotaResult({
      id: PRODUCT_ID,
      status: 'retryable_error',
      message: error?.name === 'TimeoutError'
        ? 'OpenCode usage request timed out'
        : 'OpenCode usage request failed',
      fetchedAt: now,
    }), token);
  }
}
