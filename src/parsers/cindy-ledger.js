import { findCindyDbPaths } from '../cindy-roots.js';
import { aggregateToBuckets } from './aggregate.js';
import { toCount } from './fs-utils.js';
import {
  isSqliteUnavailableError,
  queryDbJsonSnapshot,
  sqliteUnavailableError,
} from './sqlite.js';

const CINDY_USAGE_SQL = `
  SELECT
    day,
    agent_kind AS agentKind,
    model,
    SUM(input_tokens) AS inputTokens,
    SUM(output_tokens) AS outputTokens,
    SUM(cache_read_tokens) AS cacheReadTokens,
    SUM(cache_create_tokens) AS cacheCreateTokens
  FROM daily_model_usage
  GROUP BY day, agent_kind, model
  ORDER BY day, agent_kind, model
`;

/** Cindy stores its ledger day as local-time YYYY-MM-DD. */
export function dateFromCindyDay(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function skippedResult(error) {
  const message = error?.message || String(error);
  let reason = 'read failed';
  if (/database is locked/i.test(message)) reason = 'database is locked';
  else if (/no such column/i.test(message)) reason = 'incompatible database schema';
  else if (/unable to open|SQLITE_CANTOPEN/i.test(message)) reason = 'database unavailable';
  return {
    buckets: [],
    sessions: [],
    skipped: true,
    warnings: [`cindy: cannot read usage database (${reason})`],
  };
}

const CINDY_HARNESS_SOURCES = {
  codex: 'codex',
  pi: 'pi-coding-agent',
};

/**
 * Read Cindy's daily ledger for a harness that does not already expose the
 * same raw logs to Vibe Usage. Cindy's Claude Code SDK writes ordinary
 * ~/.claude transcripts, so Claude stays owned by the claude-code parser and
 * is deliberately absent from this map.
 */
export function readCindyHarnessUsage(agentKind) {
  const source = CINDY_HARNESS_SOURCES[agentKind];
  if (!source) throw new TypeError(`Unsupported Cindy harness: ${agentKind}`);

  const dbPaths = findCindyDbPaths();
  if (dbPaths.length === 0) return { buckets: [], sessions: [] };

  const rows = [];
  for (const dbPath of dbPaths) {
    try {
      rows.push(...queryDbJsonSnapshot(dbPath, CINDY_USAGE_SQL, {
        tempPrefix: 'vibe-usage-cindy-',
      }));
    } catch (error) {
      if (isSqliteUnavailableError(error)) throw sqliteUnavailableError('Cindy');
      // Cindy versions before the daily ledger was introduced have no usage
      // rows to import. A second, current regional/account database may still
      // be readable, so skip only this legacy database.
      if (/no such table:\s*daily_model_usage/i.test(error?.message || '')) continue;
      return skippedResult(error);
    }
  }

  const entries = [];
  for (const row of rows) {
    if (row.agentKind !== agentKind) continue;
    const timestamp = dateFromCindyDay(row.day);
    if (!timestamp) continue;
    const inputTokens = toCount(row.inputTokens) + toCount(row.cacheCreateTokens);
    const outputTokens = toCount(row.outputTokens);
    const cachedInputTokens = toCount(row.cacheReadTokens);
    if (inputTokens + outputTokens + cachedInputTokens === 0) continue;

    entries.push({
      source,
      model: typeof row.model === 'string' && row.model.trim()
        ? row.model.trim()
        : `${source}-unknown`,
      project: 'unknown',
      timestamp,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningOutputTokens: 0,
    });
  }

  return {
    buckets: aggregateToBuckets(entries),
    sessions: [],
  };
}

/**
 * Merge the optional Cindy ledger into the native harness snapshot. A failed
 * Cindy read marks the whole source skipped so its previously uploaded rows
 * are not pruned from incremental state.
 */
export function mergeCindyHarnessUsage(nativeResult, cindyResult) {
  const warnings = [
    ...(nativeResult.warnings || []),
    ...(cindyResult.warnings || []),
  ];
  if (nativeResult.skipped || cindyResult.skipped) {
    return {
      ...nativeResult,
      buckets: [],
      sessions: [],
      skipped: true,
      warnings,
    };
  }

  const entries = [];
  for (const bucket of [...nativeResult.buckets, ...cindyResult.buckets]) {
    const timestamp = new Date(bucket.bucketStart);
    if (Number.isNaN(timestamp.getTime())) continue;
    entries.push({
      ...bucket,
      timestamp,
    });
  }
  return {
    ...nativeResult,
    buckets: aggregateToBuckets(entries),
    sessions: nativeResult.sessions || [],
    warnings,
  };
}
