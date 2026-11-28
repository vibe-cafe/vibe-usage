import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeMeter, quotaResult } from './schema.js';

const CACHE_VERSION = 1;
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PLAN_AGE_MS = 24 * 60 * 60 * 1000;
const PLAN_RETRY_MS = 15 * 60 * 1000;

function cachePath(environment = process.env) {
  const root = environment.VIBE_USAGE_QUOTA_CACHE_DIR?.trim()
    || join(homedir(), '.vibe-usage');
  return join(root, 'quota-cache.json');
}

function loadDocument(environment) {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(environment), 'utf8'));
    if (!isRecord(parsed) || parsed.version !== CACHE_VERSION || !isRecord(parsed.products)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function quotaCacheScope(id, secret) {
  return createHash('sha256').update(`${id}\0${secret}`).digest('hex');
}

export function attachCacheScope(result, secret) {
  Object.defineProperty(result, 'cacheScope', { value: quotaCacheScope(result.id, secret), enumerable: false });
  return result;
}

export function loadCachedQuota(id, scope, environment = process.env, now = new Date()) {
  if (!scope) return null;
  const raw = loadDocument(environment)?.products?.[id];
  if (!raw || raw.scope !== scope || raw.status !== 'ok' || !Array.isArray(raw.meters)) return null;
  try {
    const dataAsOf = new Date(raw.dataAsOf || raw.fetchedAt);
    if (Number.isNaN(dataAsOf.getTime()) || now.getTime() - dataAsOf.getTime() > MAX_CACHE_AGE_MS) {
      return null;
    }
    const meters = raw.meters.map(normalizeMeter).filter(meter => {
      if (meter.resetsAt) return new Date(meter.resetsAt) > now;
      if (meter.windowSeconds) {
        return dataAsOf.getTime() + meter.windowSeconds * 1000 > now.getTime();
      }
      return true;
    });
    if (!meters.length) return null;
    return quotaResult({
      ...raw,
      id,
      status: 'ok',
      meters,
      source: 'cache',
      fetchedAt: raw.fetchedAt,
      dataAsOf: raw.dataAsOf || raw.fetchedAt,
    });
  } catch {
    return null;
  }
}

function updateDocument(environment, update) {
  try {
    // All disposable-cache work belongs inside the failure boundary, including
    // path resolution and updating a document recovered from disk.
    const path = cachePath(environment);
    const document = loadDocument(environment) || { version: CACHE_VERSION, products: {} };
    update(document);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // A read-only home must not turn a successful provider response into a CLI failure.
  }
}

export function saveCachedQuota(result, scope, environment = process.env) {
  if (result?.status !== 'ok' || !scope) return;
  updateDocument(environment, document => {
    document.products[result.id] = {
      id: result.id,
      status: 'ok',
      meters: result.meters,
      planLabel: result.planLabel,
      fetchedAt: result.fetchedAt,
      dataAsOf: result.dataAsOf,
      scope,
    };
  });
}

function freshCursorPlan(record, now) {
  const age = now - record?.checkedAt;
  return age >= 0 && age <= (record?.label ? PLAN_AGE_MS : PLAN_RETRY_MS);
}

export function saveCursorPlan(accountScope, label, checkedAt, environment) {
  updateDocument(environment, document => {
    const plans = Object.fromEntries(Object.entries(document.cursorPlans || {})
      .filter(([, plan]) => freshCursorPlan(plan, checkedAt)));
    plans[accountScope] = { checkedAt, label };
    document.cursorPlans = plans;
  });
}

export function loadCursorPlan(accountScope, meterScope, environment, now) {
  const document = loadDocument(environment);
  const record = document?.cursorPlans?.[accountScope];
  if (freshCursorPlan(record, now)) return record;
  // Before #216 every cached label came from a live web read. Adopt its
  // original timestamp once so subsequent meter refreshes cannot extend it.
  const old = document?.products.cursor;
  if (!document?.cursorPlans && old?.scope === meterScope && old.planLabel) {
    const legacy = { checkedAt: Date.parse(old.fetchedAt), label: old.planLabel };
    if (freshCursorPlan(legacy, now)) {
      saveCursorPlan(accountScope, legacy.label, legacy.checkedAt, environment);
      return legacy;
    }
  }
  return null;
}
