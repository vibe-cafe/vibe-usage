import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { getMimocodeDbPath } from '../tools.js';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { queryDbJson, sqliteUnavailableError, isSqliteUnavailableError } from './sqlite.js';

export { getMimocodeDbPath as resolveMimocodeDbPath };

export async function parse() {
  const dbPath = getMimocodeDbPath();
  if (!existsSync(dbPath)) return { buckets: [], sessions: [] };

  let rows;
  try {
    const hasExternalImports = queryDbJson(dbPath, `
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = 'external_import'
      LIMIT 1
    `).length > 0;
    const externalImportJoin = hasExternalImports
      ? 'LEFT JOIN external_import ON external_import.session_id = message.session_id'
      : '';
    const externalImportFilter = hasExternalImports
      ? 'WHERE external_import.session_id IS NULL'
      : '';
    rows = queryDbJson(dbPath, `
      SELECT
        message.session_id AS sessionID,
        message.time_created AS created,
        message.data AS data,
        session.directory AS directory
      FROM message
      JOIN session ON session.id = message.session_id
      ${externalImportJoin}
      ${externalImportFilter}
    `);
  } catch (err) {
    if (isSqliteUnavailableError(err)) throw sqliteUnavailableError('MiMoCode');
    throw err;
  }

  const entries = [];
  const events = [];
  for (const row of rows) {
    let data;
    try {
      data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    } catch {
      continue;
    }
    if (data?.role !== 'user' && data?.role !== 'assistant') continue;

    const timestamp = new Date(data.time?.created ?? row.created);
    if (Number.isNaN(timestamp.getTime())) continue;
    const project = row.directory ? basename(row.directory) : 'unknown';
    events.push({
      sessionId: row.sessionID || 'unknown',
      source: 'mimocode',
      project,
      timestamp,
      role: data.role,
    });

    const tokens = data.tokens;
    if (data.role !== 'assistant' || !data.modelID || !tokens) continue;
    const inputTokens = (Number(tokens.input) || 0) + (Number(tokens.cache?.write) || 0);
    const outputTokens = Number(tokens.output) || 0;
    const reasoningOutputTokens = Number(tokens.reasoning) || 0;
    const cachedInputTokens = Number(tokens.cache?.read) || 0;
    if (inputTokens + outputTokens + reasoningOutputTokens + cachedInputTokens <= 0) continue;
    entries.push({
      source: 'mimocode',
      model: data.modelID,
      project,
      timestamp,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningOutputTokens,
    });
  }

  return {
    buckets: aggregateToBuckets(entries),
    sessions: extractSessions(events),
  };
}
