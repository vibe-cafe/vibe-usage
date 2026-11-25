import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { antigravityConversationDirs } from '../../extra-roots.js';
import { normalizeMeter } from '../schema.js';

/**
 * What the Antigravity quota reader remembers between runs (approved
 * 2026-11-24, 《Antigravity额度读取-封号风险与新做法》): Google is asked only
 * after Antigravity was used on this computer, at most once per 5 minutes,
 * with failures backing off from 5 minutes up to an hour. Never a credential,
 * account, or conversation content.
 */
const VERSION = 1;
export const ASK_INTERVAL_MS = 5 * 60 * 1000;
export const MAX_BACKOFF_MS = 60 * 60 * 1000;
const FAILURES = new Set(['retryable', 'unauthorized']);

export function antigravityStatePath(environment = process.env, home) {
  const root = environment.VIBE_USAGE_QUOTA_CACHE_DIR?.trim() || join(home, '.vibe-usage');
  return join(root, 'antigravity-quota.json');
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

export function emptyAntigravityState() {
  return { version: VERSION, reading: null, seen: null, attemptAt: null, failures: 0, failure: null,
    agyVersion: null, agyLoginBlocked: null };
}

/** A missing, unreadable or malformed file is a first run: every field is checked on its own. */
export function loadAntigravityState(path) {
  const state = emptyAntigravityState();
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return state; }
  if (!isRecord(raw) || raw.version !== VERSION) return state;
  if (isRecord(raw.reading) && isDate(raw.reading.readAt) && Array.isArray(raw.reading.meters)) {
    try {
      state.reading = { readAt: raw.reading.readAt, meters: raw.reading.meters.map(normalizeMeter),
        seen: isHash(raw.reading.seen) ? raw.reading.seen : null };
    } catch { /* A malformed reading is no reading. */ }
  }
  if (isHash(raw.seen)) state.seen = raw.seen;
  if (isDate(raw.attemptAt)) state.attemptAt = raw.attemptAt;
  if (Number.isInteger(raw.failures) && raw.failures > 0) state.failures = Math.min(raw.failures, 32);
  if (FAILURES.has(raw.failure)) state.failure = raw.failure;
  if (isRecord(raw.agyVersion) && typeof raw.agyVersion.binary === 'string'
    && typeof raw.agyVersion.supported === 'boolean') state.agyVersion = raw.agyVersion;
  if (isRecord(raw.agyLoginBlocked) && isHash(raw.agyLoginBlocked.cli)
    && typeof raw.agyLoginBlocked.binary === 'string') {
    state.agyLoginBlocked = { cli: raw.agyLoginBlocked.cli, binary: raw.agyLoginBlocked.binary,
      reason: raw.agyLoginBlocked.reason === 'login' ? 'login' : 'hang' };
  }
  if (!state.failure) state.failures = 0;
  return state;
}

/** Atomic and owner-only. Returns false when the record cannot be kept. */
export function saveAntigravityState(path, state) {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ ...state, version: VERSION })}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
    return true;
  } catch {
    return false;
  }
}

function fingerprint(directories) {
  const hash = createHash('sha256');
  let files = 0;
  directories.forEach((directory, index) => {
    let names;
    try { names = readdirSync(directory); } catch { return; }
    // `.db-shm` is left out on purpose: opening a store read-only (our own
    // sync does) touches it, while only a write changes `.db` / `.db-wal`.
    for (const name of names.filter(name => /\.(?:db|db-wal|pb)$/.test(name)).sort()) {
      try {
        const stat = statSync(join(directory, name));
        if (stat.isFile()) {
          hash.update(`${index}/${name}\0${stat.size}\0${stat.mtimeMs}\n`);
          files += 1;
        }
      } catch { /* Gone between listing and stat. */ }
    }
  });
  return { hash: hash.digest('hex'), files };
}

/**
 * "Used since the last read" in local terms: names, sizes and modification
 * times of the desktop, agy and IDE conversation stores. Nothing is opened.
 * `cli` covers agy's own store, which says whether agy itself worked again.
 */
export function antigravityActivity(home) {
  const [desktop, cli, ide] = antigravityConversationDirs(home);
  const all = fingerprint([desktop, cli, ide]);
  return { all: all.hash, files: all.files, cli: fingerprint([cli]).hash };
}

export function backoffMs(failures) {
  return failures > 0 ? Math.min(ASK_INTERVAL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS) : ASK_INTERVAL_MS;
}

/**
 * The last reading as of `now`. A window whose reset has passed is over:
 * while Antigravity sat unused (`idle`) it is back to 0% used, with its next
 * reset unknown; after use its new usage is unknown, so it is left out.
 * `dataAsOf` moves to that reset (the Mac app takes every Antigravity answer
 * as is, so a 0% it showed before that use goes away with the row).
 */
export function settledReading(reading, now, idle = true) {
  const readAt = Date.parse(reading.readAt);
  let asOf = readAt;
  const meters = reading.meters.flatMap(meter => {
    const reset = meter.resetsAt ? Date.parse(meter.resetsAt)
      : meter.windowSeconds ? readAt + meter.windowSeconds * 1000 : Infinity;
    if (!(reset <= now.getTime())) return [meter];
    asOf = Math.max(asOf, reset);
    if (!idle) return [];
    const { resetsAt: _, ...rest } = meter;
    return [{ ...rest, utilization: 0 }];
  });
  return { meters, dataAsOf: new Date(asOf) };
}
