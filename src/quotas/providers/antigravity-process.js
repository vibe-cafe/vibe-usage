import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const OUTPUT_LIMIT = 1024 * 1024;
const PORT = /listening on \w+ port at (\d+) for HTTPS\b/i;
const LOGIN_URL = /ANTIGRAVITY_OPEN_URL:|https:\/\/accounts\.google\.com\/o\/oauth2\b/i;
// agy also logs "not authenticated, trying silent auth" before a successful login.
export const agyRequiresLogin = text => LOGIN_URL.test(text)
  || /Print mode: not logged in\b|cannot complete interactive login/i.test(text);
const unavailable = () => new Error('Antigravity quota service unavailable');
// Our own desktop engines carry this in their --gemini_dir; never treat one as the user's desktop.
const OWN_DIRECTORY = 'vibe-usage-agy-quota-';
export class LoginRequired extends Error {}
export class Interrupted extends Error {}
export class TimedOut extends Error {}

// Leave room for stopTree's two waits and rmSync's 100 + 200 + 300 ms retry delays.
export const cleanupAllowanceMs = platform => (platform === 'win32' ? 2000 : 750) + 500 + 600;

async function stopTree(child, closed) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, timeout: 2000 }, resolve));
    }
  } else {
    // The group can still have helpers even after its leader has exited.
    try { process.kill(-child.pid, 'SIGTERM'); } catch { return; }
    await Promise.race([closed, delay(750, undefined, { ref: false })]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Group already gone. */ }
  }
  await Promise.race([closed, delay(500, undefined, { ref: false })]);
}

/** Windows environment names are case-insensitive: drop every spelling before setting one. */
function setVariable(env, name, value) {
  for (const key of Object.keys(env)) if (key.toUpperCase() === name.toUpperCase()) delete env[key];
  env[name] = value;
}

/**
 * When silent sign-in fails (usually a network or keychain timeout while the
 * login is still valid), `agy -p` falls back to interactive OAuth and runs the
 * browser launcher it finds on PATH (CodexBar #4441, verified with agy 1.3.3).
 * Stubs that only leave a mark go first on PATH for our child, and BROWSER
 * points at one; the caller stops agy as soon as the mark appears. A launcher
 * agy reaches without PATH is not covered; the provider's persisted sign-in
 * block keeps that to at most one browser tab.
 */
function installBrowserStubs(directory, env, platform) {
  const bin = join(directory, 'browser-stubs');
  const mark = join(directory, 'browser-blocked');
  mkdirSync(bin, { mode: 0o700 });
  if (platform === 'win32') {
    // Inside double quotes cmd keeps & | < > ^ literal; only % and " would change the command.
    if (/["%\r\n]/.test(mark)) throw unavailable();
    writeFileSync(join(bin, 'rundll32.bat'), `@echo off\r\ntype nul > "${mark}"\r\nexit /b 1\r\n`);
  } else {
    if (/['\n]/.test(mark)) throw unavailable();
    for (const name of ['open', 'xdg-open', 'browser']) {
      const path = join(bin, name);
      writeFileSync(path, `#!/bin/sh\n: > '${mark}'\nexit 1\n`, { mode: 0o700 });
      chmodSync(path, 0o700);
    }
    setVariable(env, 'BROWSER', join(bin, 'browser'));
  }
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  const rest = env[pathKey];
  setVariable(env, pathKey, rest ? `${bin}${platform === 'win32' ? ';' : delimiter}${rest}` : bin);
  return mark;
}

// Every entry point owns its cwd, streams, time limit and process tree.
async function withProcess(binary, argsFor, {
  environment = process.env, timeoutMs, spawnImpl = spawn, desktopVersion, agy = false, platform = process.platform,
}, read) {
  const directory = mkdtempSync(join(tmpdir(), OWN_DIRECTORY));
  const controller = new AbortController();
  const abort = error => controller.abort(error);
  const onSignal = () => abort(new Interrupted());
  const timer = setTimeout(() => abort(new TimedOut('Antigravity quota service unavailable')), timeoutMs);
  let child, closed;
  try {
    // Desktop apps can fetch ZCode in this same CLI invocation. Windows env names are case-insensitive.
    const env = Object.fromEntries(Object.entries(environment)
      .filter(([key]) => !/^(BIGMODEL_API_KEY|Z_AI_API_KEY)$/i.test(key)));
    let browserMark;
    if (agy) {
      // Only in this child: the user's own agy keeps updating itself as configured.
      // The literal lowercase "true" is what agy honors (CodexBar #4739).
      setVariable(env, 'AGY_CLI_DISABLE_AUTO_UPDATE', 'true');
      browserMark = installBrowserStubs(directory, env, platform);
    }
    if (desktopVersion) {
      // Match --gemini_dir even when the caller set a login directory, so desktop migrations stay in our cwd.
      env.ANTIGRAVITY_GEMINI_DIR = directory;
      env.ANTIGRAVITY_VSCODE_HOST = '1';
    }
    child = spawnImpl(binary, argsFor(directory), {
      cwd: directory, detached: process.platform !== 'win32', windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], env,
    });
    child.stdin.on('error', () => {});
    child.once('error', () => abort(unavailable()));
    closed = new Promise(resolve => child.once('close', resolve));
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    const interrupted = new Promise((_, reject) =>
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
    if (browserMark) {
      void (async () => {
        while (!controller.signal.aborted) {
          if (existsSync(browserMark)) return abort(new LoginRequired());
          await delay(100, undefined, { signal: controller.signal, ref: false }).catch(() => {});
        }
      })();
    }
    return await Promise.race([interrupted, read({ child, directory, closed, abort, signal: controller.signal, browserMark })]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    try {
      if (child) {
        await stopTree(child, closed);
        child.stdin.destroy();
      }
    } finally {
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
      try { rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
    }
  }
}

/** Runs one official `agy` command (`--version`, `-p /usage`) to completion. */
export function runAntigravityCommand(binary, args, options) {
  return withProcess(binary, () => args, { ...options, agy: true }, async ({ child, closed, abort, browserMark }) => {
    child.stdin.end();
    let bytes = 0;
    function capture(stream) {
      const chunks = [];
      let tail = '';
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > OUTPUT_LIMIT) return abort(unavailable());
        chunks.push(chunk);
        // An unauthenticated CLI can wait for interactive input after its diagnostic.
        if (args.includes('/usage')) {
          const text = tail + chunk.toString();
          if (agyRequiresLogin(text)) abort(new LoginRequired());
          tail = text.slice(-128);
        }
      });
      return chunks;
    }
    const stdout = capture(child.stdout);
    const stderr = capture(child.stderr);
    const code = await closed;
    // agy can reach its launcher and exit before the next poll.
    if (existsSync(browserMark)) throw new LoginRequired();
    return { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
  });
}

/**
 * Starts the installed desktop `language_server` as our own short-lived engine,
 * reporting the desktop's real version, and reads its quota summary.
 */
export function withAntigravitySession(binary, callback, {
  environment = process.env, timeoutMs = 20000, spawnImpl, desktopVersion,
} = {}) {
  if (!desktopVersion) return Promise.reject(unavailable());
  const token = randomBytes(32).toString('hex');
  const argsFor = directory => [
    '--standalone', '--override_ide_name', 'antigravity', '--subclient_type', 'hub',
    '--override_ide_version', desktopVersion, '--override_user_agent_name', 'antigravity',
    '--https_server_port', '0', '--csrf_token', token, '--app_data_dir', 'antigravity',
    '--api_server_url', 'https://generativelanguage.googleapis.com',
    '--cloud_code_endpoint', 'https://daily-cloudcode-pa.googleapis.com', '--gemini_dir', directory,
  ];
  return withProcess(binary, argsFor, { environment, timeoutMs, spawnImpl, desktopVersion },
    async ({ child, closed, abort, signal }) => {
      let port;
      for (const stream of [child.stdout, child.stderr]) {
        // Only the Google OAuth URL or the desktop's open-URL marker is a login signal.
        let tail = '';
        stream.on('data', chunk => {
          const text = tail + chunk.toString();
          if (LOGIN_URL.test(text)) abort(new LoginRequired());
          port ||= Number(PORT.exec(text)?.[1]);
          tail = text.slice(-128);
        });
      }
      child.stdin.end();
      closed.then(() => abort(unavailable()));
      const deadline = Date.now() + timeoutMs;
      while (!signal.aborted) {
        if (port && !signal.aborted) {
          const value = await callback({ port, token, timeoutMs: Math.min(2000, Math.max(1, deadline - Date.now())) });
          if (value !== undefined) return value;
        }
        await delay(150, undefined, { signal });
      }
      throw signal.reason;
    });
}

function execFileText(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...options },
      (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

const CSRF = /--csrf_token[= ]+([0-9a-f-]{8,128})(?=\s|$)/i;

function serverFrom(pid, command) {
  if (!/antigravity/i.test(command) || !/language_server/i.test(command) || command.includes(OWN_DIRECTORY)) return null;
  const token = CSRF.exec(command)?.[1];
  return token && /^\d+$/.test(pid) ? { pid, token } : null;
}

/** `ps -axww -o pid=,uid=,command=` lines → the current user's desktop language servers. */
export function parseUnixProcessList(output, uid) {
  const servers = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match || (uid !== undefined && Number(match[2]) !== uid)) continue;
    const server = serverFrom(match[1], match[3]);
    if (server) servers.push(server);
  }
  return servers;
}

/** `lsof -Fn` output → listening TCP ports. */
export function parseLsofPorts(output) {
  const ports = new Set();
  for (const line of output.split('\n')) {
    const port = Number(/^n.*:(\d+)$/.exec(line.trim())?.[1]);
    if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port);
  }
  return [...ports];
}

const WINDOWS_SCRIPT = [
  '$s = (Get-Process -Id $PID).SessionId',
  'Get-CimInstance Win32_Process -Filter "Name LIKE \'language_server%\'" | Where-Object { $_.SessionId -eq $s } | ForEach-Object {',
  '  $ports = @(Get-NetTCPConnection -State Listen -OwningProcess $_.ProcessId -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalPort }) -join ","',
  '  "---"; "ProcessId=" + $_.ProcessId; "Ports=" + $ports; "CommandLine=" + $_.CommandLine',
  '}',
].join('\n');

/** The PowerShell records above → this session's desktop language servers with their listening ports. */
export function parseWindowsServers(output) {
  const servers = [];
  for (const record of output.split(/^---\s*$/m)) {
    const field = name => new RegExp(`^${name}=(.*)$`, 'm').exec(record)?.[1]?.trim() ?? '';
    const server = serverFrom(field('ProcessId'), field('CommandLine'));
    if (!server) continue;
    server.ports = [...new Set(field('Ports').split(',').map(Number)
      .filter(port => Number.isInteger(port) && port > 0 && port < 65536))];
    if (server.ports.length) servers.push(server);
  }
  return servers;
}

/**
 * Finds a running Antigravity desktop's own language servers: only local
 * process and socket tables, never the network. Each result is the process's
 * own loopback CSRF token (not an OAuth credential) and the ports that same
 * process listens on; the token is sent nowhere else.
 */
export async function findRunningAntigravityServers({
  platform = process.platform, execImpl = execFileText, uid = process.getuid?.(), timeoutMs = 5000,
} = {}) {
  try {
    if (platform === 'win32') {
      for (const shell of ['powershell.exe', 'pwsh.exe']) {
        try {
          return parseWindowsServers(await execImpl(shell, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT],
            { timeout: timeoutMs }));
        } catch { /* Try the next shell. */ }
      }
      return [];
    }
    if (platform !== 'darwin') return [];
    const servers = parseUnixProcessList(await execImpl('/bin/ps', ['-axww', '-o', 'pid=,uid=,command='],
      { timeout: 2000 }), uid);
    const lsof = existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';
    for (const server of servers) {
      try {
        server.ports = parseLsofPorts(await execImpl(lsof,
          ['-nP', '-a', '-p', server.pid, '-iTCP', '-sTCP:LISTEN', '-Fn'], { timeout: 2000 }));
      } catch { server.ports = []; }
    }
    return servers.filter(server => server.ports.length);
  } catch {
    return [];
  }
}
