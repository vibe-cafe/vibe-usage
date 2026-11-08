export const QUOTA_SCHEMA_VERSION = 1;

export const QUOTA_PRODUCT_IDS = Object.freeze([
  'kimi-code',
  'zcode',
  'grok',
  'opencode-go',
  'cursor',
  'antigravity',
]);

export const FETCHABLE_QUOTA_PRODUCT_IDS = Object.freeze([
  'kimi-code',
  'zcode',
  'grok',
  'opencode-go',
  'cursor',
  'antigravity',
]);

/**
 * Machine-readable "why there was no window" values, shared with the desktop
 * clients' `EmptyReason` (macOS `RateLimit.swift`) and additive within schema
 * v1: a client that does not know the field ignores it, and a client that does
 * can render the reason instead of a neutral empty state.
 */
export const QUOTA_EMPTY_REASONS = Object.freeze([
  'limitReached',
  'noWindow',
  'notEntitled',
  'sessionWithoutPlanLimits',
]);

const FETCH_STATUSES = new Set([
  'ok',
  'no_data',
  'missing_credentials',
  'expired_credentials',
  'unauthorized',
  'retryable_error',
  'unsupported',
]);

function finiteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return value;
}

function optionalISODate(value, name) {
  if (value === undefined || value === null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${name} must be an ISO date string`);
  }
  return date.toISOString();
}

export function normalizeMeter(raw, index = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(`meters[${index}] must be an object`);
  }
  const id = String(raw.id || '').trim();
  const label = String(raw.label || '').trim();
  if (!id || !label) throw new TypeError(`meters[${index}] needs id and label`);

  const utilization = Math.max(0, Math.min(100,
    finiteNumber(raw.utilization, `meters[${index}].utilization`)));
  const meter = { id, label, utilization };
  const resetsAt = optionalISODate(raw.resetsAt, `meters[${index}].resetsAt`);
  if (resetsAt) meter.resetsAt = resetsAt;
  if (raw.windowSeconds !== undefined && raw.windowSeconds !== null) {
    const seconds = finiteNumber(raw.windowSeconds, `meters[${index}].windowSeconds`);
    if (seconds > 0) meter.windowSeconds = seconds;
  }
  // Optional split of this meter's allowance (e.g. Cursor's Auto vs API),
  // shown only in the row's tooltip. Additive within schema v1.
  if (Array.isArray(raw.breakdown)) {
    const breakdown = raw.breakdown.flatMap((item, part) => {
      const partId = String(item?.id || '').trim();
      const partLabel = String(item?.label || '').trim();
      if (!partId || !partLabel) return [];
      return [{ id: partId, label: partLabel, utilization: Math.max(0, Math.min(100,
        finiteNumber(item.utilization, `meters[${index}].breakdown[${part}].utilization`))) }];
    });
    if (breakdown.length) meter.breakdown = breakdown;
  }
  return meter;
}

const PERIOD_LABELS = new Map([
  ['daily', { label: '1d', seconds: 24 * 60 * 60, exact: true }],
  ['day', { label: '1d', seconds: 24 * 60 * 60, exact: true }],
  ['weekly', { label: '7d', seconds: 7 * 24 * 60 * 60, exact: true }],
  ['week', { label: '7d', seconds: 7 * 24 * 60 * 60, exact: true }],
  ['monthly', { label: 'Month', seconds: 30 * 24 * 60 * 60, exact: false }],
  ['month', { label: 'Month', seconds: 30 * 24 * 60 * 60, exact: false }],
]);

function periodPresentation(meter) {
  const compact = meter.label.trim().toLowerCase().replace(/\s+/g, '');
  const alias = PERIOD_LABELS.get(compact);
  if (alias) {
    return {
      label: alias.label,
      seconds: meter.windowSeconds || alias.seconds,
      inferredWindowSeconds: alias.exact ? alias.seconds : undefined,
    };
  }

  const match = /^(\d+(?:\.\d+)?)(m|h|d|w)$/.exec(compact);
  if (!match) return null;
  const multipliers = { m: 60, h: 3600, d: 86400, w: 7 * 86400 };
  const seconds = meter.windowSeconds || Number(match[1]) * multipliers[match[2]];
  const label = compact === '1w' ? '7d' : compact;
  return { label, seconds, inferredWindowSeconds: seconds };
}

/**
 * Keep the compact desktop cards predictable across providers: generic time
 * windows come first from shortest to longest, followed by model-specific and
 * feature meters in their provider-defined order. The original index is the
 * final comparison key so the sort remains deterministic on every JS runtime.
 */
export function canonicalizeMeters(rawMeters) {
  return rawMeters
    .map((raw, index) => {
      const meter = normalizeMeter(raw, index);
      const period = periodPresentation(meter);
      if (period) {
        meter.label = period.label;
        if (!meter.windowSeconds && period.inferredWindowSeconds) {
          meter.windowSeconds = period.inferredWindowSeconds;
        }
      }
      return { meter, periodSeconds: period?.seconds, index };
    })
    .sort((left, right) => {
      const leftIsPeriod = left.periodSeconds !== undefined;
      const rightIsPeriod = right.periodSeconds !== undefined;
      if (leftIsPeriod !== rightIsPeriod) return leftIsPeriod ? -1 : 1;
      if (leftIsPeriod && left.periodSeconds !== right.periodSeconds) {
        return left.periodSeconds - right.periodSeconds;
      }
      return left.index - right.index;
    })
    .map(item => item.meter);
}

export function quotaResult({
  id,
  status,
  meters = [],
  planLabel,
  fetchedAt = new Date(),
  dataAsOf = fetchedAt,
  message,
  source = 'live',
  emptyReason,
}) {
  if (!FETCHABLE_QUOTA_PRODUCT_IDS.includes(id)) {
    throw new TypeError(`unsupported quota product: ${id}`);
  }
  if (!FETCH_STATUSES.has(status)) {
    throw new TypeError(`invalid quota status: ${status}`);
  }
  const result = {
    id,
    status,
    meters: canonicalizeMeters(meters),
    fetchedAt: new Date(fetchedAt).toISOString(),
    source,
  };
  const normalizedDataAsOf = optionalISODate(dataAsOf, 'dataAsOf');
  if (normalizedDataAsOf) result.dataAsOf = normalizedDataAsOf;
  if (typeof planLabel === 'string' && planLabel.trim()) result.planLabel = planLabel.trim();
  if (typeof message === 'string' && message.trim()) result.message = message.trim();
  if (emptyReason !== undefined && emptyReason !== null) {
    if (!QUOTA_EMPTY_REASONS.includes(emptyReason)) {
      throw new TypeError(`invalid quota emptyReason: ${emptyReason}`);
    }
    result.emptyReason = emptyReason;
  }
  return result;
}

export function quotaEnvelope(products) {
  return { schemaVersion: QUOTA_SCHEMA_VERSION, products };
}
