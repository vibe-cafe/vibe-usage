import { accessSync, constants, readdirSync, statSync } from 'node:fs';
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
export function piSessionsDir(value) {
  const root = normalizeExtraRoot(value);
  const nested = join(root, 'sessions');
  return isReadableDirectory(nested) ? nested : root;
}

// A session store is only recognizable by the JSONL files in it. Stay shallow:
// a configured root may sit next to large unrelated trees.
function hasSessionJsonl(dir, depth = 2) {
  let children;
  try {
    children = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  // Dirent#isDirectory is false for symbolic links, matching the parser's own
  // walk: linked session files are read, linked directories are not entered.
  if (children.some(child => !child.isDirectory() && child.name.endsWith('.jsonl'))) return true;
  if (depth <= 0) return false;
  return children.some(child => (
    child.isDirectory() && hasSessionJsonl(join(dir, child.name), depth - 1)
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
      ok: isReadableDirectory(sessionsDir) && hasSessionJsonl(sessionsDir),
      path,
      reason: '需要是直接包含会话 .jsonl 的目录，或包含 sessions/ 的 Pi agent 目录',
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
