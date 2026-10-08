import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { moveDirectoryOutOfFilePath } from './path-repair.js';

// Persisted sync state, kept next to config.js's files (same dir + dev split).
// Maps a stable item key -> hash of its mutable fields, recording what we have
// already uploaded successfully. Lets each sync skip re-sending unchanged
// history: parsers stay stateless (still parse everything from disk every run),
// but only new/changed items hit the network.
// The file also records the upload target it belongs to (`identity`), so state
// left by a previous account can never suppress that account's history.
// VIBE_USAGE_STATE_DIR overrides the dir (test hook).
const STATE_DIR = process.env.VIBE_USAGE_STATE_DIR?.trim() || join(homedir(), '.vibe-usage');
const isDev = process.env.VIBE_USAGE_DEV === '1';
const STATE_FILE = join(STATE_DIR, isDev ? 'state.dev.json' : 'state.json');

export function getStatePath() {
  return STATE_FILE;
}

// The upload target this state belongs to: which server, and which account on
// it. state.json only records what was already uploaded *to that target*, so
// after a re-bind (`init` again, `config set apiKey`, or a desktop app
// rewriting config.json) the old hashes must not make sync skip history the new
// account has never received.
//
// The key is stored only as a fingerprint. The raw apiKey must never appear in
// state.json — it is an ordinary-permission file next to the parser state, not
// a credential store; config.json (mode 0600) remains the only place it lives.
export function stateIdentity({ apiUrl, apiKey } = {}) {
  return {
    apiUrl: apiUrl || '',
    keyFingerprint: apiKey
      ? createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16)
      : '',
  };
}

function isIdentity(value) {
  return !!value
    && typeof value === 'object'
    && typeof value.apiUrl === 'string'
    && typeof value.keyFingerprint === 'string';
}

function sameIdentity(a, b) {
  return a.apiUrl === b.apiUrl && a.keyFingerprint === b.keyFingerprint;
}

// `identity` is optional: callers that only read the recorded counts (e.g.
// `status`) pass nothing and keep the pre-0.11.1 behaviour of taking the file
// at face value.
export function loadState(identity) {
  if (!existsSync(STATE_FILE)) return { buckets: {}, sessions: {} };
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    const buckets = parsed.buckets ?? {};
    const sessions = parsed.sessions ?? {};
    if (!isIdentity(identity) || !isIdentity(parsed.identity)) {
      // No identity recorded — written by a CLI older than 0.11.1. Adopt the
      // entries as-is rather than forcing a re-upload: on upgrade day that
      // would make every installed client re-send its whole history at once.
      // The next saveState() stamps the current identity, so any later re-bind
      // is caught.
      return { buckets, sessions };
    }
    if (sameIdentity(parsed.identity, identity)) return { buckets, sessions };
    // Bound to a different account or server: nothing recorded here was ever
    // uploaded to the current target, so start empty and re-send local history.
    // `identityChanged` is a runtime signal for the caller, never persisted.
    return { buckets: {}, sessions: {}, identityChanged: true };
  } catch {
    // Corrupt/unreadable state must not lose data — treat as empty, which
    // triggers a one-time full re-upload (same as a fresh install).
    return { buckets: {}, sessions: {} };
  }
}

export function saveState(state, identity) {
  mkdirSync(STATE_DIR, { recursive: true });
  // Same EISDIR repair as config: a directory where the state file belongs
  // would block every save, and with it every incremental sync.
  moveDirectoryOutOfFilePath(STATE_FILE);
  // Only the durable fields are written: `identityChanged` is loadState()'s
  // one-run signal, not state. A CLI older than 0.11.1 reads just
  // buckets/sessions, so the extra top-level `identity` key is ignored there —
  // a file written by this version stays readable by older clients.
  const payload = {
    buckets: state.buckets ?? {},
    sessions: state.sessions ?? {},
  };
  if (isIdentity(identity)) {
    payload.identity = {
      apiUrl: identity.apiUrl,
      keyFingerprint: identity.keyFingerprint,
    };
  }
  // Atomic replace: write to a unique temp file then rename over the target.
  // A crash mid-write can no longer truncate state.json into an unreadable
  // file that loadState() would treat as empty (triggering a full re-upload).
  const tempPath = `${STATE_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(payload) + '\n', 'utf-8');
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
// uploadProject toggle changes the key and naturally forces a re-send under
// the new name. Nothing retires the row uploaded under the OLD key: ingest
// only upserts on (user_id, source, model, project, hostname, bucket_start),
// and there is no server-side reconciliation pass. The stale row survives
// until `vibe-usage reset` or a one-off server-side cleanup, so a rename
// double-counts tokens on the dashboard in the meantime. Verified against the
// server 2026-09-19; weigh this before changing what a parser reports.
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
    // Cache writes carry a different unit price per TTL, so a bucket whose only
    // change is a 5m<->1h reclassification must still re-upload — totalTokens
    // alone cannot see that move.
    b.cacheCreation5mTokens || 0,
    b.cacheCreation1hTokens || 0,
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
