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

// State bucket keys are `source|model|project|hostname|bucketStart`
// (state.js bucketKey). The one collector path that ever reported Kiki as
// kimi-code is Kiki's own kap-server export (`vibe-kimi-bucket-v1`): it uploads
// source `kimi-code` with project 'unknown' and hostname `kiki-<stream_id>`.
// Neither of those can ever equal the coordinates this CLI writes (the session
// project and the machine hostname), so an exact-key lookup alone silently
// misses that history and lets it double count. Treat a current Kiki bucket as
// legacy-overlapping when a `kimi-code|` state row shares its model and
// bucketStart but was recorded under a different project/hostname and its
// recorded hash differs from this CLI's own current Kimi-only hash for the
// coordinate. That hash guard keeps an unchanged genuine Kimi snapshot (or an
// unrelated Kimi history) from being mistaken for compatibility evidence.
function legacyBucketKeys(state, kikiBucket, kimiHashes) {
  const coordinate = bucketKey({ ...kikiBucket, source: 'kimi-code' });
  const keys = [];
  // Exact-key rule: the row uses this CLI's own coordinates, and its hash no
  // longer matches the genuine Kimi-only bucket (a changed or absent snapshot).
  if (coordinate in state.buckets && state.buckets[coordinate] !== kimiHashes.get(coordinate)) {
    keys.push(coordinate);
  }
  const [source, model] = coordinate.split('|');
  const bucketStart = coordinate.slice(coordinate.lastIndexOf('|') + 1);
  for (const key of Object.keys(state.buckets)) {
    if (!key.startsWith('kimi-code|')) continue;
    const parts = key.split('|');
    if (parts[0] !== source || parts[1] !== model || parts[parts.length - 1] !== bucketStart) continue;
    // Same model and window, but a different project/hostname: recorded by
    // something other than this CLI's own current Kimi snapshot. The coordinate
    // key itself is excluded here — it is the exact-key rule above.
    if (parts[2] === kikiBucket.project && parts[3] === kikiBucket.hostname) continue;
    if (state.buckets[key] === kimiHashes.get(coordinate)) continue;
    keys.push(key);
  }
  return keys;
}

// The unpublished compatibility collector reported Kiki as kimi-code. Its
// state contains hashes, not source contributions: overlap is a conservative
// migration signal, never proof that a particular Kimi bucket contains Kiki.
export function planKikiMigration(buckets, sessions, state, startAt) {
  const start = kikiStartTime(startAt);
  const kikiBuckets = buckets.filter(b => b.source === 'kiki');
  const kikiSessions = sessions.filter(s => s.source === 'kiki');
  const kimiHashes = new Map(buckets.filter(b => b.source === 'kimi-code').map(b => [bucketKey(b), bucketHash(b)]));
  const legacyBuckets = new Set();
  for (const b of kikiBuckets) {
    for (const key of legacyBucketKeys(state, b, kimiHashes)) legacyBuckets.add(key);
  }
  // Sessions are keyed `source|sessionHash`, so the collector's project and
  // hostname never enter the key — the exact rule already matches it.
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
  const nextBuckets = buckets.filter(b => b.source !== 'kiki' || (!blocked && (start === null || Date.parse(b.bucketStart) >= start)));
  // Freeze a session straddling the cut rather than upload its old timing
  // under a new source. All post-cut token records still contribute buckets.
  const nextSessions = sessions.filter(s => s.source !== 'kiki' || (!blocked && (start === null || Date.parse(s.firstMessageAt) >= start)));
  // Everything Kiki the plan drops — blocked rows, or rows before the cut —
  // is reported so the user learns real history is being withheld rather than
  // silently lost. `frozenBuckets`/`frozenSessions` count the kimi-code rows
  // this run holds at their recorded hash: their growth stops uploading, so
  // the server cell goes stale until the user resolves the migration.
  const plannedKikiBuckets = new Set(nextBuckets.filter(b => b.source === 'kiki'));
  const plannedKikiSessions = new Set(nextSessions.filter(s => s.source === 'kiki'));
  const withheldBuckets = kikiBuckets.filter(b => !plannedKikiBuckets.has(b));
  const withheldSessions = kikiSessions.filter(s => !plannedKikiSessions.has(s));
  const starts = withheldBuckets.map(b => Date.parse(b.bucketStart)).filter(Number.isFinite);
  return {
    blocked,
    preserveBuckets,
    preserveSessions,
    buckets: nextBuckets,
    sessions: nextSessions,
    withheld: {
      buckets: withheldBuckets.length,
      sessions: withheldSessions.length,
      totalTokens: withheldBuckets.reduce((sum, b) => sum + (Number(b.totalTokens) || 0), 0),
      earliest: starts.length > 0 ? new Date(Math.min(...starts)).toISOString() : null,
      latest: starts.length > 0 ? new Date(Math.max(...starts)).toISOString() : null,
    },
    frozenBuckets: preserveBuckets.size,
    frozenSessions: preserveSessions.size,
  };
}
