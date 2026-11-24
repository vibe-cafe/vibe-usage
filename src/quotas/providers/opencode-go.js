import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { attachCacheScope } from '../cache.js';
import { quotaResult } from '../schema.js';
import { isSqliteUnavailableError, queryDbJson, sqliteUnavailableError } from '../../parsers/sqlite.js';

const PRODUCT_ID = 'opencode-go';
// OpenCode's two integrations that can carry a Go login. `opencode-go` is the
// Go-only API key (1.x `/connect` → OpenCode Go, 2.0–2.3, or imported from
// 1.x). `opencode` is the OpenCode account: since OpenCode 2.4.0 the only
// connect option new users see ("OpenCode account" sign-in or "API key
// (service account)"), and Go models come through it.
const GO_INTEGRATION_ID = 'opencode-go';
const OPENCODE_INTEGRATION_ID = 'opencode';
const DEFAULT_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
// An account sign-in is accepted only for the default OpenCode Console. The
// retired host maps onto it path for path, as OpenCode itself rewrites it
// (`packages/core/src/console-access.ts`); a custom Console's token belongs to
// another server and is never sent to opencode.ai.
const DEFAULT_CONSOLE_ORIGIN = 'https://opencode.ai';
const RETIRED_CONSOLE_ORIGIN = 'https://console.opencode.ai';
// OpenCode renews an account token five minutes before it lapses whenever it
// runs. We never renew it (that would rewrite OpenCode's credential and rotate
// its refresh token), so a token this close to expiry is treated as expired.
const EXPIRY_MARGIN_MS = 60_000;

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

/**
 * Data roots scanned for the OpenCode credential store, in order. OpenCode
 * keeps its data in `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode`,
 * on every platform (`%USERPROFILE%\.local\share\opencode` on Windows).
 */
export function openCodeDataRoots(environment = process.env, home = homedir()) {
  const override = environment.VIBE_USAGE_OPENCODE_DIRS?.trim();
  if (override) {
    return override.split(delimiter).map(value => value.trim()).filter(Boolean);
  }
  const xdgData = environment.XDG_DATA_HOME;
  return [join(xdgData || join(home, '.local', 'share'), 'opencode')];
}

export function openCodeDbPath(root) {
  return join(root, 'opencode.db');
}

function date(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function consoleOrigin(fields) {
  const server = typeof fields?.server === 'string' && fields.server.trim()
    ? fields.server.trim()
    : `${DEFAULT_CONSOLE_ORIGIN}/console`;
  try {
    const origin = new URL(server).origin;
    return origin === RETIRED_CONSOLE_ORIGIN ? DEFAULT_CONSOLE_ORIGIN : origin;
  } catch {
    return null;
  }
}

/**
 * Turns one stored credential into what the usage request needs, or a reason
 * it cannot be used. `fields` holds only what the request needs: the type, the
 * key, or an account sign-in's access token, expiry, Console and workspace ID.
 */
function credentialFromFields(fields, integrationId, now) {
  if (!isRecord(fields)) return { status: 'missing' };
  const isOpenCode = integrationId === OPENCODE_INTEGRATION_ID;
  // Only an OpenCode-account credential names a workspace for the request; a
  // Go key is already scoped to one and is sent exactly as before.
  const orgId = isOpenCode ? text(fields.orgId) || undefined : undefined;
  // An OpenCode credential belongs to the Console it signed in to; one for a
  // custom Console is never sent to opencode.ai. (Go keys carry no Console.)
  if (isOpenCode && consoleOrigin(fields) !== DEFAULT_CONSOLE_ORIGIN) return { status: 'missing' };
  if (fields.type === 'key' || fields.type === 'api') {
    const key = text(fields.key);
    if (!key) return { status: 'missing' };
    // No workspace is required here: a 1.x "OpenCode" key imported by 2.x has
    // none, and the endpoint accepts it as it did in 1.x.
    return { status: 'ok', token: key, orgId, scope: key };
  }
  if (fields.type === 'oauth' && isOpenCode) {
    const access = text(fields.access);
    // OpenCode reads the workspace from the sign-in itself
    // (`packages/core/src/usage-limits.ts`) and shows no Go usage without it.
    if (!access || !orgId) return { status: 'missing' };
    const expires = Number(fields.expires);
    if (Number.isFinite(expires) && expires !== 0 && expires <= now.getTime() + EXPIRY_MARGIN_MS) {
      return { status: 'expired' };
    }
    // The access token rotates on every renewal; the workspace does not.
    return { status: 'ok', token: access, orgId, scope: `${OPENCODE_INTEGRATION_ID}\0${orgId}` };
  }
  return { status: 'missing' };
}

// Only the fields the request needs are extracted, inside SQLite, so the rest
// of a stored value — the refresh token above all — never reaches this
// process. A malformed value yields nulls instead of failing the query.
const CREDENTIAL_FIELDS = [
  ['type', '$.type'], ['key', '$.key'], ['access', '$.access'], ['expires', '$.expires'],
  ['orgId', '$.metadata.orgID'], ['server', '$.metadata.server'],
].map(([name, path]) => `CASE WHEN json_valid(value) THEN json_extract(value, '${path}') END AS ${name}`).join(', ');

// 2.x imports `auth.json` into the credential table once and leaves the file
// behind (`20260805200742_import_legacy_credentials`).
const LEGACY_IMPORT_MIGRATION = '20260805200742_import_legacy_credentials';

function legacyLoginsImported(dbPath) {
  try {
    const rows = queryDbJson(dbPath, `SELECT 1 AS imported FROM migration
      WHERE id = '${LEGACY_IMPORT_MIGRATION}' LIMIT 1`);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Reads the current `opencode-go` and `opencode` rows from OpenCode's
 * credential table (2.x): one row per integration, active first, then newest,
 * as OpenCode picks it. Nothing else in the database is selected, logged,
 * cached, or uploaded. `authoritative` says the table, not `auth.json`, holds
 * this OpenCode's logins: it has a row for either integration, or 2.x has
 * imported `auth.json`, whose copy is then a stale leftover.
 */
function readCredentialTable(root, now) {
  const dbPath = openCodeDbPath(root);
  if (!existsSync(dbPath)) return { status: 'missing', candidates: [], authoritative: false };
  const candidates = [];
  try {
    for (const id of [GO_INTEGRATION_ID, OPENCODE_INTEGRATION_ID]) {
      const [row] = queryDbJson(dbPath, `SELECT ${CREDENTIAL_FIELDS} FROM credential
        WHERE integration_id = '${id}'
        ORDER BY coalesce(active, 1) DESC, time_updated DESC
        LIMIT 1`);
      if (row) candidates.push(credentialFromFields(row, id, now));
    }
  } catch (error) {
    if (isSqliteUnavailableError(error)) return { status: 'unavailable', candidates: [], authoritative: false };
    // An older/newer schema without the credential table simply has no login.
    if (/no such table|no such column/i.test(error?.message || '')) {
      return { status: 'missing', candidates: [], authoritative: false };
    }
    return { status: 'error', candidates: [], authoritative: false };
  }
  const authoritative = candidates.length > 0 || legacyLoginsImported(dbPath);
  return { status: 'missing', candidates, authoritative };
}

/**
 * The 1.x layout keeps logins as plain JSON in `auth.json`, keyed by provider:
 * `opencode-go` when the user connected "OpenCode Go" (what the official Go
 * docs describe), `opencode` when they connected "OpenCode" with the same
 * workspace key. Only those two entries are read; sibling provider
 * credentials in the file are never inspected.
 */
function readAuthFile(root, now) {
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(join(root, 'auth.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  return [GO_INTEGRATION_ID, OPENCODE_INTEGRATION_ID]
    .filter(id => parsed[id] !== undefined)
    .map(id => {
      const entry = parsed[id];
      // 1.x stores API keys as `{ type: "api", key }`; an OAuth entry there
      // carries no workspace and is not a Go login.
      return isRecord(entry) && entry.type === 'api'
        ? credentialFromFields({ type: 'api', key: entry.key }, id, now)
        : { status: 'missing' };
    });
}

/**
 * The Go login for one data root, or a failure to report. The credential
 * table (2.x) comes first: `opencode-go`, then the `opencode` account or
 * service-account key. `auth.json` (1.x: `opencode-go`, then `opencode`) is
 * read only when the table holds no OpenCode login and 2.x has not imported
 * the file. The first usable login wins. Otherwise an expired account sign-in
 * is reported — nothing is sent with an older login then — and a table read
 * failure only when `auth.json` had nothing either, so an unreadable database
 * cannot hide a good 1.x login.
 */
function readCredential(root, now) {
  const table = readCredentialTable(root, now);
  const usable = table.candidates.find(candidate => candidate.status === 'ok');
  if (usable) return usable;
  if (!table.authoritative) {
    const fromFile = readAuthFile(root, now).find(candidate => candidate.status === 'ok');
    if (fromFile) return fromFile;
  }
  if (table.candidates.some(candidate => candidate.status === 'expired')) return { status: 'expired' };
  return { status: table.status };
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
    const found = readCredential(root, now);
    if (found.status === 'ok') {
      credential = found;
      break;
    }
    // Keep the first concrete reason; a missing database just means the next
    // configured root may hold the login.
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
  if (credential.status === 'expired') {
    // OpenCode renews the sign-in the next time it runs; nothing is sent.
    return quotaResult({
      id: PRODUCT_ID,
      status: 'expired_credentials',
      message: 'OpenCode account sign-in has expired; open OpenCode to renew it',
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

  const { token, orgId, scope } = credential;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  // The workspace an account sign-in chose, as OpenCode sends it for the same
  // request (`packages/core/src/usage-limits.ts`).
  if (orgId) headers['x-opencode-org-id'] = orgId;
  try {
    const response = await fetchImpl(usageURL, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401) {
      return attachCacheScope(quotaResult({
        id: PRODUCT_ID,
        status: 'unauthorized',
        message: 'OpenCode Go rejected the saved login',
        fetchedAt: now,
      }), scope);
    }
    if (response.status === 403) {
      // A valid OpenCode login without an active Go subscription. The reason
      // travels machine-readably so a client can say "not subscribed" instead
      // of showing a neutral empty state.
      return attachCacheScope(quotaResult({
        id: PRODUCT_ID,
        status: 'no_data',
        emptyReason: 'notEntitled',
        message: 'OpenCode Go subscription is not active',
        fetchedAt: now,
      }), scope);
    }
    if (!response.ok) {
      return attachCacheScope(quotaResult({
        id: PRODUCT_ID,
        status: 'retryable_error',
        message: `OpenCode usage API returned HTTP ${response.status}`,
        fetchedAt: now,
      }), scope);
    }
    const meters = parseOpenCodeGoUsage(await response.json());
    return attachCacheScope(quotaResult({
      id: PRODUCT_ID,
      status: meters.length ? 'ok' : 'no_data',
      meters,
      message: meters.length ? undefined : 'OpenCode usage API returned no window',
      fetchedAt: now,
      dataAsOf: now,
    }), scope);
  } catch (error) {
    return attachCacheScope(quotaResult({
      id: PRODUCT_ID,
      status: 'retryable_error',
      message: error?.name === 'TimeoutError'
        ? 'OpenCode usage request timed out'
        : 'OpenCode usage request failed',
      fetchedAt: now,
    }), scope);
  }
}
