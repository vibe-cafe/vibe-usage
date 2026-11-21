import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, isAbsolute, resolve } from 'node:path';
import https from 'node:https';
import { quotaResult } from '../schema.js';
import { agyRequiresLogin, cleanupAllowanceMs, Interrupted, LoginRequired, runAntigravityCommand, TimedOut, withAntigravitySession } from './antigravity-process.js';

export { withAntigravitySession };

const QUOTA_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';
const MIN_PATH_MS = 3000;
const VERSION_AND_USAGE_MS = 6000;
const DESKTOP_READ_MS = 5000;

/** Fixed places to look for agy besides PATH. On Windows the official
 * installers (antigravity.google/cli/install.ps1 and install.cmd) put
 * `agy.exe` in `%LOCALAPPDATA%\agy\bin`, which reaches PATH only after
 * `agy install` edits the user environment, so a desktop app started before
 * that (autostart) never sees it on PATH. The Windows app's "detected" check
 * mirrors this list (`quota_product::antigravity_cli_paths`). */
export function antigravityInstallPaths(environment = process.env, home = homedir(), platform = process.platform) {
  const name = platform === 'win32' ? 'agy.exe' : 'agy';
  const localAppData = environment.LOCALAPPDATA?.trim();
  return [
    join(home, '.local', 'bin', name),
    ...(platform === 'darwin' ? ['/opt/homebrew/bin/agy', '/usr/local/bin/agy'] : []),
    ...(platform === 'win32' && localAppData ? [join(localAppData, 'agy', 'bin', name)] : []),
  ];
}

export function antigravityBinary(environment = process.env, home = homedir(), platform = process.platform) {
  const name = platform === 'win32' ? 'agy.exe' : 'agy';
  const override = environment.ANTIGRAVITY_CLI_PATH?.trim();
  const [userBin, ...installed] = antigravityInstallPaths(environment, home, platform);
  // PATH stays ahead of the installer default so an agy that works today keeps
  // being the one that runs.
  const candidates = override ? [override] : [
    userBin,
    ...(environment.PATH || '').split(platform === 'win32' ? ';' : delimiter)
      .filter(Boolean).map(root => join(root, name)),
    ...installed,
  ];
  return firstExecutable(candidates, platform);
}

function firstExecutable(candidates, platform) {
  return candidates.find(path => {
    if (!isAbsolute(path)) return false;
    try {
      accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
      return statSync(path).isFile();
    } catch { return false; }
  });
}

export function antigravityDesktopPaths(environment = process.env, home = homedir(), platform = process.platform) {
  if (platform === 'darwin') return ['/Applications', join(home, 'Applications')]
    .map(root => join(root, 'Antigravity.app', 'Contents', 'Resources', 'bin', 'language_server'));
  const local = environment.LOCALAPPDATA?.trim();
  return platform === 'win32' && local
    ? [join(local, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe')] : [];
}

function desktopVersion(binary, platform) {
  if (platform === 'darwin') {
    try {
      const plist = readFileSync(resolve(binary, '../../../Info.plist'), 'utf8');
      const match = /<key>CFBundleShortVersionString<\/key>\s*<string>\s*(\d+\.\d+\.\d+(?:\.\d+)?)\s*<\/string>/.exec(plist);
      if (match) return match[1];
    } catch { /* Some packages omit readable version metadata. */ }
  }
  return '2.33.0'; // Quota protocol verified with this desktop version.
}

// Older releases treat "/usage" as a billable prompt. Accept only an
// unambiguous release version from a successful --version invocation.
export function supportsAntigravityUsage(output) {
  const match = /^(?:(?:agy|antigravity(?: cli)?)(?: version)?\s+)?v?(\d+)\.(\d+)\.(\d+)(-[\w.-]+)?(?:\+[\w.-]+)?$/i.exec(output.trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (major !== 1) return major > 1;
  if (minor !== 1) return minor > 1;
  return patch > 11 || (patch === 11 && !match[4]);
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
      const weekly = bucket.window === 'weekly' || /weekly/i.test(id);
      const fiveHour = bucket.window === '5h' || /(?:^|-)5h$/.test(id);
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

const USAGE_LOGIN_CODES = new Set(['UNAUTHENTICATED', 'UNAUTHORIZED', 'AUTH_ERROR', 'LOGIN_REQUIRED', 'NOT_LOGGED_IN']);

function parseUsage({ code, stdout, stderr }) {
  let payload;
  try { payload = JSON.parse(stdout); } catch { /* Errors may be plain text. */ }
  if (code !== 0 || payload?.status !== 'SUCCESS') {
    const codes = [payload?.status, payload?.code, payload?.error, payload?.error?.code];
    if (codes.some(value => typeof value === 'string' && USAGE_LOGIN_CODES.has(value.toUpperCase()))
      || agyRequiresLogin(stdout) || agyRequiresLogin(stderr)) throw new LoginRequired();
    throw new Error('Antigravity usage command failed');
  }
  if (payload.command?.name !== 'usage' || !payload.command.data?.groups?.length) throw new Error('Missing usage command data');
  const groups = payload.command.data.groups.map(group => ({
    displayName: group.name,
    buckets: group.buckets.map(bucket => ({ bucketId: bucket.id, disabled: bucket.disabled,
      window: bucket.window, remainingFraction: bucket.remaining_fraction, resetTime: bucket.reset_time })),
  }));
  const meters = parseAntigravityQuota({ groups });
  if (!meters.length) throw new Error('Missing usage windows');
  return meters;
}

export function requestAntigravityQuota({ port, token, timeoutMs = 2000 }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local port');
  return new Promise((resolve, reject) => {
    // The self-signed exception is hard-coded to loopback. No remote URL or
    // redirect can receive this process-scoped CSRF token. A fresh agent, not
    // the global one: under NODE_USE_ENV_PROXY (which the Windows app sets)
    // Node 22.21+/24 sends even 127.0.0.1 through HTTPS_PROXY unless NO_PROXY
    // lists it, and a remote proxy cannot reach agy's loopback port.
    const request = https.request({ hostname: '127.0.0.1', port, path: QUOTA_PATH,
      method: 'POST', rejectUnauthorized: false, agent: new https.Agent(),
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
        if ([401, 403].includes(response.statusCode)) {
          resolve({ status: response.statusCode });
          return;
        }
        try { resolve({ status: response.statusCode, payload: JSON.parse(Buffer.concat(chunks)) }); }
        catch {
          if (response.statusCode === 200) reject(new Error('Invalid quota response'));
          else resolve({ status: response.statusCode });
        }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('Quota request timed out')), timeoutMs);
    request.once('close', () => clearTimeout(timer));
    request.once('error', reject);
    request.end('{}');
  });
}

export async function fetchAntigravityQuota({
  environment = process.env, home = homedir(), platform = process.platform,
  now = new Date(), timeoutMs = 20000, sessionImpl = withAntigravitySession,
  requestImpl = requestAntigravityQuota, commandImpl = runAntigravityCommand,
} = {}) {
  const result = (status, extra = {}) => quotaResult({ id: 'antigravity', status, fetchedAt: now, ...extra });
  const ok = meters => result('ok', { meters });
  const unauthorized = () => result('unauthorized', { message: 'Sign in to Antigravity and retry' });
  const retry = () => result('retryable_error', { message: 'Check the Antigravity connection and retry' });
  // Both clients allow 30s, including up to 10s for the Windows launcher.
  // Earlier attempts' cleanup consumes this same clock. Keep the final cleanup
  // allowance even on a desktop-only installation.
  const cleanupMs = cleanupAllowanceMs(platform);
  const deadline = performance.now() + Math.min(timeoutMs, 20000) - cleanupMs;
  function optionsFor({ reserve = 0, minimum = MIN_PATH_MS, cap = Infinity } = {}) {
    const available = Math.floor(deadline - performance.now()) - reserve;
    if (available < minimum) throw new TimedOut();
    return { environment, timeoutMs: Math.min(cap, available) };
  }

  async function readMeters(endpoint) {
    let response;
    try { response = await requestImpl(endpoint); } catch { return undefined; }
    if ([401, 403].includes(response.status) || response.payload?.code === 'unauthenticated') {
      throw new LoginRequired();
    }
    // An engine without this RPC cannot produce a later window. A service still
    // starting up (e.g. HTTP 503 or empty groups) keeps its full reading budget.
    if ([404, 405, 501].includes(response.status) || response.payload?.code === 'unimplemented') {
      throw new Error('Antigravity quota RPC unavailable');
    }
    if (response.status !== 200) return undefined;
    let meters;
    try { meters = parseAntigravityQuota(response.payload); } catch { return undefined; }
    if (meters.length) return meters;
    // The service can listen before its account and quota are ready.
  }

  const binary = antigravityBinary(environment, home, platform);
  const desktop = firstExecutable(antigravityDesktopPaths(environment, home, platform), platform);
  if (!binary && !desktop) return result('missing_credentials', { message: 'Install agy or Antigravity Desktop and sign in' });
  if (binary) {
    try {
      const meters = await sessionImpl(binary, readMeters, optionsFor());
      if (meters?.length) return ok(meters);
    } catch (error) {
      if (error instanceof LoginRequired) return unauthorized();
      if (error instanceof Interrupted) return retry();
    }

    try {
      // If /usage times out, its process must be gone before desktop can start.
      const reserve = desktop ? DESKTOP_READ_MS + cleanupMs : 0;
      const version = await commandImpl(binary, ['--version'], optionsFor({
        reserve, minimum: desktop ? VERSION_AND_USAGE_MS : MIN_PATH_MS, cap: 2000,
      }));
      if (version.code === 0 && supportsAntigravityUsage(version.stdout.trim() || version.stderr)) {
        const usage = await commandImpl(binary, ['-p', '/usage', '--output-format', 'json'],
          optionsFor({ reserve }));
        return ok(parseUsage(usage));
      }
    } catch (error) {
      if (error instanceof LoginRequired) return unauthorized();
      if (error instanceof Interrupted) return retry();
    }
  }

  if (desktop) {
    try {
      const version = desktopVersion(desktop, platform);
      return ok(await sessionImpl(desktop, readMeters, { ...optionsFor(), desktopVersion: version }));
    } catch (error) {
      if (error instanceof LoginRequired) return unauthorized();
    }
  }
  return retry();
}
