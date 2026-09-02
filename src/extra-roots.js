import { accessSync, closeSync, constants, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { codexSessionDirs } from './codex-roots.js';

export const EXTRA_ROOT_SOURCES = ['antigravity', 'codex', 'grok', 'pi-coding-agent'];

// Probing a candidate Pi store has three outcomes, never two: a confirmed
// session, a directory proven to hold none, and one that could not be read.
// Collapsing the last two into a single false is what let an unreadable subtree
// be treated as an empty one.
const PI_SESSIONS_FOUND = 'found';
const PI_SESSIONS_ABSENT = 'absent';
const PI_SESSIONS_UNREADABLE = 'unreadable';

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
// `sessions/` child would read every file twice. Canonical-path dedup in the
// parser makes the overlap harmless even for a mixed root that holds sessions
// directly *and* under `sessions/`.
//
// Every candidate is confirmed by content, never by name alone. A readable but
// unconfirmed `sessions/` child used to win unconditionally, so creating an
// empty `<root>/sessions` was enough to redirect the scan away from a bare
// store's own files — a successful sync reporting zero, which then pruned the
// source's incremental state.
//
// The shape is re-resolved on every run rather than remembered from add-root
// time, and an unresolvable root returns null instead of falling back to the
// root itself. Falling back would turn an agent home that lost its `sessions/`
// child into a readable directory holding no sessions, i.e. exactly the silent
// zero this feature exists to prevent.
//
// Probing is tri-state on purpose. A boolean collapsed "holds no sessions" into
// "could not be read", so making one sibling store unreadable was enough to
// make a container look like an agent home and narrow the scan to `sessions/`,
// dropping every readable sibling with no `skipped` flag. Absence has to be
// proven; where it is only assumed, resolution gives up and the caller skips.
export function piSessionsDir(value) {
  const root = normalizeExtraRoot(value);
  if (!isReadableDirectory(root)) return null;
  // A bare store is identified by the session files it holds directly, and
  // outranks any `sessions/` child: those files are what the user configured.
  const direct = probePiSessions(root, 0);
  if (direct === PI_SESSIONS_FOUND) return root;

  const outside = probePiSessionsOutsideNested(root);
  // Both decisions below rest on absence: that the root holds no sessions
  // directly, and that no sibling of `sessions/` holds any. An unreadable
  // candidate proves neither, so stop rather than narrow past it.
  if (direct === PI_SESSIONS_UNREADABLE || outside === PI_SESSIONS_UNREADABLE) return null;

  const nested = join(root, 'sessions');
  // Agent-home shape: narrowing to the child is only safe when every confirmed
  // session lives below it. A container whose per-task stores happen to include
  // one named `sessions` is still a container, and resolving it to that child
  // would drop all its siblings — the same silent undercount as above.
  if (
    outside === PI_SESSIONS_ABSENT
    && isReadableDirectory(nested)
    && probePiSessions(nested) === PI_SESSIONS_FOUND
  ) {
    return nested;
  }
  // A configured container holding per-task stores somewhere below it. Anything
  // else — no sessions at all, or a subtree that could not be read — resolves
  // to null, which the parser reports as skipped instead of as an empty sync.
  return probePiSessions(root) === PI_SESSIONS_FOUND ? root : null;
}

// Confirmed sessions in some child other than `sessions/`. The per-child depth
// is one less than the root scan's own so both reach the same files.
function probePiSessionsOutsideNested(root) {
  let children;
  try {
    children = readdirSync(root, { withFileTypes: true });
  } catch {
    return PI_SESSIONS_UNREADABLE;
  }
  let unreadable = false;
  for (const child of children) {
    if (!child.isDirectory() || child.name === 'sessions') continue;
    const probe = probePiSessions(join(root, child.name), 1);
    if (probe === PI_SESSIONS_FOUND) return PI_SESSIONS_FOUND;
    if (probe === PI_SESSIONS_UNREADABLE) unreadable = true;
  }
  return unreadable ? PI_SESSIONS_UNREADABLE : PI_SESSIONS_ABSENT;
}

const PI_PROBE_BYTES = 16 * 1024;
const PI_PROBE_LINES = 10;
// Roles the Pi parser turns into events; anything else contributes nothing.
const PI_MESSAGE_ROLES = new Set(['user', 'assistant', 'toolResult']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Pi's session format opens a store with a full SessionHeader. `version` is
// written as both a number and a string across real stores, so only its
// presence is required.
function isPiSessionHeader(obj) {
  return obj.type === 'session'
    && obj.version !== undefined
    && obj.version !== null
    && isNonEmptyString(obj.id)
    && isNonEmptyString(obj.timestamp)
    && typeof obj.cwd === 'string';
}

// A store an external harness appends to may carry no header inside the probed
// prefix, so a message record alone can confirm the directory — but only a
// complete one. Matching on `type` and an object-valued `message` accepted
// `{"type":"message","message":{}}`, which the parser reads to exactly zero.
function isPiSessionMessage(obj) {
  return obj.type === 'message'
    && isNonEmptyString(obj.id)
    && 'parentId' in obj
    && isNonEmptyString(obj.timestamp)
    && Boolean(obj.message)
    && typeof obj.message === 'object'
    && PI_MESSAGE_ROLES.has(obj.message.role);
}

// A `.jsonl` extension proves nothing: an unrelated log would validate an
// entirely wrong directory, which the parser then ignores without complaining.
// Neither does a bare `type` name — validation has to require the fields the
// parser reads, or a malformed lookalike is accepted and still syncs zero.
// A file that cannot be opened is reported as unreadable, not as "not a
// session": it may well be the store the user configured.
function probePiSessionFile(filePath) {
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
    return PI_SESSIONS_UNREADABLE;
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
    if (++checked > PI_PROBE_LINES) return PI_SESSIONS_ABSENT;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    if (isPiSessionHeader(obj) || isPiSessionMessage(obj)) return PI_SESSIONS_FOUND;
  }
  return PI_SESSIONS_ABSENT;
}

// A session store is only recognizable by the Pi session files in it. Stay
// shallow: a configured root may sit next to large unrelated trees.
//
// `found` outranks `unreadable`: one confirmed session is enough to resolve the
// shape, and the shared parser reports whatever it cannot read on the way in.
// `unreadable` outranks `absent`, so a caller never mistakes a subtree it could
// not open for one it proved empty.
function probePiSessions(dir, depth = 2) {
  let children;
  try {
    children = readdirSync(dir, { withFileTypes: true });
  } catch {
    return PI_SESSIONS_UNREADABLE;
  }
  let unreadable = false;
  // Dirent#isDirectory is false for symbolic links, matching the parser's own
  // walk: linked session files are read, linked directories are not entered.
  for (const child of children) {
    if (child.isDirectory() || !child.name.endsWith('.jsonl')) continue;
    const probe = probePiSessionFile(join(dir, child.name));
    if (probe === PI_SESSIONS_FOUND) return PI_SESSIONS_FOUND;
    if (probe === PI_SESSIONS_UNREADABLE) unreadable = true;
  }
  if (depth > 0) {
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const probe = probePiSessions(join(dir, child.name), depth - 1);
      if (probe === PI_SESSIONS_FOUND) return PI_SESSIONS_FOUND;
      if (probe === PI_SESSIONS_UNREADABLE) unreadable = true;
    }
  }
  return unreadable ? PI_SESSIONS_UNREADABLE : PI_SESSIONS_ABSENT;
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
    // piSessionsDir only returns a directory it has already confirmed by
    // content, so there is nothing left to re-check here.
    return {
      ok: piSessionsDir(path) !== null,
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
