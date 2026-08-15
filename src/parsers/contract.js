/**
 * Parser result contract.
 *
 * Every parser exports an async parse() returning either
 *   { buckets: object[], sessions: object[], skipped?: boolean, warnings?: string[], indexing?: object }
 * or a legacy bare buckets array.
 *
 * buckets entries are the aggregateToBuckets() output shape
 * ({ source, model, project, hostname?, bucketStart, inputTokens, ... }).
 * sessions entries are the extractSessions() output shape
 * ({ source, project, sessionHash, firstMessageAt, ... }).
 */

/**
 * Normalize a raw parser return value into a validated shape. Every emitted
 * item's source must match the registry key the parser is registered under;
 * rejecting a typo keeps that parser out of state pruning and prevents a
 * server-side dropped source from silently discarding its prior upload state.
 *
 * @param {string} source registry key
 * @param {unknown} result raw return value
 * @returns {{ buckets: object[], sessions: object[], skipped: boolean, warnings: string[], indexing?: object }}
 */
export function normalizeParserResult(source, result) {
  const buckets = Array.isArray(result) ? result : result?.buckets;
  const sessions = Array.isArray(result) ? [] : (result?.sessions || []);
  if (!Array.isArray(buckets) || !Array.isArray(sessions)) {
    throw new TypeError('Parser returned an invalid result');
  }

  for (const bucket of buckets) {
    if (bucket?.source !== source) {
      throw new TypeError(
        'parser ' + source + ' emitted a bucket with source=' + JSON.stringify(bucket?.source),
      );
    }
  }
  for (const session of sessions) {
    if (session?.source !== source) {
      throw new TypeError(
        'parser ' + source + ' emitted a session with source=' + JSON.stringify(session?.source),
      );
    }
  }

  const warnings = Array.isArray(result?.warnings) ? result.warnings.slice() : [];

  return {
    buckets,
    sessions,
    skipped: result?.skipped === true,
    warnings,
    ...(result?.indexing ? { indexing: result.indexing } : {}),
  };
}
