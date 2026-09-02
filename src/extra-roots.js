import { accessSync, closeSync, constants, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { codexSessionDirs } from './codex-roots.js';

export const EXTRA_ROOT_SOURCES = ['antigravity', 'codex', 'grok', 'pi-coding-agent'];

export function extraRootList(value) {
  return Array.isArray(value) ? value.filter(root => typeof root === 'string' && root.trim()) : [];
}

export function normalizeExtraRoot(value) {
  const trimmed = value.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

function isReadableDirectory(path) {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isCodexHome(path) {
  return isReadableDirectory(path) && codexSessionDirs(path).some(isReadableDirectory);
}

// Multica stores task-local Codex homes below a bounded
// <container>/<workspace>/<task>/codex-home hierarchy. Do not follow symlinks
// or descend beyond that shape: configured containers may also contain large
// workdirs that are unrelated to usage logs.
export function discoverCodexHomes(value, maxDepth = 3) {
  const root = normalizeExtraRoot(value);
  if (isCodexHome(root)) return { root, homes: [root], readable: true };
  if (!isReadableDirectory(root)) return { root, homes: [], readable: false };

  const homes = [];
  const queue = [{ path: root, depth: 0 }];
  let readable = true;
  while (queue.length > 0) {
    const current = queue.shift();
    let children;
    try {
      children = readdirSync(current.path, { withFileTypes: true });
    } catch {
      readable = false;
      continue;
    }
    for (const child of children) {
      // Dirent#isDirectory is false for symbolic links, so traversal stays
      // inside the explicitly selected tree.
      if (!child.isDirectory()) continue;
      const childPath = join(current.path, child.name);
      const depth = current.depth + 1;
      if (basename(childPath) === 'codex-home' && isCodexHome(childPath)) {
        homes.push(childPath);
        continue;
      }
      if (depth < maxDepth) queue.push({ path: childPath, depth });
    }
  }
  return { root, homes: [...new Set(homes)], readable };
}

export function grokSessionsDir(value) {
  return join(normalizeExtraRoot(value), 'sessions');
}

export function antigravityConversationDirs(value) {
  const root = normalizeExtraRoot(value);
  return [
    join(root, '.gemini', 'antigravity', 'conversations'),
    join(root, '.gemini', 'antigravity-cli', 'conversations'),
  ];
}

// Pi's own discoverable settings (PI_CODING_AGENT_SESSION_DIR, `sessionDir` in
// settings.json) name a sessions directory directly, and a harness that calls
// `pi --session <file>` writes bare session trees with no agent home above
// them. Accept either shape, but resolve to exactly one directory per root:
// the parser walks nested directories, so returning both a root and its
// `sessions/` child would read every file twice.
//
// The shape is re-resolved on every run rather than remembered from add-root
// time, and an unresolvable root returns null instead of falling back to the
// root itself. Falling back would turn an agent home that lost its `sessions/`
// child into a readable directory holding no sessions, i.e. exactly the silent
// zero this feature exists to prevent.
export function piSessionsDir(value) {
  const root = normalizeExtraRoot(value);
  const nested = join(root, 'sessions');
  if (isReadableDirectory(nested)) return nested;
  if (isReadableDirectory(root) && hasPiSessionJsonl(root)) return root;
  return null;
}

const PI_PROBE_BYTES = 16 * 1024;
const PI_PROBE_LINES = 10;

// A `.jsonl` extension proves nothing: an unrelated log would validate an
// entirely wrong directory, which the parser then ignores without complaining.
// Probe a bounded prefix for a record the Pi parser actually consumes — a
// `session` header, or a `message` entry for an appended-to store.
function looksLikePiSessionFile(filePath) {
  let text;
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const buffer = Buffer.alloc(PI_PROBE_BYTES);
    const read = readSync(fd, buffer, 0, PI_PROBE_BYTES, 0);
    text = buffer.subarray(0, read).toString('utf8');
    // A prefix read can cut the final line in half; drop the partial tail.
    if (read === PI_PROBE_BYTES) text = text.slice(0, text.lastIndexOf('\n') + 1);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch { /* already closed */ }
    }
  }

  let checked = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (++checked > PI_PROBE_LINES) return false;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    if (obj.type === 'session') return true;
    if (obj.type === 'message' && obj.message && typeof obj.message === 'object') return true;
  }
  return false;
}

// A session store is only recognizable by the Pi session files in it. Stay
// shallow: a configured root may sit next to large unrelated trees.
function hasPiSessionJsonl(dir, depth = 2) {
  let children;
  try {
    children = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  // Dirent#isDirectory is false for symbolic links, matching the parser's own
  // walk: linked session files are read, linked directories are not entered.
  const hasFile = children.some(child => (
    !child.isDirectory()
    && child.name.endsWith('.jsonl')
    && looksLikePiSessionFile(join(dir, child.name))
  ));
  if (hasFile) return true;
  if (depth <= 0) return false;
  return children.some(child => (
    child.isDirectory() && hasPiSessionJsonl(join(dir, child.name), depth - 1)
  ));
}

export function validateExtraRoot(source, value) {
  if (!EXTRA_ROOT_SOURCES.includes(source)) {
    return { ok: false, path: value, reason: `不支持的工具: ${source}` };
  }
  const path = normalizeExtraRoot(value);
  if (source === 'codex') {
    const result = discoverCodexHomes(path);
    return {
      ok: result.readable && result.homes.length > 0,
      path,
      reason: '需要是 Codex Home，或包含 */*/codex-home 的 Multica 容器',
    };
  }
  if (source === 'pi-coding-agent') {
    const sessionsDir = piSessionsDir(path);
    return {
      ok: sessionsDir !== null && hasPiSessionJsonl(sessionsDir),
      path,
      reason: '需要是直接包含 Pi 会话 .jsonl 的目录，或包含 sessions/ 的 Pi agent 目录',
    };
  }
  const dirs = source === 'grok'
    ? [grokSessionsDir(path)]
    : antigravityConversationDirs(path);
  return {
    ok: dirs.some(isReadableDirectory),
    path,
    reason: source === 'grok'
      ? '需要包含 sessions/'
      : '需要包含 .gemini/antigravity*/conversations/',
  };
}
