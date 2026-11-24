import { attachCacheScope } from '../cache.js';
import { quotaResult } from '../schema.js';

const PRODUCT_ID = 'zcode';
const BIGMODEL_USAGE_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit';
const ZAI_USAGE_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';

function credential(environment) {
  const bigModelToken = environment.BIGMODEL_API_KEY?.trim();
  if (bigModelToken) {
    return {
      token: bigModelToken,
      region: 'bigmodel',
      providerName: 'BigModel',
      usageURL: BIGMODEL_USAGE_URL,
    };
  }
  const zaiToken = environment.Z_AI_API_KEY?.trim();
  if (zaiToken) {
    return {
      token: zaiToken,
      region: 'zai',
      providerName: 'Z.ai',
      usageURL: ZAI_USAGE_URL,
    };
  }
  return null;
}

/** The URL a quota read requests (none without a key), chosen like the read. */
export function zaiNetworkURLs({ environment = process.env, usageURL } = {}) {
  const selected = credential(environment);
  return selected ? [usageURL || selected.usageURL] : [];
}

function integer(value) {
  return Number.isInteger(value) ? value : null;
}

function parseLimit(raw, now, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!['TOKENS_LIMIT', 'CREDIT_LIMIT', 'TIME_LIMIT'].includes(raw.type)) return null;
  const percentage = integer(raw.percentage);
  const unit = integer(raw.unit);
  const count = integer(raw.number);
  if (percentage === null || unit === null || count === null) return null;

  const usage = integer(raw.usage);
  const current = integer(raw.currentValue);
  const remaining = integer(raw.remaining);
  let utilization = percentage;
  if (usage !== null && usage > 0) {
    let used = current;
    if (remaining !== null) used = Math.max(usage - remaining, current ?? usage - remaining);
    if (used !== null) utilization = used * 100 / usage;
  }
  utilization = Math.max(0, Math.min(100, utilization));

  const minutesPerUnit = { 1: 1440, 3: 60, 5: 1, 6: 10080 };
  let windowMinutes = count > 0 ? count * (minutesPerUnit[unit] || 0) : 0;
  if (raw.type === 'TIME_LIMIT' && unit === 5 && count === 1) {
    // The API uses this marker for the monthly MCP pool.
    windowMinutes = 30 * 24 * 60;
  }
  const isFiveHour = raw.type !== 'TIME_LIMIT' && windowMinutes === 300;
  const resetMillis = integer(raw.nextResetTime);
  const plausibleReset = resetMillis !== null
    && (!isFiveHour || resetMillis <= now.getTime() + (5 * 3600 + 60) * 1000);
  const typeName = raw.type === 'TIME_LIMIT'
    ? 'MCP'
    : raw.type === 'CREDIT_LIMIT' ? 'Credits' : 'Tokens';
  let label = typeName;
  if (raw.type !== 'TIME_LIMIT' && windowMinutes === 300) label = '5h';
  else if (raw.type !== 'TIME_LIMIT' && windowMinutes === 10080) label = '7d';
  else if (raw.type !== 'TIME_LIMIT' && windowMinutes && windowMinutes % 1440 === 0) {
    label = `${windowMinutes / 1440}d`;
  }
  const meter = {
    id: `${index}-${raw.type.toLowerCase()}-${unit}-${count}`,
    label,
    utilization,
  };
  if (windowMinutes > 0) meter.windowSeconds = windowMinutes * 60;
  if (plausibleReset) meter.resetsAt = new Date(resetMillis).toISOString();
  return { meter, windowMinutes, type: raw.type };
}

export function parseZaiQuota(payload, now = new Date()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || payload.success !== true || payload.code !== 200
      || !payload.data || typeof payload.data !== 'object'
      || !Array.isArray(payload.data.limits)) {
    throw new Error('Invalid Z.ai quota response');
  }
  const parsed = payload.data.limits.map((raw, index) => parseLimit(raw, now, index)).filter(Boolean);
  const planLimits = parsed
    .filter(item => item.type === 'TOKENS_LIMIT' || item.type === 'CREDIT_LIMIT')
    .sort((a, b) => (a.windowMinutes || Number.MAX_SAFE_INTEGER)
      - (b.windowMinutes || Number.MAX_SAFE_INTEGER));
  const mcp = parsed.filter(item => item.type === 'TIME_LIMIT').pop();
  const ordered = [...planLimits];
  if (mcp) ordered.push(mcp);
  const planLabel = ['planName', 'plan', 'plan_type', 'packageName', 'level']
    .map(key => payload.data[key])
    .find(value => typeof value === 'string' && value.trim());
  return { meters: ordered.map(item => item.meter), planLabel: planLabel?.trim() };
}

export async function fetchZaiQuota({
  environment = process.env,
  fetchImpl = globalThis.fetch,
  usageURL,
  now = new Date(),
  timeoutMs = 10_000,
} = {}) {
  const selected = credential(environment);
  if (!selected) {
    return quotaResult({ id: PRODUCT_ID, status: 'missing_credentials',
      message: 'ZCode API key is not configured', fetchedAt: now });
  }
  const { token, region, providerName } = selected;
  const endpoint = usageURL || selected.usageURL;
  const cacheCredential = `${region}:${token}`;
  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      return quotaResult({ id: PRODUCT_ID, status: 'unauthorized',
        message: `${providerName} rejected the API key`, fetchedAt: now });
    }
    if (!response.ok) {
      return attachCacheScope(quotaResult({ id: PRODUCT_ID, status: 'retryable_error',
        message: `${providerName} quota API returned HTTP ${response.status}`, fetchedAt: now }),
      cacheCredential);
    }
    const { meters, planLabel } = parseZaiQuota(await response.json(), now);
    return attachCacheScope(quotaResult({ id: PRODUCT_ID, status: meters.length ? 'ok' : 'no_data',
      meters, planLabel, fetchedAt: now, dataAsOf: now }), cacheCredential);
  } catch (error) {
    return attachCacheScope(quotaResult({ id: PRODUCT_ID, status: 'retryable_error',
      message: error?.name === 'TimeoutError'
        ? `${providerName} quota request timed out`
        : `${providerName} quota request failed`,
      fetchedAt: now }), cacheCredential);
  }
}
