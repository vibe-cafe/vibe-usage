import { accessSync, closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { quotaResult } from '../schema.js';
import { cleanupAllowanceMs, setVariable, withProcess } from './child-process.js';

const PRODUCT_ID = 'grok';
const DEFAULT_MAX_LOG_BYTES = 2 * 1024 * 1024;
const BILLING_UNAVAILABLE = 'Grok billing service unavailable';
const OUTPUT_LIMIT = 1024 * 1024;
const GROK_ACCOUNT_REQUIRED = /billing (?:data )?requires auth(?:entication)? with grok\.com\b/i;
const LOGIN_REQUIRED = /auth(?:entication)? (?:is )?required|not (?:signed|logged) in/i;

function grokHome(environment, home) {
  const configured = environment.GROK_HOME?.trim();
  let root = configured || join(home, '.grok');
  if (root === '~') root = home;
  else if (root.startsWith('~/') || root.startsWith('~\\')) root = join(home, root.slice(2));
  return root;
}

export function grokBillingLogPath(environment = process.env, home = homedir()) {
  return join(grokHome(environment, home), 'logs', 'unified.jsonl');
}

export function findGrokBinary({ environment = process.env, home = homedir(), platform = process.platform } = {}) {
  const windows = platform === 'win32';
  const pathKey = windows ? Object.keys(environment).find(key => key.toUpperCase() === 'PATH') : 'PATH';
  const directories = [
    join(grokHome(environment, home), 'bin'),
    ...(environment[pathKey] || '').split(windows ? ';' : delimiter).filter(Boolean),
  ];
  if (!windows) directories.push(join(home, '.local', 'bin'));
  for (const directory of directories) {
    const path = resolve(directory, windows ? 'grok.exe' : 'grok');
    try {
      if (!statSync(path).isFile()) continue;
      if (!windows) accessSync(path, constants.X_OK);
      return path;
    } catch { /* Try the next installation. */ }
  }
  return null;
}

function readLogTail(path, maxBytes = DEFAULT_MAX_LOG_BYTES) {
  const descriptor = openSync(path, 'r');
  try {
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, maxBytes, DEFAULT_MAX_LOG_BYTES);
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
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
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

function tier(...values) {
  return values.find(value => typeof value === 'string' && value.trim())?.trim();
}

export function parseGrokBillingConfig(config, now = new Date()) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const startsAt = date(config.currentPeriod?.start || config.billingPeriodStart);
  const resetsAt = date(config.currentPeriod?.end || config.billingPeriodEnd);
  if (!startsAt || !resetsAt || startsAt >= resetsAt) return null;
  const windowSeconds = (resetsAt - startsAt) / 1000;
  const used = finiteNumber(config.used?.val ?? config.used);
  const limit = finiteNumber(config.monthlyLimit?.val ?? config.monthlyLimit);
  // Grok omits zero-valued fields, including the percentage for a fresh period.
  const utilization = finiteNumber(config.creditUsagePercent)
    ?? (used !== null && limit > 0 ? used / limit * 100 : 0);
  return {
    started: startsAt <= now,
    active: now < resetsAt,
    meters: [{
      id: 'subscription-credits',
      label: periodLabel(config.currentPeriod?.type, windowSeconds),
      utilization,
      resetsAt: resetsAt.toISOString(),
      windowSeconds,
    }],
    planLabel: tier(config.subscriptionTier),
  };
}

// Only the official CLI's billing events, newest first.
function* billingEvents(text) {
  if (typeof text !== 'string' || !text) return;
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
    if (event?.msg === 'billing: fetched credits config') yield event;
  }
}

export function parseGrokBillingLog(text, now = new Date()) {
  for (const event of billingEvents(text)) {
    const parsed = parseGrokBillingConfig(event.ctx?.config, now);
    const dataAsOf = date(event.ts);
    if (!parsed || !dataAsOf) continue;
    return {
      active: parsed.active, dataAsOf, meters: parsed.meters,
      planLabel: tier(event.ctx.subscriptionTier, parsed.planLabel),
    };
  }
  return null;
}

function logQuota(readLog, now) {
  let parsed;
  try {
    parsed = parseGrokBillingLog(readLog(), now);
  } catch (error) {
    const status = error?.code === 'ENOENT' ? 'no_data' : 'retryable_error';
    return quotaResult({
      id: PRODUCT_ID,
      status,
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

async function* rpcReplies(stdout, count, signal) {
  const decoder = new StringDecoder('utf8');
  let partial = '';
  try {
    for await (const chunk of stdout.iterator({ destroyOnReturn: false })) {
      count(chunk);
      signal.throwIfAborted();
      const lines = decoder.write(chunk).split('\n');
      lines[0] = partial + lines[0];
      partial = lines.pop();
      for (const line of lines) {
        let reply;
        try { reply = JSON.parse(line); } catch { continue; }
        if (reply?.jsonrpc === '2.0' && !('method' in reply)) yield reply;
      }
    }
  } finally {
    // Keep counting bytes already in the pipes while the process is stopped.
    stdout.on('data', count);
  }
}

export async function requestGrokBilling(binary, {
  environment = process.env, timeoutMs = 10_000, spawnImpl, platform = process.platform,
} = {}) {
  const protocolMs = timeoutMs - cleanupAllowanceMs(platform);
  if (protocolMs <= 0) throw new Error(BILLING_UNAVAILABLE);
  let bytes = 0;
  const answer = await withProcess(binary, () => ['agent', '--no-leader', 'stdio'], {
    prefix: 'vibe-usage-grok-quota-', environment, timeoutMs: protocolMs, spawnImpl,
    configureEnv: env => setVariable(env, 'GROK_DISABLE_AUTOUPDATER', '1'),
    failureMessage: BILLING_UNAVAILABLE,
  }, async ({ child, abort, signal }) => {
    function count(chunk) {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) abort(new Error(BILLING_UNAVAILABLE));
    }
    child.stderr.on('data', count);
    const send = (id, method, params) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    };
    let pending = 1;
    send(1, 'initialize', {
      protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    for await (const reply of rpcReplies(child.stdout, count, signal)) {
      if (reply.id !== pending) continue;
      if (reply.error) {
        const { code, message, data } = reply.error;
        if (pending === 1 || !Number.isInteger(code) || typeof message !== 'string') {
          throw new Error(BILLING_UNAVAILABLE);
        }
        // Grok 1.0.45 uses ACP's generic error message with a specific auth
        // explanation in data. Retain only the known billing distinction.
        if (code === -32000 && typeof data === 'string') {
          if (GROK_ACCOUNT_REQUIRED.test(data)) {
            return { error: { code, message: 'Billing data requires auth with grok.com.' } };
          }
          if (!GROK_ACCOUNT_REQUIRED.test(message) && LOGIN_REQUIRED.test(data)) {
            return { error: { code, message: 'Authentication required.' } };
          }
        }
        return { error: { code, message } };
      }
      if (!Object.hasOwn(reply, 'result')) throw new Error(BILLING_UNAVAILABLE);
      if (pending === 2) return { result: reply.result };
      pending = 2;
      send(2, '_x.ai/billing', {});
    }
    throw new Error(BILLING_UNAVAILABLE);
  });
  if (bytes > OUTPUT_LIMIT) throw new Error(BILLING_UNAVAILABLE);
  return answer;
}

export async function fetchGrokQuota({
  environment = process.env, home = homedir(), platform = process.platform, now = new Date(),
  egressGate = async () => null, grokBinary = findGrokBinary({ environment, home, platform }),
  maxLogBytes = DEFAULT_MAX_LOG_BYTES, spawnImpl, timeoutMs,
} = {}) {
  const readLog = () => readLogTail(grokBillingLogPath(environment, home), maxLogBytes);
  if (!grokBinary) return logQuota(readLog, now);
  const quota = fields => quotaResult({ id: PRODUCT_ID, fetchedAt: now, ...fields });
  const paused = await egressGate();
  if (paused) {
    const local = logQuota(readLog, now);
    const reason = { pauseReason: paused.pauseReason, egressRegion: paused.region };
    if (local.status === 'ok') return quota({ ...local, ...reason });
    return quota({ status: 'unsupported', message: paused.message, ...reason });
  }

  let answer;
  try {
    answer = await requestGrokBilling(grokBinary, { environment, platform, timeoutMs, spawnImpl });
  } catch {
    return logQuota(readLog, now);
  }
  const { error, result } = answer;
  if (error?.code === -32000) {
    if (GROK_ACCOUNT_REQUIRED.test(error.message)) {
      return quota({ status: 'no_data', emptyReason: 'sessionWithoutPlanLimits' });
    }
    if (LOGIN_REQUIRED.test(error.message)) {
      return quota({ status: 'unauthorized', message: 'Run grok login in a terminal to sign in.' });
    }
  }
  const parsed = parseGrokBillingConfig(result?.config ?? result, now);
  if (!parsed?.active || !parsed.started) return logQuota(readLog, now);
  let planLabel = tier(result.subscription_tier, result.subscriptionTier, parsed.planLabel);
  if (!planLabel) {
    // Grok also writes this call's tier to its billing event.
    try {
      const ctx = billingEvents(readLog()).next().value?.ctx;
      planLabel = tier(ctx?.subscriptionTier, ctx?.config?.subscriptionTier);
    } catch { /* The live meters stand on their own. */ }
  }
  return quota({ status: 'ok', meters: parsed.meters, planLabel });
}
