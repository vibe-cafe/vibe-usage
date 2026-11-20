import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const OUTPUT_LIMIT = 1024 * 1024;
const PORT = /listening on \w+ port at (\d+) for HTTPS\b/i;
const LOGIN_URL = /ANTIGRAVITY_OPEN_URL:|https:\/\/accounts\.google\.com\/o\/oauth2\b/i;
const LOGIN_MESSAGE = /\b(?:unauthenticated|unauthorized|auth_error|not[ _](?:logged[ _]in|signed[ _]in|authenticated)|(?:login|sign[ _-]in|authentication)[ _]required|please (?:log|sign) in)\b/i;
export const requiresLogin = text => LOGIN_MESSAGE.test(text) || LOGIN_URL.test(text);
const unavailable = () => new Error('Antigravity quota service unavailable');
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

// Every entry point owns its cwd, streams, time limit and process tree.
async function withProcess(binary, argsFor, { environment, timeoutMs, spawnImpl = spawn, desktopVersion }, read) {
  const directory = mkdtempSync(join(tmpdir(), 'vibe-usage-agy-quota-'));
  const controller = new AbortController();
  const abort = error => controller.abort(error);
  const onSignal = () => abort(new Interrupted());
  const timer = setTimeout(() => abort(new TimedOut('Antigravity quota service unavailable')), timeoutMs);
  let child, closed;
  try {
    child = spawnImpl(binary, argsFor(directory), {
      cwd: directory, detached: process.platform !== 'win32', windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: desktopVersion
        ? { ...environment, ANTIGRAVITY_GEMINI_DIR: directory, ANTIGRAVITY_VSCODE_HOST: '1' }
        : environment,
    });
    child.stdin.on('error', () => {});
    child.once('error', () => abort(unavailable()));
    closed = new Promise(resolve => child.once('close', resolve));
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    const interrupted = new Promise((_, reject) =>
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
    return await Promise.race([interrupted, read({ child, directory, closed, abort, signal: controller.signal })]);
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

export function runAntigravityCommand(binary, args, options) {
  return withProcess(binary, () => args, options, async ({ child, closed, abort }) => {
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
          if (LOGIN_URL.test(text) || (stream === child.stderr && /^Print mode: not logged in/im.test(text))) abort(new LoginRequired());
          tail = text.slice(-128);
        }
      });
      return chunks;
    }
    const stdout = capture(child.stdout);
    const stderr = capture(child.stderr);
    const code = await closed;
    return { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
  });
}

export function withAntigravitySession(binary, callback, {
  environment = process.env, timeoutMs = 20000, spawnImpl, desktopVersion,
} = {}) {
  const token = randomBytes(32).toString('hex');
  const argsFor = directory => desktopVersion ? [
    '--standalone', '--override_ide_name', 'antigravity', '--subclient_type', 'hub',
    '--override_ide_version', desktopVersion, '--override_user_agent_name', 'antigravity',
    '--https_server_port', '0', '--csrf_token', token, '--app_data_dir', 'antigravity',
    '--api_server_url', 'https://generativelanguage.googleapis.com',
    '--cloud_code_endpoint', 'https://daily-cloudcode-pa.googleapis.com', '--gemini_dir', directory,
  ] : [
    '--print', '', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--csrf_token', token, '--log-file', join(directory, 'cli.log'),
  ];
  return withProcess(binary, argsFor, { environment, timeoutMs, spawnImpl, desktopVersion },
    async ({ child, directory, closed, abort, signal }) => {
      let port;
      const inspect = text => {
        if (LOGIN_URL.test(text)) abort(new LoginRequired());
        port ||= Number(PORT.exec(text)?.[1]);
      };
      for (const stream of [child.stdout, child.stderr]) {
        if (!desktopVersion) {
          stream.resume(); // The CLI publishes its port in our --log-file.
          continue;
        }
        // Startup markers can straddle chunks. Keep only enough for a split marker.
        let tail = '';
        stream.on('data', chunk => {
          const text = tail + chunk.toString();
          inspect(text);
          tail = text.slice(-128);
        });
      }
      if (desktopVersion) child.stdin.end(); // The legacy CLI waits on an empty, open stdin.
      closed.then(() => abort(unavailable()));
      const logPath = join(directory, 'cli.log');
      const deadline = Date.now() + timeoutMs;
      while (!signal.aborted) {
        if (!desktopVersion && !port) {
          try {
            if (statSync(logPath).size > OUTPUT_LIMIT) throw unavailable();
            inspect(readFileSync(logPath, 'utf8'));
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (port && !signal.aborted) {
          const value = await callback({ port, token, timeoutMs: Math.min(2000, Math.max(1, deadline - Date.now())) });
          if (value !== undefined) return value;
        }
        await delay(150, undefined, { signal });
      }
      throw signal.reason;
    });
}
