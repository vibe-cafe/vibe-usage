import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { queryDbJson, sqliteUnavailableError, isSqliteUnavailableError } from './sqlite.js';
import { getOpenCodeStores } from '../opencode-roots.js';

// Select only accounting/timing metadata, never message text or tool inputs.
// Keep the existing top-level model/project precedence for old uploads.
const V1_QUERY = `SELECT id, session_id AS sessionID,
    json_extract(data, '$.role') AS role,
    json_extract(data, '$.time.created') AS created,
    json_extract(data, '$.time.completed') AS completed,
    coalesce(json_extract(data, '$.providerID'), json_extract(data, '$.model.providerID')) AS providerID,
    coalesce(json_extract(data, '$.modelID'), json_extract(data, '$.model.modelID')) AS modelID,
    json_extract(data, '$.tokens') AS tokens,
    json_extract(data, '$.path.root') AS rootPath
    FROM message ORDER BY id`;

// OpenCode 2.x stores the same accounting in the event-sourced projection
// `session_message`: the row's `type` is the role, `data.model.id` the model,
// `data.tokens` the counters. Message data carries no `path`, so the project
// comes from the session row's `directory`; the session table is `session_v2`
// in 2.x and `session` before that (both names in the wild, issue #114). Only
// column/JSON expressions are selected -- never message text, tool payloads,
// or costs.
function v2Query(sessionTable) {
  return `SELECT m.id AS id, m.session_id AS sessionID,
    m.type AS role,
    coalesce(json_extract(m.data, '$.time.created'), m.time_created) AS created,
    json_extract(m.data, '$.time.completed') AS completed,
    coalesce(json_extract(m.data, '$.providerID'), json_extract(m.data, '$.model.providerID'), json_extract(m.data, '$.model.provider')) AS providerID,
    coalesce(json_extract(m.data, '$.model.id'), json_extract(m.data, '$.modelID')) AS modelID,
    json_extract(m.data, '$.tokens') AS tokens,
    s.directory AS directory
    FROM session_message m
    ${sessionTable ? `LEFT JOIN ${sessionTable} s ON s.id = m.session_id` : ''}
    WHERE m.type IN ('user', 'assistant')
    ORDER BY m.id`;
}

function readSqlite(path) {
  try {
    const tables = new Set(queryDbJson(path,
      `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name IN ('message', 'session_message', 'session', 'session_v2')`)
      .map(row => row.name));
    if (!tables.has('message') && !tables.has('session_message')) {
      throw new Error(`不认识的表结构（没有 message / session_message 表）: ${path}`);
    }
    // Read both shapes when a migrated store keeps both: copies are merged by
    // (session, message id), and the legacy row is seen first so an equal copy
    // never renames a project that earlier uploads already used.
    const rows = [];
    if (tables.has('message')) rows.push(...queryDbJson(path, V1_QUERY));
    if (tables.has('session_message')) {
      const sessionTable = tables.has('session_v2') ? 'session_v2'
        : (tables.has('session') ? 'session' : null);
      rows.push(...queryDbJson(path, v2Query(sessionTable)));
    }
    return rows;
  } catch (err) {
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
        completed: data.time?.completed, providerID: data.providerID || data.model?.providerID,
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

export async function parse({ extraRoots = [], magpie } = {}) {
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
    // V2 message rows carry no `path`, so they fall back to the session
    // directory; they come from a store the parser could not read before, so
    // nothing previously uploaded is relabelled by that fallback.
    const project = row.rootPath ? basename(row.rootPath)
      : (row.directory ? basename(row.directory) : 'unknown');
    const base = { source: 'opencode', project, timestamp: row.timestamp };
    events.push({ ...base, sessionId: row.sessionId, role: row.role === 'user' ? 'user' : 'assistant' });
    const tokens = row.tokens;
    if (!row.modelID || !tokens || (!tokens.input && !tokens.output)) continue;
    entries.push({ ...base, model: row.modelID,
      ...(magpie && row.providerID === 'magpie' ? { magpie: {
        sessionId: row.sessionId, completed: row.completed,
        counts: [tokens.input || 0, (tokens.output || 0) + (tokens.reasoning || 0), tokens.cache?.read || 0, tokens.cache?.write || 0],
      } } : {}),
      inputTokens: tokens.input || 0, outputTokens: tokens.output || 0,
      cachedInputTokens: tokens.cache?.read || 0, reasoningOutputTokens: tokens.reasoning || 0,
      // The store writes one cache-write total with no per-TTL breakdown and no
      // separate `tokens.total` column to reconcile against, so it goes to the
      // cheaper 5m cache-creation bucket -- the same rule as CodeArts Agent,
      // which reads this exact layout. Dropping it (the behaviour until
      // 2026-09-26) under-billed every Claude/Anthropic run through OpenCode.
      cacheCreation5mTokens: tokens.cache?.write || 0 });
  }
  return { buckets: aggregateToBuckets(magpie ? magpie.attribute(entries, 'opencode') : entries), sessions: extractSessions(events) };
}
