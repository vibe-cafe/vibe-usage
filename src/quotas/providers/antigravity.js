import { accessSync, constants, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, isAbsolute } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { quotaResult } from '../schema.js';

const QUOTA_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';

export function antigravityBinary(environment = process.env, home = homedir(), platform = process.platform) {
  const name = platform === 'win32' ? 'agy.exe' : 'agy';
  const override = environment.ANTIGRAVITY_CLI_PATH?.trim();
  const candidates = override ? [override] : [
    join(home, '.local', 'bin', name),
    ...(environment.PATH || '').split(platform === 'win32' ? ';' : delimiter)
      .filter(Boolean).map(root => join(root, name)),
  ];
  return candidates.find(path => {
    if (!isAbsolute(path)) return false;
    try {
      accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
      return statSync(path).isFile();
    } catch { return false; }
  });
}

const isGeminiGroup = group => Array.isArray(group?.buckets)
  && group.buckets.some(bucket => bucket?.bucketId === 'gemini-5h' || bucket?.bucketId === 'gemini-weekly');

/** The card shows one family's 5h/7d like every other product: Gemini, the
 * default models, or the first family when a response has no Gemini group.
 * Every group is still validated so a malformed response is never shown. */
export function parseAntigravityQuota(payload) {
  if (payload?.code && payload.code !== 'ok' && payload.code !== 0) throw new Error('Quota API error');
  const summary = payload?.response ?? payload?.summary ?? payload;
  if (!Array.isArray(summary?.groups)) throw new Error('Missing quota groups');
  const families = [];
  const seen = new Set();
  for (const group of summary.groups) {
    if (!Array.isArray(group.buckets)) throw new Error('Invalid quota group');
    const family = typeof group.displayName === 'string'
      ? group.displayName.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0,80) : 'Antigravity';
    const meters = [];
    for (const bucket of group.buckets) {
      if (bucket.disabled === true) continue;
      const fraction = bucket.remainingFraction ?? bucket.remaining?.remainingFraction
        ?? (bucket.remaining?.case === 'remainingFraction' ? bucket.remaining.value : undefined);
      // Omitted fraction is unknown, never an exhausted or unused allowance.
      if (fraction === undefined || fraction === null) continue;
      if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
        throw new Error('Invalid quota fraction');
      }
      const id = bucket.bucketId;
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || seen.has(id)) {
        throw new Error('Invalid quota bucket identity');
      }
      seen.add(id);
      const weekly = /weekly/i.test(id);
      const fiveHour = /(?:^|-)5h$/.test(id);
      const reset = typeof bucket.resetTime === 'string' ? Date.parse(bucket.resetTime) : NaN;
      meters.push({ id, label: weekly ? '7d' : fiveHour ? '5h' : family, utilization: (1 - fraction) * 100,
        ...(Number.isFinite(reset) ? { resetsAt: new Date(reset).toISOString() } : {}),
        ...(weekly ? { windowSeconds: 604800 } : fiveHour ? { windowSeconds: 18000 } : {}) });
    }
    families.push({ gemini: isGeminiGroup(group), meters });
  }
  const shown = families.find(family => family.gemini) ?? families.find(family => family.meters.length);
  return (shown?.meters ?? [])
    .sort((a,b) => (a.windowSeconds || Infinity) - (b.windowSeconds || Infinity));
}

export function requestAntigravityQuota({ port, token, timeoutMs = 2000 }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local port');
  return new Promise((resolve, reject) => {
    // The self-signed exception is hard-coded to loopback. No remote URL or
    // redirect can receive this process-scoped CSRF token.
    const request = https.request({ hostname: '127.0.0.1', port, path: QUOTA_PATH,
      method: 'POST', rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': token } }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) { request.destroy(new Error('Oversized quota response')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, payload: JSON.parse(Buffer.concat(chunks)) }); }
        catch { reject(new Error('Invalid quota response')); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('Quota request timed out')), timeoutMs);
    request.once('close', () => clearTimeout(timer));
    request.once('error', reject);
    request.end('{}');
  });
}

/** Own one short-lived, prompt-free CLI process. Never attach to or stop the
 * user's agy, read its keychain, scrape its UI, or send model input. The CLI
 * owns its normal login/refresh. stdin stays open and empty until teardown. */
export async function withAntigravitySession(binary, callback, {
  environment = process.env, timeoutMs = 20000, spawnImpl = spawn,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'vibe-usage-agy-quota-'));
  const logPath = join(directory, 'cli.log');
  const token = randomBytes(32).toString('hex');
  let child, timer, launchError, closed = false;
  let closePromise = Promise.resolve();
  const terminate = () => {
    if (!child?.pid) return;
    if (process.platform === 'win32') {
      if (closed) return;
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, timeout: 2000 }, () => {});
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
    }
  };
  const onSignal = () => { terminate(); };
  try {
    child = spawnImpl(binary, ['--print', '', '--input-format', 'stream-json',
      '--output-format', 'stream-json', '--csrf_token', token, '--log-file', logPath], {
      cwd: directory, env: environment, stdio: ['pipe', 'ignore', 'ignore'],
      detached: process.platform !== 'win32', windowsHide: true,
    });
    child.stdin.on('error', () => {});
    closePromise = new Promise(resolve => {
      child.once('close', () => { closed = true; resolve(); });
      child.once('error', error => { launchError = error; });
    });
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    timer = setTimeout(terminate, timeoutMs);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !closed && !launchError) {
      let port;
      try {
        // Only our disposable startup log, never the user's chat/session logs.
        if (statSync(logPath).size > 1024 * 1024) throw new Error('Startup log too large');
        const text = readFileSync(logPath, 'utf8');
        port = Number(/listening on random port at (\d+) for HTTPS/.exec(text)?.[1]);
      } catch { /* The CLI has not opened its log yet. */ }
      if (port) {
        const value = await callback({ port, token, timeoutMs: Math.min(2000, Math.max(1, deadline - Date.now())) });
        if (value !== undefined) return value;
      }
      await delay(Math.min(200, Math.max(1, deadline - Date.now())));
    }
    throw new Error('Antigravity quota service unavailable');
  } finally {
    clearTimeout(timer);
    terminate();
    child?.stdin.destroy();
    await Promise.race([closePromise, delay(1000)]);
    if (!closed && child?.pid) {
      if (process.platform === 'win32') terminate();
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      await Promise.race([closePromise, delay(500)]);
    }
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function fetchAntigravityQuota({
  environment = process.env, home = homedir(), platform = process.platform,
  now = new Date(), timeoutMs = 20000, sessionImpl = withAntigravitySession,
  requestImpl = requestAntigravityQuota,
} = {}) {
  const result = (status, extra = {}) => quotaResult({ id: 'antigravity', status, fetchedAt: now, ...extra });
  const binary = antigravityBinary(environment, home, platform);
  if (!binary) return result('missing_credentials', { message: 'Install agy and sign in, then retry' });
  try {
    return await sessionImpl(binary, async endpoint => {
      let response;
      try { response = await requestImpl(endpoint); } catch { return undefined; }
      if ([401,403].includes(response.status) || response.payload?.code === 'unauthenticated') {
        return result('unauthorized', { message: 'Sign in with agy, then retry' });
      }
      if (response.status !== 200) return undefined;
      let meters;
      try { meters = parseAntigravityQuota(response.payload); } catch { return undefined; }
      if (!meters.length) return undefined; // Startup may precede keyring login.
      // No disk cache: process-owned credentials are opaque, so we cannot bind
      // a stale snapshot to the current account safely.
      return result('ok', { meters });
    }, { environment, timeoutMs });
  } catch {
    return result('retryable_error', { message: 'Open agy, sign in and check its connection, then retry' });
  }
}
