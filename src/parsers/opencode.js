import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { queryDbJson, sqliteUnavailableError, isSqliteUnavailableError } from './sqlite.js';
import { getOpenCodeStores } from '../opencode-roots.js';

function readSqlite(path) {
  // Select only accounting/timing metadata, never message text or tool inputs.
  // Keep the existing top-level model/project precedence for old uploads.
  const query = `SELECT id, session_id AS sessionID,
    json_extract(data, '$.role') AS role,
    json_extract(data, '$.time.created') AS created,
    coalesce(json_extract(data, '$.modelID'), json_extract(data, '$.model.modelID')) AS modelID,
    json_extract(data, '$.tokens') AS tokens,
    json_extract(data, '$.path.root') AS rootPath
    FROM message ORDER BY id`;
  try { return queryDbJson(path, query); }
  catch (err) {
    if (isSqliteUnavailableError(err)) throw sqliteUnavailableError('OpenCode');
    throw err;
  }
}

function readJson(path) {
  const rows = [];
  for (const dir of readdirSync(path, { withFileTypes: true })) {
    if (!dir.isDirectory() || !dir.name.startsWith('ses_')) continue;
    const sessionPath = join(path, dir.name);
    for (const file of readdirSync(sessionPath).sort()) {
      if (!file.endsWith('.json')) continue;
      const data = JSON.parse(readFileSync(join(sessionPath, file), 'utf8'));
      rows.push({ id: data.id || basename(file, '.json'), sessionID: dir.name,
        role: data.role, created: data.time?.created,
        modelID: data.modelID || data.model?.modelID,
        tokens: data.tokens, rootPath: data.path?.root });
    }
  }
  return rows;
}

function tokenSize(row) {
  const t = row.tokens;
  return ['input', 'output', 'reasoning'].reduce((n, key) => n + (Number(t?.[key]) || 0), 0)
    + (Number(t?.cache?.read) || 0);
}

export async function parse({ extraRoots = [] } = {}) {
  const warnings = [];
  const stores = getOpenCodeStores({ extraRoots, onWarning: message => warnings.push(message) });
  const records = new Map();
  for (const store of stores) {
    try {
      const rows = store.kind === 'sqlite' ? readSqlite(store.path) : readJson(store.path);
      for (const [index, row] of rows.entries()) {
        const timestamp = new Date(row.created);
        if (!Number.isFinite(timestamp.getTime())) continue;
        if (typeof row.tokens === 'string') row.tokens = JSON.parse(row.tokens);
        const sessionId = row.sessionID || 'unknown';
        // Message ids are unique within an OpenCode session. Across stores,
        // keep the most complete copy; never dedup unrelated equal-sized calls.
        // Missing ids cannot prove that two stores hold the same record.
        const key = JSON.stringify([sessionId, row.id || `${store.path}:${index}`]);
        const old = records.get(key);
        if (!old || tokenSize(row) > tokenSize(old)) records.set(key, { ...row, timestamp, sessionId });
      }
    } catch (err) { warnings.push(`OpenCode: 无法读取 ${store.path}: ${err.message}`); }
  }
  if (warnings.length) return { buckets: [], sessions: [], skipped: true, warnings };

  const entries = [], events = [];
  for (const row of records.values()) {
    // Keep the existing project derivation and token semantics. Additional roots
    // must not rename previously uploaded projects/models or alter their counts.
    const project = row.rootPath ? basename(row.rootPath) : 'unknown';
    const base = { source: 'opencode', project, timestamp: row.timestamp };
    events.push({ ...base, sessionId: row.sessionId, role: row.role === 'user' ? 'user' : 'assistant' });
    const tokens = row.tokens;
    if (!row.modelID || !tokens || (!tokens.input && !tokens.output)) continue;
    entries.push({ ...base, model: row.modelID,
      inputTokens: tokens.input || 0, outputTokens: tokens.output || 0,
      cachedInputTokens: tokens.cache?.read || 0, reasoningOutputTokens: tokens.reasoning || 0 });
  }
  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(events) };
}
