import { accessSync, closeSync, constants, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, isAbsolute, resolve } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { quotaResult } from '../schema.js';
import {
  agyRequiresLogin, cleanupAllowanceMs, findRunningAntigravityServers, Interrupted, LoginRequired,
  runAntigravityCommand, TimedOut, withAntigravitySession,
} from './antigravity-process.js';
import {
  antigravityActivity, antigravityStatePath, backoffMs, loadAntigravityState, saveAntigravityState, settledReading,
} from './antigravity-state.js';

export { withAntigravitySession };

const QUOTA_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';
const MIN_PATH_MS = 3000;
const RUNNING_READ_MS = 4000;
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

function readVersion(text) {
  const version = typeof text === 'string' ? text.trim() : '';
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,40})?$/.test(version) ? version : undefined;
}

/** `package.json`'s version from an Electron `app.asar` (Chromium pickle header, then the files). */
export function asarPackageVersion(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const prefix = Buffer.alloc(16);
    if (readSync(fd, prefix, 0, 16, 0) !== 16 || prefix.readUInt32LE(0) !== 4) return undefined;
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    if (jsonSize > 16 * 1024 * 1024 || jsonSize > headerSize) return undefined;
    const json = Buffer.alloc(jsonSize);
    if (readSync(fd, json, 0, jsonSize, 16) !== jsonSize) return undefined;
    const entry = JSON.parse(json.toString('utf8'))?.files?.['package.json'];
    const offset = Number(entry?.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(entry.size)
      || entry.size <= 0 || entry.size > 1024 * 1024 || entry.unpacked) return undefined;
    const body = Buffer.alloc(entry.size);
    if (readSync(fd, body, 0, entry.size, 8 + headerSize + offset) !== entry.size) return undefined;
    return readVersion(JSON.parse(body.toString('utf8'))?.version);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

/**
 * The installed desktop's real version, reported to Google when we start its
 * engine. Unknown means the engine is not started: no version is made up.
 */
export function desktopVersion(binary, platform = process.platform) {
  if (platform === 'darwin') {
    try {
      const plist = readFileSync(resolve(binary, '../../../Info.plist'), 'utf8');
      const match = /<key>CFBundleShortVersionString<\/key>\s*<string>\s*([^<]*?)\s*<\/string>/.exec(plist);
      return readVersion(match?.[1]);
    } catch { return undefined; }
  }
  if (platform === 'win32') {
    const resources = resolve(binary, '..', '..');
    try {
      return readVersion(JSON.parse(readFileSync(join(resources, 'app', 'package.json'), 'utf8'))?.version)
        ?? asarPackageVersion(join(resources, 'app.asar'));
    } catch {
      return asarPackageVersion(join(resources, 'app.asar'));
    }
  }
  return undefined;
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

export function requestAntigravityQuota({ port, token, timeoutMs = 2000, scheme = 'https' }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local port');
  const transport = scheme === 'http' ? http : https;
  return new Promise((resolve, reject) => {
    // Hard-coded to loopback (the self-signed exception too). No remote URL or
    // redirect can receive this process-scoped CSRF token. A fresh agent, not
    // the global one: under NODE_USE_ENV_PROXY (which the Windows app sets)
    // Node 22.21+/24 sends even 127.0.0.1 through HTTPS_PROXY unless NO_PROXY
    // lists it, and the CLI's own tunnel replaces the global agents.
    const request = transport.request({ hostname: '127.0.0.1', port, path: QUOTA_PATH, method: 'POST',
      ...(scheme === 'http' ? { agent: new http.Agent() } : { rejectUnauthorized: false, agent: new https.Agent() }),
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

function binaryKey(binary) {
  try {
    const stat = statSync(binary);
    return `${binary}\0${stat.size}\0${stat.mtimeMs}`;
  } catch { return undefined; }
}

const quota = (status, now, extra = {}) => quotaResult({ id: 'antigravity', status, fetchedAt: now, ...extra });
const UNAUTHORIZED = { message: 'Sign in to Antigravity and retry' };
const RETRY = { message: 'Check the Antigravity connection and retry' };

/**
 * One read, in the order the maintainer set on 2026-11-24: the official
 * `agy -p /usage`, then a running desktop's own language server, and only
 * then a short-lived desktop engine of our own. Returns the result plus what
 * the caller should remember (agy's version check, an agy sign-in failure).
 */
export async function readAntigravityQuota({
  environment = process.env, platform = process.platform, now = new Date(), timeoutMs = 20000,
  binary, desktop, skipAgy = false, agyVersion = null,
  sessionImpl = withAntigravitySession, requestImpl = requestAntigravityQuota,
  commandImpl = runAntigravityCommand, discoverImpl = findRunningAntigravityServers,
} = {}) {
  // `agyUnusable`: agy asked for sign-in or hung (an interactive login can wait
  // a minute); the caller skips agy until agy itself is used again.
  const outcome = { agyVersion, agyUnusable: false };
  const done = (status, extra) => ({ ...outcome, result: quota(status, now, extra) });
  // Both clients allow 30s, including up to 10s for the Windows launcher.
  // Earlier attempts' cleanup consumes this same clock. Keep the final cleanup
  // allowance even on a desktop-only installation.
  const cleanupMs = cleanupAllowanceMs(platform);
  const deadline = performance.now() + Math.min(timeoutMs, 20000) - cleanupMs;
  const remaining = () => Math.floor(deadline - performance.now());
  function optionsFor({ reserve = 0, minimum = MIN_PATH_MS, cap = Infinity } = {}) {
    const available = remaining() - reserve;
    if (available < minimum) throw new TimedOut();
    return { environment, platform, timeoutMs: Math.min(cap, available) };
  }
  // Only local process and socket tables; nothing is sent until step 2.
  let found;
  const running = Promise.resolve().then(() => discoverImpl({ platform })).catch(() => [])
    .then(servers => (found = servers));
  const version = desktop ? desktopVersion(desktop, platform) : undefined;
  // A desktop that said "sign in" decides; a desktop that merely failed means
  // this was not a sign-in problem, whatever agy said earlier.
  let agyLogin = skipAgy, desktopLogin = false, desktopTried = false;

  // 1. The official, documented command.
  if (binary && !skipAgy) {
    // The later steps, if this installation has them, plus this step's own cleanup.
    const reserveFor = () => (desktop
      ? (found && !found.length ? 0 : RUNNING_READ_MS) + (version ? DESKTOP_READ_MS : 0) + cleanupMs : 0);
    let started = false;
    try {
      const key = binaryKey(binary);
      let supported = key && agyVersion?.binary === key ? agyVersion.supported : undefined;
      if (supported === undefined) {
        // Older releases treat "/usage" as a billable prompt.
        const version = await commandImpl(binary, ['--version'], optionsFor({ reserve: reserveFor(), cap: 2000 }));
        supported = version.code === 0 && supportsAntigravityUsage(version.stdout.trim() || version.stderr);
        if (version.code === 0 && key) outcome.agyVersion = { binary: key, supported };
      }
      if (supported) {
        // The local scan usually finishes first (about 50 ms on macOS); a short wait lets
        // a desktop that is not running hand its share of the time back to /usage.
        if (desktop && found === undefined) await Promise.race([running, delay(300, undefined, { ref: false })]);
        const options = optionsFor({ reserve: reserveFor() });
        started = true;
        const usage = await commandImpl(binary, ['-p', '/usage', '--output-format', 'json'], options);
        return done('ok', { meters: parseUsage(usage) });
      }
    } catch (error) {
      if (error instanceof LoginRequired) { agyLogin = true; outcome.agyUnusable = true; }
      else if (error instanceof TimedOut && started) outcome.agyUnusable = true;
      else if (error instanceof Interrupted) return done('retryable_error', RETRY);
    }
  }

  // 2. A desktop the user already has open: its own loopback service, no new process.
  for (const server of await running) {
    for (const port of server.ports) {
      for (const scheme of ['https', 'http']) {
        const limit = Math.min(RUNNING_READ_MS, remaining() - (version ? DESKTOP_READ_MS : 0));
        if (limit < 1000) break;
        let response;
        desktopTried = true;
        try {
          response = await requestImpl({ port, token: server.token, scheme, timeoutMs: limit });
        } catch { continue; } // Not this protocol on this port.
        // Only the quota service's own answer means the account; another port
        // of the same process can refuse the token with a bare 401/403.
        if (response.payload?.code === 'unauthenticated') return done('unauthorized', UNAUTHORIZED);
        if (response.status === 200) {
          try {
            const meters = parseAntigravityQuota(response.payload);
            if (meters.length) return done('ok', { meters });
          } catch { /* Not a quota summary. */ }
        }
        break; // This port answered; it is not the quota service.
      }
    }
  }

  // 3. Only when neither worked: the installed desktop engine, under its real version.
  if (version) {
    try {
      return done('ok', { meters: await sessionImpl(desktop, readMeters, { ...optionsFor(), desktopVersion: version }) });
    } catch (error) {
      if (error instanceof LoginRequired) desktopLogin = true;
      else if (error instanceof Interrupted) return done('retryable_error', RETRY);
      else desktopTried = true;
    }
  }
  if (desktopLogin || (agyLogin && !desktopTried)) return done('unauthorized', UNAUTHORIZED);
  return done('retryable_error', RETRY);

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
}

const NEVER_USED = { message: 'Use Antigravity once on this computer to show its quota' };
const NOT_YET = { message: 'Antigravity quota has not been read yet' };
const USED_SINCE = { message: 'Antigravity was used after its window reset; the next read shows it' };

/** What to show without asking Google: the remembered outcome. */
function rememberedResult(state, now, activity) {
  if (state.failure === 'unauthorized') return quota('unauthorized', now, UNAUTHORIZED);
  if (!state.reading) {
    if (state.failure) return quota('retryable_error', now, RETRY);
    return quota('no_data', now, activity?.files === 0 ? NEVER_USED : NOT_YET);
  }
  // A window that reset while Antigravity sat unused is full again; after use
  // its new usage is unknown until the next read, so it is not shown.
  const idle = activity?.all === state.reading.seen;
  const { meters, dataAsOf } = settledReading(state.reading, now, idle);
  if (!meters.length) return state.failure ? quota('retryable_error', now, RETRY) : quota('no_data', now, USED_SINCE);
  // After a failed read the numbers are the last good ones: the clients mark
  // `source: "cache"` as "live read failed".
  return quota('ok', now, { meters, dataAsOf, source: state.failure ? 'cache' : 'live' });
}

/**
 * Asks Google only when Antigravity was used since the last read (or there is
 * no good reading yet), at most once per 5 minutes, backing off after
 * failures; otherwise answers from the last reading. Approved 2026-11-24.
 */
export async function fetchAntigravityQuota(options = {}) {
  const {
    environment = process.env, home = homedir(), platform = process.platform, now = new Date(),
    readImpl = readAntigravityQuota, activityImpl = antigravityActivity,
    statePath = antigravityStatePath(environment, home), egressGate = async () => null,
  } = options;
  const binary = antigravityBinary(environment, home, platform);
  const desktop = firstExecutable(antigravityDesktopPaths(environment, home, platform), platform);
  if (!binary && !desktop) return quota('missing_credentials', now, { message: 'Install agy or Antigravity Desktop and sign in' });

  const state = loadAntigravityState(statePath);
  const before = activityImpl(home);
  const last = state.attemptAt ? Date.parse(state.attemptAt) : NaN;
  // A clock set back past the last attempt does not lock reading out.
  const waited = last <= now.getTime() ? now.getTime() - last : Infinity;
  const used = before.all !== state.seen;
  // Never used on this computer (no conversation at all): nothing to show, nothing asked.
  const wanted = before.files === 0 ? false
    : state.failure === 'unauthorized' ? used
    : state.failure === 'retryable' || !state.reading || used;
  if (!wanted || waited < backoffMs(state.failures)) return rememberedResult(state, now, before);

  // Every step below makes Google see the account. The egress check (the
  // network-privacy work, handed in by the registry) goes here: after every
  // rule that decides not to ask, so an answer from the record checks nothing.
  const paused = await egressGate();
  if (paused) {
    return quota('unsupported', now, {
      message: paused.message, pauseReason: paused.pauseReason, egressRegion: paused.region,
    });
  }

  // The check can take seconds: another process may have started a read meanwhile.
  const current = loadAntigravityState(statePath);
  if (current.attemptAt !== state.attemptAt) return rememberedResult(current, now, before);
  // Recorded first, so a second process in the same minute sees this attempt.
  state.attemptAt = now.toISOString();
  if (!saveAntigravityState(statePath, state)) {
    return state.reading ? rememberedResult(state, now, before) : quota('retryable_error', now, RETRY);
  }

  const key = binary && binaryKey(binary);
  const blocked = state.agyLoginBlocked;
  const skipAgy = Boolean(blocked && blocked.cli === before.cli && blocked.binary === key);
  const { result, agyVersion, agyUnusable } = await readImpl({
    ...options, environment, platform, now, binary, desktop, skipAgy, agyVersion: state.agyVersion,
  });

  // Taken after the read, so a read that touched a store cannot look like use.
  const after = activityImpl(home);
  state.seen = after.all;
  state.agyVersion = agyVersion ?? state.agyVersion;
  if (agyUnusable && key) state.agyLoginBlocked = { cli: after.cli, binary: key };
  else if (!skipAgy) state.agyLoginBlocked = null;
  if (result.status === 'ok') {
    state.reading = { readAt: now.toISOString(), meters: result.meters, seen: after.all };
    state.failures = 0;
    state.failure = null;
  } else {
    state.failures += 1;
    state.failure = result.status === 'unauthorized' ? 'unauthorized' : 'retryable';
    // Signed out: the numbers may belong to an account that is gone.
    if (state.failure === 'unauthorized') state.reading = null;
  }
  saveAntigravityState(statePath, state);
  if (result.status === 'ok' || state.failure === 'unauthorized' || !state.reading) return result;
  return rememberedResult(state, now, after);
}
