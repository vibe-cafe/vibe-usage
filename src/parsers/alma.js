import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { getAlmaDbPath } from '../tools.js';
import { aggregateToBuckets } from './aggregate.js';
import { toCount } from './fs-utils.js';
import { queryDbJson, sqliteUnavailableError, isSqliteUnavailableError } from './sqlite.js';

export { getAlmaDbPath as resolveAlmaDbPath };

export function normalizeAlmaModel(value) {
  if (typeof value !== 'string') return 'unknown';
  const model = value.trim();
  if (!model) return 'unknown';
  const separator = model.lastIndexOf(':');
  if (separator === -1) return model;
  return model.slice(separator + 1).trim() || 'unknown';
}

const ALMA_USAGE_SQL = `
  SELECT
    usage_records.model AS model,
    usage_records.timestamp AS timestamp,
    usage_records.input_tokens AS inputTokens,
    usage_records.output_tokens AS outputTokens,
    usage_records.cached_input_tokens AS cachedInputTokens,
    usage_records.reasoning_tokens AS reasoningOutputTokens,
    usage_records.cache_write_input_tokens AS cacheWriteInputTokens,
    workspaces.name AS workspaceName
  FROM usage_records
  LEFT JOIN chat_threads ON chat_threads.id = usage_records.thread_id
  LEFT JOIN workspaces ON workspaces.id = chat_threads.workspace_id
`;

function safeWorkspaceName(value) {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return basename(normalized) || 'unknown';
}

function skippedResult(error) {
  const message = error?.message || String(error);
  let reason = message;
  if (/database is locked/i.test(message)) reason = 'database is locked';
  else if (/no such (table|column)/i.test(message)) reason = 'incompatible database schema';
  return {
    buckets: [],
    sessions: [],
    skipped: true,
    warnings: [`alma: cannot read usage database (${reason})`],
  };
}

export async function parse() {
  const dbPath = getAlmaDbPath();
  if (!existsSync(dbPath)) return { buckets: [], sessions: [] };

  let rows;
  try {
    rows = queryDbJson(dbPath, ALMA_USAGE_SQL);
  } catch (error) {
    if (isSqliteUnavailableError(error)) throw sqliteUnavailableError('Alma');
    return skippedResult(error);
  }

  const entries = [];
  for (const row of rows) {
    const timestamp = new Date(row.timestamp);
    if (Number.isNaN(timestamp.getTime())) continue;

    const inputTokens = toCount(row.inputTokens) + toCount(row.cacheWriteInputTokens);
    const outputTokens = toCount(row.outputTokens);
    const cachedInputTokens = toCount(row.cachedInputTokens);
    const reasoningOutputTokens = toCount(row.reasoningOutputTokens);
    if (inputTokens + outputTokens + cachedInputTokens + reasoningOutputTokens === 0) continue;

    entries.push({
      source: 'alma',
      model: normalizeAlmaModel(row.model),
      project: safeWorkspaceName(row.workspaceName),
      timestamp,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningOutputTokens,
    });
  }

  return {
    buckets: aggregateToBuckets(entries),
    // Alma's usage ledger contains assistant responses only. Reconstructing
    // user turns would require reading chat records outside the usage contract.
    sessions: [],
  };
}
