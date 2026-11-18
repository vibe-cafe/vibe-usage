// Shared by the per-machine attribution cuts (Magpie, Codex Ultrafast). No
// imports on purpose: parsers load this through codex-ultrafast.js and must not
// pull in state.js or config.js, which bind their file paths at import time.

export const HALF_HOUR_MS = 1_800_000;

/** Split a state.json bucket key (`source|model|project|hostname|bucketStart`); a project may contain `|`. */
export function splitBucketKey(key) {
  const parts = key.split('|');
  return { source: parts[0], model: parts[1], project: parts.slice(2, -2).join('|'),
    hostname: parts.at(-2), bucketStart: parts.at(-1) };
}

/**
 * Where a per-machine attribution cut goes, from this machine's own upload
 * state: `undefined` (this run may not choose one -- a background service is
 * installed and this is not it, so an older resident collector may still be
 * uploading), the end of the current half hour right after the upload identity
 * changed (the local state no longer says what the account already holds), the
 * end of the latest uploaded window of `sources`, or 'none' (nothing uploaded:
 * all local history).
 */
export function chooseCutStartAt(state, sources, { daemonInstalled, surface, now = Date.now() }) {
  if (daemonInstalled && surface !== 'daemon') return undefined;
  if (state.identityChanged) return new Date((Math.floor(now / HALF_HOUR_MS) + 1) * HALF_HOUR_MS).toISOString();
  let latest = -Infinity;
  for (const key of Object.keys(state.buckets)) {
    const row = splitBucketKey(key);
    if (sources.has(row.source)) latest = Math.max(latest, Date.parse(row.bucketStart) || -Infinity);
  }
  return Number.isFinite(latest) ? new Date(latest + HALF_HOUR_MS).toISOString() : 'none';
}
