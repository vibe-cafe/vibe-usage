// State bucket keys are formatted as:
// source|model|project|hostname|bucketStart (src/state.js bucketKey)
//
// Magpie is an internal routing system that emits model aliases like
// "group/pi". When the local parser resolves these aliases into actual model
// names (info.magpie.resolved > 0), continuing to upload the new model into
// historical windows would create duplicate usage alongside the previously
// uploaded "group/*" row on the backend.
//
// Conversely, if Magpie local logs are pruned or rotated, the parser falls back
// to emitting "group/*" (info.magpie.unresolved > 0). If that same coordinate
// was previously uploaded with real model names, re-uploading "group/*" would
// also duplicate token counts.
//
// Both situations require freezing the historical coordinate: all buckets
// sharing that (source, project, hostname, bucketStart) coordinate are withheld
// from upload, and all recorded state keys at that coordinate are preserved so
// pruneState() never evicts them.

const MAGPIE_SOURCES = new Set(['omp', 'pi-coding-agent']);

function splitKey(key) {
  const firstPipe = key.indexOf('|');
  const secondPipe = key.indexOf('|', firstPipe + 1);
  const lastPipe = key.lastIndexOf('|');
  const secondLastPipe = key.lastIndexOf('|', lastPipe - 1);
  if (firstPipe === -1 || secondPipe === -1 || lastPipe === -1 || secondLastPipe === -1) {
    return null;
  }
  return {
    source: key.slice(0, firstPipe),
    model: key.slice(firstPipe + 1, secondPipe),
    project: key.slice(secondPipe + 1, secondLastPipe),
    hostname: key.slice(secondLastPipe + 1, lastPipe),
    bucketStart: key.slice(lastPipe + 1),
  };
}

function coordinateKey(source, project, hostname, bucketStart) {
  return `${source}|${project}|${hostname}|${bucketStart}`;
}

export function planMagpieMigration(buckets, state, parserInfos) {
  const bucketsByCoordinate = new Map();
  for (const b of buckets) {
    if (!MAGPIE_SOURCES.has(b.source)) continue;
    const coord = coordinateKey(b.source, b.project, b.hostname, b.bucketStart);
    let list = bucketsByCoordinate.get(coord);
    if (!list) {
      list = [];
      bucketsByCoordinate.set(coord, list);
    }
    list.push(b);
  }

  // Parse state keys only for MAGPIE_SOURCES
  const stateBySource = new Map();
  const stateKeys = state?.buckets ? Object.keys(state.buckets) : [];
  for (const key of stateKeys) {
    const firstPipe = key.indexOf('|');
    const source = firstPipe === -1 ? key : key.slice(0, firstPipe);
    if (!MAGPIE_SOURCES.has(source)) continue;

    const parsed = splitKey(key);
    if (!parsed) continue;

    let bySource = stateBySource.get(parsed.source);
    if (!bySource) {
      bySource = new Map();
      stateBySource.set(parsed.source, bySource);
    }
    const coord = coordinateKey(parsed.source, parsed.project, parsed.hostname, parsed.bucketStart);
    let list = bySource.get(coord);
    if (!list) {
      list = [];
      bySource.set(coord, list);
    }
    list.push({ key, ...parsed });
  }

  const frozenCoordinates = new Set();
  const preserveBuckets = new Set();
  const withheld = [];

  for (const source of MAGPIE_SOURCES) {
    const info = (parserInfos instanceof Map ? parserInfos.get(source) : null)
      ?? state?.parserMeta?.[source];
    const magpie = info?.magpie;
    const resolved = Number(magpie?.resolved) || 0;
    const unresolved = Number(magpie?.unresolved) || 0;
    const stateCoords = stateBySource.get(source);

    if (!stateCoords) continue;

    const sourceFrozenCoords = new Set();

    for (const [coord, entries] of stateCoords.entries()) {
      const hasStateGroup = entries.some(e => e.model.startsWith('group/'));
      const hasStateNonGroup = entries.some(e => !e.model.startsWith('group/'));

      let freeze = false;
      // Case 1: parser resolved at least one alias -> any legacy group coordinate in state must be frozen
      if (resolved > 0 && hasStateGroup) {
        freeze = true;
      }
      // Case 2: state contains uploaded real-model records; freeze on current group fallback,
      // on vanished coordinates, or on mixed coordinates to protect cloud ownership
      if (!freeze && (resolved > 0 || unresolved > 0) && hasStateNonGroup) {
        const currentBuckets = bucketsByCoordinate.get(coord) || [];
        const hasCurrentGroup = currentBuckets.some(b => b.model.startsWith('group/'));
        if (hasCurrentGroup || hasStateGroup || !currentBuckets.length) {
          freeze = true;
        }
      }

      if (freeze) {
        sourceFrozenCoords.add(coord);
        frozenCoordinates.add(coord);
        for (const e of entries) {
          preserveBuckets.add(e.key);
        }
      }
    }

    if (sourceFrozenCoords.size === 0) continue;

    // Tally withheld stats for this source across all frozen coordinates
    let sourceWithheldBuckets = 0;
    let sourceWithheldTokens = 0;
    const allStarts = [];

    // All current buckets on frozen coordinates for this source
    for (const coord of sourceFrozenCoords) {
      const currentBuckets = bucketsByCoordinate.get(coord) || [];
      for (const b of currentBuckets) {
        sourceWithheldBuckets++;
        sourceWithheldTokens += Number(b.totalTokens) || 0;
      }
      // Parse bucketStart from coordinate
      const lastPipe = coord.lastIndexOf('|');
      const startIso = coord.slice(lastPipe + 1);
      const timeMs = Date.parse(startIso);
      if (Number.isFinite(timeMs)) allStarts.push(timeMs);
    }

    // Also include any historical window starts in state that had no current bucket
    allStarts.sort((a, b) => a - b);
    const earliest = allStarts.length > 0 ? new Date(allStarts[0]).toISOString() : null;
    const latest = allStarts.length > 0 ? new Date(allStarts[allStarts.length - 1]).toISOString() : null;

    withheld.push({
      source,
      windows: sourceFrozenCoords.size,
      buckets: sourceWithheldBuckets,
      totalTokens: sourceWithheldTokens,
      earliest,
      latest,
    });
  }

  // Filter out any current bucket falling into a frozen coordinate
  const nextBuckets = buckets.filter(b => {
    if (!MAGPIE_SOURCES.has(b.source)) return true;
    const coord = coordinateKey(b.source, b.project, b.hostname, b.bucketStart);
    return !frozenCoordinates.has(coord);
  });

  return {
    buckets: nextBuckets,
    preserveBuckets,
    withheld,
  };
}
