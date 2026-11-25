import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { quotaResult } from '../schema.js';

const PRODUCT_ID = 'grok';
const DEFAULT_MAX_LOG_BYTES = 2 * 1024 * 1024;

export function grokBillingLogPath(environment = process.env, home = homedir()) {
  const configured = environment.GROK_HOME?.trim();
  let root = configured || join(home, '.grok');
  if (root === '~') root = home;
  else if (root.startsWith('~/') || root.startsWith('~\\')) root = join(home, root.slice(2));
  return join(root, 'logs', 'unified.jsonl');
}

function readLogTail(path, maxBytes = DEFAULT_MAX_LOG_BYTES) {
  const descriptor = openSync(path, 'r');
  try {
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, maxBytes);
    if (length <= 0) return '';
    const buffer = Buffer.allocUnsafe(length);
    const offset = size - length;
    let total = 0;
    while (total < length) {
      const count = readSync(descriptor, buffer, total, length - total, offset + total);
      if (count <= 0) break;
      total += count;
    }
    let text = buffer.subarray(0, total).toString('utf8');
    // A bounded tail may begin in the middle of a UTF-8 JSON line. Drop only
    // that incomplete line; the CLI emits this billing snapshot repeatedly.
    if (offset > 0) {
      const newline = text.indexOf('\n');
      text = newline < 0 ? '' : text.slice(newline + 1);
    }
    return text;
  } finally {
    closeSync(descriptor);
  }
}

function finiteNumber(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function date(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function periodLabel(type, seconds) {
  if (type === 'USAGE_PERIOD_TYPE_DAILY') return '1d';
  if (type === 'USAGE_PERIOD_TYPE_WEEKLY') return '7d';
  if (type === 'USAGE_PERIOD_TYPE_MONTHLY') return 'Month';
  const days = seconds / 86_400;
  return Number.isInteger(days) && days > 0 ? `${days}d` : 'Credits';
}

/**
 * Reads only Grok CLI's structured, non-secret billing status event. Other log
 * messages are parsed only far enough to reject them and are never returned,
 * cached, logged, or uploaded by Vibe Usage.
 */
export function parseGrokBillingLog(text, now = new Date()) {
  if (typeof text !== 'string' || !text) return null;
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.msg !== 'billing: fetched credits config') continue;
    const config = event?.ctx?.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
    const utilization = finiteNumber(config.creditUsagePercent);
    const dataAsOf = date(event.ts);
    const startsAt = date(config.currentPeriod?.start || config.billingPeriodStart);
    const resetsAt = date(config.currentPeriod?.end || config.billingPeriodEnd);
    if (utilization === null || !dataAsOf || !startsAt || !resetsAt) continue;
    const windowSeconds = (resetsAt.getTime() - startsAt.getTime()) / 1000;
    if (windowSeconds <= 0) continue;
    const planLabel = [event.ctx?.subscriptionTier, config.subscriptionTier]
      .find(value => typeof value === 'string' && value.trim())?.trim();
    return {
      active: resetsAt > now,
      dataAsOf,
      meters: [{
        id: 'subscription-credits',
        label: periodLabel(config.currentPeriod?.type, windowSeconds),
        utilization,
        resetsAt: resetsAt.toISOString(),
        windowSeconds,
      }],
      planLabel,
    };
  }
  return null;
}

export function fetchGrokQuota({
  environment = process.env,
  home = homedir(),
  now = new Date(),
  maxLogBytes = DEFAULT_MAX_LOG_BYTES,
} = {}) {
  let parsed;
  try {
    parsed = parseGrokBillingLog(
      readLogTail(grokBillingLogPath(environment, home), maxLogBytes),
      now
    );
  } catch (error) {
    const status = error?.code === 'ENOENT' ? 'no_data' : 'retryable_error';
    return quotaResult({
      id: PRODUCT_ID,
      status,
      ...(status === 'no_data' ? { emptyReason: 'noLocalRecord' } : { failureReason: 'localRecordUnreadable' }),
      message: status === 'no_data'
        ? 'Grok billing status is not available yet'
        : 'Grok billing status could not be read',
      fetchedAt: now,
      source: 'local',
    });
  }
  if (!parsed || !parsed.active) {
    return quotaResult({
      id: PRODUCT_ID,
      status: 'no_data',
      emptyReason: parsed ? 'periodEnded' : 'noLocalRecord',
      message: 'Grok billing status is not available yet',
      fetchedAt: now,
      dataAsOf: parsed?.dataAsOf,
      source: 'local',
    });
  }
  return quotaResult({
    id: PRODUCT_ID,
    status: 'ok',
    meters: parsed.meters,
    planLabel: parsed.planLabel,
    fetchedAt: now,
    dataAsOf: parsed.dataAsOf,
    source: 'local',
  });
}
