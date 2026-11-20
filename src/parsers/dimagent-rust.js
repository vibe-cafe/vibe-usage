import { existsSync } from 'node:fs';
import { projectFromCwd, toCount } from './fs-utils.js';
import {
  isSqliteUnavailableError,
  queryDbJsonSnapshotOnLock,
  sqliteUnavailableError,
} from './sqlite.js';

// Rust Dim (the `dima` alpha and the Rust builds after it) keeps one SQLite
// store per product home, `<home>/rust/dimcode.sqlite`, whose `timeline_events`
// table holds every Session's Timeline as JSON event bodies. Checked against
// arcships/dim at 367f53d93 (store formats 20, 23 and 52):
//
// - Every model reply writes one `model/usage` event (dim-agent-capabilities
//   output.rs) with `data.request_id` and `data.usage` = { promptTokens,
//   completionTokens, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }.
//   `promptTokens` is aimux's `input_tokens.total`, which already includes
//   cache reads and cache writes for every protocol adapter; `reasoningTokens`
//   is already inside `completionTokens` (dim-agent-types model.rs `Usage`).
// - The model is on the `model/call` event of the same request
//   (`data.request.modelId`).
// - Context compaction calls its summarizer outside that path: the summed
//   usage of those calls exists only as `data.diagnostics.modelUsage` on the
//   `context/compaction` event (summary_strategy.rs), and the summarizer uses
//   the model of the request it runs for (`summary_request()`).
// - Forking a Session copies its main-branch events, ids and bodies unchanged,
//   into the fork (storage/timeline.rs `copy_fork`), so every event is counted
//   once by its event id, for the Session created first. Child branches
//   inherit history by reference and copy nothing.
// - Imported legacy history carries the tag `migration:legacy-import`, the
//   import instant as its time, and no usage (dim-migration native.rs): the
//   legacy TypeScript store already accounts for it.
//
// Only ids, kinds, times, model ids, cwd and the token counters are selected;
// prompts, replies and tool payloads are never read.

const SOURCE = 'dimagent';
const MIGRATION_TAG = 'migration:legacy-import';

const SESSION_COLUMNS = {
  leader: 'leader_session_id',
};

function hasTag(tags, tag) {
  if (typeof tags !== 'string' || !tags) return false;
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) && parsed.includes(tag);
  } catch {
    return false;
  }
}

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function query(dbPath, sql) {
  return queryDbJsonSnapshotOnLock(dbPath, sql, { tempPrefix: 'vibe-usage-dimagent-' });
}

function readStore(dbPath) {
  const tables = new Set(query(dbPath, "SELECT name FROM sqlite_master WHERE type = 'table'").map(row => row.name));
  // A store the daemon has only just created, before its schema exists.
  if (tables.size === 0) return { sessions: [], events: [] };
  if (!tables.has('timeline_events') || !tables.has('agent_sessions')) {
    throw Object.assign(new Error('不认识的表结构'), { format: true });
  }
  const sessionColumns = new Set(query(dbPath, 'PRAGMA table_info(agent_sessions)').map(row => row.name));
  const leader = sessionColumns.has(SESSION_COLUMNS.leader) ? 's.leader_session_id' : 'NULL';
  const catalog = tables.has('session_catalog');

  const sessions = query(dbPath, `SELECT
    s.session_id AS sessionId,
    s.created_at_ms AS createdAt,
    ${leader} AS leaderId,
    ${catalog ? 'c.cwd' : 'NULL'} AS catalogCwd,
    json_extract(s.config, '$.cwd') AS configCwd,
    json_extract(s.config, '$.model.modelId') AS configModel
    FROM agent_sessions s
    ${catalog ? 'LEFT JOIN session_catalog c ON c.session_id = s.session_id' : ''}`);

  const events = query(dbPath, `SELECT
    session_id AS sessionId,
    branch_id AS branchId,
    kind,
    json_extract(body, '$.record.event.id') AS id,
    json_extract(body, '$.record.event.create_at') AS createdAt,
    json_extract(body, '$.record.event.tags') AS tags,
    json_extract(body, '$.record.event.data.request_id') AS requestId,
    CASE kind
      WHEN 'model/call' THEN json_extract(body, '$.record.event.data.request.modelId')
    END AS modelId,
    CASE kind
      WHEN 'model/usage' THEN json_extract(body, '$.record.event.data.usage')
      WHEN 'context/compaction' THEN json_extract(body, '$.record.event.data.diagnostics.modelUsage')
    END AS usage,
    CASE kind
      WHEN 'input/message' THEN json_type(body, '$.record.event.data.user')
      WHEN 'input/applied' THEN json_extract(body, '$.record.event.data.input_id')
    END AS input
    FROM timeline_events
    WHERE kind IN ('model/usage', 'model/call', 'context/compaction', 'input/message', 'input/applied')`);

  return { sessions, events };
}

function tokenEntry(usage) {
  const promptTokens = toCount(usage.promptTokens);
  const completionTokens = toCount(usage.completionTokens);
  const cachedInputTokens = toCount(usage.cacheReadTokens);
  const cacheCreation5mTokens = toCount(usage.cacheWriteTokens);
  const reasoningOutputTokens = Math.min(completionTokens, toCount(usage.reasoningTokens));
  return {
    inputTokens: Math.max(0, promptTokens - cachedInputTokens - cacheCreation5mTokens),
    outputTokens: completionTokens - reasoningOutputTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    // The usage carries one untyped cache-write count; the cheaper 5m tier
    // is the rule for a write whose TTL is unknown (AGENTS.md, Track 1).
    cacheCreation5mTokens,
  };
}

function rootOf(sessionId, sessions) {
  const seen = new Set();
  let current = sessionId;
  while (true) {
    seen.add(current);
    const leader = sessions.get(current)?.leaderId;
    // Orphan or cyclic leaders fail open: the Session stands on its own.
    if (!leader || !sessions.has(leader) || seen.has(leader)) return current;
    current = leader;
  }
}

/**
 * Read every given Rust Dim store. Returns token entries and timing events for
 * aggregateToBuckets() / extractSessions(), plus warnings for stores that could
 * not be read; `failed` is true when any existing store failed.
 */
export function readDimAgentRustStores(dbPaths) {
  const warnings = [];
  let failed = false;
  const sessions = new Map();
  const stores = [];

  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) continue;
    try {
      stores.push(readStore(dbPath));
    } catch (err) {
      failed = true;
      if (isSqliteUnavailableError(err)) warnings.push(sqliteUnavailableError('DimAgent').message);
      else warnings.push(`DimAgent: 无法读取 ${dbPath}: ${err.message}`);
    }
  }

  for (const store of stores) {
    for (const row of store.sessions) {
      if (!row.sessionId || sessions.has(row.sessionId)) continue;
      sessions.set(row.sessionId, {
        createdAt: Number(row.createdAt) || 0,
        leaderId: row.leaderId || null,
        project: projectFromCwd(row.catalogCwd || row.configCwd),
        model: row.configModel || null,
      });
    }
  }

  const models = new Map();
  const applied = new Set();
  const candidates = [];
  for (const store of stores) {
    for (const row of store.events) {
      if (row.kind === 'model/call') {
        if (row.requestId && row.modelId) models.set(`${row.sessionId}\0${row.requestId}`, row.modelId);
      } else if (row.kind === 'input/applied') {
        if (row.input) applied.add(`${row.sessionId}\0${row.input}`);
      } else {
        candidates.push(row);
      }
    }
  }

  // A fork holds copies of its source's events under the same ids: keep each
  // event for the Session created first (ties by id, so the choice is stable).
  const order = id => sessions.get(id)?.createdAt ?? Number.MAX_SAFE_INTEGER;
  candidates.sort((a, b) => (order(a.sessionId) - order(b.sessionId))
    || String(a.sessionId).localeCompare(String(b.sessionId)));

  const seen = new Set();
  const entries = [];
  const timings = [];
  for (const row of candidates) {
    if (!row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    if (hasTag(row.tags, MIGRATION_TAG)) continue;
    const ms = Number(row.createdAt);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    const timestamp = new Date(ms);
    const session = sessions.get(row.sessionId);
    const project = session?.project || 'unknown';
    const root = rootOf(row.sessionId, sessions);
    const timing = {
      sessionId: root,
      source: SOURCE,
      project: sessions.get(root)?.project || project,
      timestamp,
    };

    if (row.kind === 'input/message') {
      // Only an operator's words (`data.user`) that reached the conversation
      // are prompts; runtime blocks and withdrawn inputs are not. A member
      // Session's prompts come from its leader: agent activity of the root.
      if (row.input !== 'object' || !applied.has(`${row.sessionId}\0${row.id}`)) continue;
      timings.push({ ...timing, role: root === row.sessionId ? 'user' : 'assistant' });
      continue;
    }

    const usage = parseJson(row.usage);
    if (!usage || typeof usage !== 'object') continue;
    const tokens = tokenEntry(usage);
    if (tokens.inputTokens + tokens.outputTokens + tokens.cachedInputTokens
      + tokens.reasoningOutputTokens + tokens.cacheCreation5mTokens === 0) continue;
    entries.push({
      source: SOURCE,
      model: models.get(`${row.sessionId}\0${row.requestId}`) || session?.model || 'unknown',
      project,
      timestamp,
      ...tokens,
    });
    if (row.kind === 'model/usage') timings.push({ ...timing, role: 'assistant' });
  }

  // A Session counts once a person prompted it: internal work without a human
  // turn (and member Sessions, folded into their root above) adds none.
  const prompted = new Set(timings.filter(event => event.role === 'user').map(event => event.sessionId));
  const events = timings.filter(event => prompted.has(event.sessionId));

  return { entries, events, warnings, failed };
}
