import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Disposable per-transcript summaries for the Claude Code parser, kept apart
// from ~/.vibe-usage/state.json exactly like the Codex cache: any miss,
// corruption or write failure falls back to reading the raw JSONL.
export const CLAUDE_CACHE_SCHEMA_VERSION = 1;
// Bump when the parser's interpretation of a transcript line changes. Every
// entry is discarded and the next run re-reads all transcripts (bounded by the
// non-interactive work budget), so keep bumps rare.
export const CLAUDE_PARSER_ALGORITHM_VERSION = 1;

const STALE_TEMP_MS = 60 * 60 * 1000;

function hash(value, length) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

export function claudeCacheEnabled() {
  return process.env.VIBE_USAGE_CLAUDE_CACHE !== '0';
}

export function claudeCacheDir() {
  const base = process.env.VIBE_USAGE_CACHE_DIR?.trim()
    || join(homedir(), '.vibe-usage', 'cache');
  return join(base, 'claude-code');
}

function entryName(filePath) {
  return `${hash(filePath, 32)}.json`;
}

export function fileSignature(stat) {
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    dev: String(stat.dev),
    ino: String(stat.ino),
  };
}

export function loadClaudeFileCache(filePath) {
  if (!claudeCacheEnabled()) return null;
  const path = join(claudeCacheDir(), entryName(filePath));
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed.schemaVersion !== CLAUDE_CACHE_SCHEMA_VERSION) return null;
    if (parsed.algorithmVersion !== CLAUDE_PARSER_ALGORITHM_VERSION) return null;
    if (parsed.filePath !== filePath) return null;
    if (!parsed.signature || !Number.isSafeInteger(parsed.parsedBytes) || !parsed.state) return null;
    return parsed;
  } catch {
    // A damaged entry is a performance miss, never a correctness failure.
    return null;
  }
}

/** Write one entry atomically. Failures are swallowed: the cache is optional. */
export function saveClaudeFileCache(filePath, data) {
  if (!claudeCacheEnabled()) return;
  const dir = claudeCacheDir();
  const path = join(dir, entryName(filePath));
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const payload = {
    schemaVersion: CLAUDE_CACHE_SCHEMA_VERSION,
    algorithmVersion: CLAUDE_PARSER_ALGORITHM_VERSION,
    filePath,
    ...data,
  };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(tempPath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, path);
  } catch {
    // Read-only home, full disk, a concurrent sync winning the rename: the
    // next run simply reads the transcript again.
  } finally {
    rmSync(tempPath, { force: true });
  }
}

/**
 * Drop entries whose transcript no longer exists (Claude Code deletes old
 * sessions after `cleanupPeriodDays`). Entries outside `livePaths` are only
 * removed after confirming their transcript is gone, so two processes that
 * discover different roots (a daemon with CLAUDE_CONFIG_DIR, an app without)
 * do not delete each other's entries on every run.
 */
export function pruneClaudeFileCache(livePaths) {
  if (!claudeCacheEnabled()) return;
  const dir = claudeCacheDir();
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const live = new Set([...livePaths].map(entryName));
  const now = Date.now();
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (name.endsWith('.tmp')) {
        // A killed writer leaves its unique temp file behind; a live writer's
        // file is minutes old at most.
        if (now - statSync(path).mtimeMs > STALE_TEMP_MS) rmSync(path, { force: true });
        continue;
      }
      if (!name.endsWith('.json') || live.has(name)) continue;
      let filePath = null;
      try {
        filePath = JSON.parse(readFileSync(path, 'utf8')).filePath;
      } catch {
        // Unreadable entry: useless either way.
      }
      if (typeof filePath !== 'string' || !existsSync(filePath)) rmSync(path, { force: true });
    } catch {
      // Best effort only.
    }
  }
}
