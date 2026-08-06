import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { getAlmaDbPath } from '../tools.js';
import { aggregateToBuckets } from './index.js';
import { queryDbJson } from './sqlite.js';

export { getAlmaDbPath as resolveAlmaDbPath };

function safeWorkspaceName(value) {
  if (typeof value !== 'string') return 'unknown';
  const name = value.trim();
  if (!name) return 'unknown';
  const normalized = name.replace(/\\/g, '/').replace(/\/+$/, '');
  return basename(normalized) || 'unknown';
}

export const ALMA_USAGE_SQL = `
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

function skippedResult(err) {
  const message = err?.message || String(err);
  let reason = message;
  if (err?.status === 127 || /ENOENT/i.test(message)) {
    reason = 'SQLite unavailable; install sqlite3 or use Node >= 22.5';
  } else if (/database is locked/i.test(message)) {
    reason = 'database is locked';
  } else if (/no such (table|column)/i.test(message)) {
    reason = 'incompatible database schema';
  }
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
  } catch (err) {
    return skippedResult(err);
  }

  const entries = [];
  for (const row of rows) {
    const timestamp = new Date(row.timestamp);
    if (Number.isNaN(timestamp.getTime())) continue;

    const inputTokens = (Number(row.inputTokens) || 0) + (Number(row.cacheWriteInputTokens) || 0);
    const outputTokens = Number(row.outputTokens) || 0;
    const cachedInputTokens = Number(row.cachedInputTokens) || 0;
    const reasoningOutputTokens = Number(row.reasoningOutputTokens) || 0;
    if (inputTokens + outputTokens + cachedInputTokens + reasoningOutputTokens <= 0) continue;

    entries.push({
      source: 'alma',
      model: row.model || 'unknown',
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
    // usage_records represents assistant responses only. Without reading message
    // content or metadata, Alma cannot safely reconstruct user/assistant timing.
    sessions: [],
  };
}
