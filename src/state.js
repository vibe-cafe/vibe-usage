import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';

// Persisted sync state, kept next to config.js's files (same dir + dev split).
// Maps a stable item key -> hash of its mutable fields, recording what we have
// already uploaded successfully. Lets each sync skip re-sending unchanged
// history: parsers stay stateless (still parse everything from disk every run),
// but only new/changed items hit the network.
// VIBE_USAGE_STATE_DIR overrides the dir (test hook).
const STATE_DIR = process.env.VIBE_USAGE_STATE_DIR?.trim() || join(homedir(), '.vibe-usage');
const isDev = process.env.VIBE_USAGE_DEV === '1';
const STATE_FILE = join(STATE_DIR, isDev ? 'state.dev.json' : 'state.json');

export function getStatePath() {
  return STATE_FILE;
}

export function loadState() {
  if (!existsSync(STATE_FILE)) return { buckets: {}, sessions: {} };
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    return {
      buckets: parsed.buckets ?? {},
      sessions: parsed.sessions ?? {},
    };
  } catch {
    // Corrupt/unreadable state must not lose data — treat as empty, which
    // triggers a one-time full re-upload (same as a fresh install).
    return { buckets: {}, sessions: {} };
  }
}

export function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  // Atomic replace: write to a unique temp file then rename over the target.
  // A crash mid-write can no longer truncate state.json into an unreadable
  // file that loadState() would treat as empty (triggering a full re-upload).
  const tempPath = `${STATE_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(state) + '\n', 'utf-8');
    renameSync(tempPath, STATE_FILE);
  } finally {
    // No-op after a successful rename (the temp file is already gone); cleans
    // up the partial write if writeFileSync threw.
    rmSync(tempPath, { force: true });
  }
}

// Drop all recorded upload state so the next sync re-uploads everything.
// Used by `reset` after deleting remote data — without it the incremental
// diff would find "nothing changed" and the re-sync would send zero bytes.
export function clearState() {
  try {
    unlinkSync(STATE_FILE);
  } catch (err) {
    // Already gone — same end state. Any other failure must surface: silently
    // keeping the file would make reset's re-sync upload zero unchanged items.
    if (err?.code !== 'ENOENT') throw err;
  }
}

// Composite key must mirror the server dedup key so a project rename or
// uploadProject toggle changes the key and naturally forces a re-send
// (server cleanup pass then reconciles the stale-named rows).
export function bucketKey(b) {
  return `${b.source}|${b.model}|${b.project}|${b.hostname}|${b.bucketStart}`;
}

export function bucketHash(b) {
  return hash([
    b.inputTokens || 0,
    b.outputTokens || 0,
    b.cachedInputTokens || 0,
    b.reasoningOutputTokens || 0,
    b.totalTokens || 0,
  ]);
}

export function sessionKey(s) {
  return `${s.source}|${s.sessionHash}`;
}

export function sessionHash(s) {
  return hash([
    s.project,
    s.hostname,
    s.firstMessageAt,
    s.lastMessageAt,
    s.durationSeconds,
    s.activeSeconds,
    s.messageCount,
    s.userMessageCount,
    (s.userPromptHours || []).join(','),
  ]);
}

// Bound state-file growth by dropping entries the parsers no longer emit
// (e.g. the user deleted old tool logs). We must NOT prune by age: an old
// bucket's hash never changes, so keeping it is exactly what stops it being
// re-uploaded forever — evicting it would defeat the whole point. `liveKeys`
// is the set of keys present in the current sync; anything not in it is dead.
//
// `okSources` (optional) scopes pruning to sources whose parser succeeded
// this run. A throwing parser emits no items, so without this guard its keys
// would look "dead" and get evicted — turning one transient failure into a
// full re-upload of that tool's history on the next sync.
export function pruneState(state, liveBucketKeys, liveSessionKeys, okSources) {
  const prunable = (key) =>
    !okSources || okSources.has(key.slice(0, key.indexOf('|')));
  for (const key of Object.keys(state.buckets)) {
    if (prunable(key) && !liveBucketKeys.has(key)) delete state.buckets[key];
  }
  for (const key of Object.keys(state.sessions)) {
    if (prunable(key) && !liveSessionKeys.has(key)) delete state.sessions[key];
  }
  return state;
}

function hash(parts) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}
