import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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
export function setVariable(env, name, value) {
  for (const key of Object.keys(env)) if (key.toUpperCase() === name.toUpperCase()) delete env[key];
  env[name] = value;
}

// Every entry point owns its cwd, streams, time limit and process tree.
export async function withProcess(binary, argsFor, {
  prefix, configureEnv, environment = process.env, timeoutMs, spawnImpl = spawn, failureMessage,
}, read) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const controller = new AbortController();
  const abort = error => controller.abort(error);
  const onSignal = () => abort(new Interrupted());
  const timer = setTimeout(() => abort(new TimedOut(failureMessage)), timeoutMs);
  let child, closed;
  try {
    // Desktop apps can fetch ZCode in this same CLI invocation.
    const env = Object.fromEntries(Object.entries(environment)
      .filter(([key]) => !/^(BIGMODEL_API_KEY|Z_AI_API_KEY)$/i.test(key)));
    configureEnv(env, directory);
    child = spawnImpl(binary, argsFor(directory), {
      cwd: directory, detached: process.platform !== 'win32', windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], env,
    });
    child.stdin.on('error', () => {});
    child.once('error', () => abort(new Error(failureMessage)));
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
        if (!child.stdin.writableEnded) child.stdin.end();
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
