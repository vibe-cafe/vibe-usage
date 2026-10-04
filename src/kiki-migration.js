import { bucketKey, bucketHash, sessionKey } from './state.js';

const HALF_HOUR_MS = 1_800_000;

export function kikiStartTime(value) {
  if (value === undefined) return null;
  const time = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:(?:00|30):00(?:\.000)?Z$/.test(value)
    ? Date.parse(value) : NaN;
  const canonical = typeof value === 'string' ? value.replace(/(?:\.000)?Z$/, '.000Z') : '';
  if (!Number.isSafeInteger(time) || time < 0 || time % HALF_HOUR_MS !== 0
    || new Date(time).toISOString() !== canonical) {
    throw new Error('kikiStartAt 必须是 UTC 半小时边界，例如 2026-10-05T12:30:00Z');
  }
  return time;
}

// The unpublished compatibility collector reported Kiki as kimi-code. Its
// state contains hashes, not source contributions: overlap is a conservative
// migration signal, never proof that a particular Kimi bucket contains Kiki.
export function planKikiMigration(buckets, sessions, state, startAt) {
  const start = kikiStartTime(startAt);
  const kikiBuckets = buckets.filter(b => b.source === 'kiki');
  const kikiSessions = sessions.filter(s => s.source === 'kiki');
  const kimiHashes = new Map(buckets.filter(b => b.source === 'kimi-code').map(b => [bucketKey(b), bucketHash(b)]));
  const legacyBuckets = new Set(kikiBuckets.map(b => bucketKey({ ...b, source: 'kimi-code' }))
    // An unchanged genuine Kimi-only bucket is not a compatibility signal.
    .filter(key => key in state.buckets && state.buckets[key] !== kimiHashes.get(key)));
  const legacySessions = new Set(kikiSessions.map(s => sessionKey({ ...s, source: 'kimi-code' }))
    .filter(key => key in state.sessions));
  const hasKikiState = [...Object.keys(state.buckets), ...Object.keys(state.sessions)]
    .some(key => key.startsWith('kiki|'));
  const overlapAfterCut = start !== null && [...legacyBuckets]
    .some(key => Date.parse(key.slice(key.lastIndexOf('|') + 1)) >= start);
  const blocked = !hasKikiState && (start === null
    ? legacyBuckets.size > 0 || legacySessions.size > 0 : overlapAfterCut);
  const migrating = blocked || start !== null;
  const preserveBuckets = migrating ? new Set([...legacyBuckets].filter(key => blocked
    || Date.parse(key.slice(key.lastIndexOf('|') + 1)) < start)) : new Set();
  const preserveSessions = migrating ? legacySessions : new Set();
  return {
    blocked,
    preserveBuckets,
    preserveSessions,
    buckets: buckets.filter(b => b.source !== 'kiki' || (!blocked && (start === null || Date.parse(b.bucketStart) >= start))),
    // Freeze a session straddling the cut rather than upload its old timing
    // under a new source. All post-cut token records still contribute buckets.
    sessions: sessions.filter(s => s.source !== 'kiki' || (!blocked && (start === null || Date.parse(s.firstMessageAt) >= start))),
  };
}
