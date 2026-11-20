import { realpathSync } from 'node:fs';
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
// - `model/call` records the request model and service tier. Manual compaction
//   has no request id and uses the branch's most recent `context/configured`.
// - Context compaction calls its summarizer outside that path: the summed
//   usage of those calls exists only as `data.diagnostics.modelUsage` on the
//   `context/compaction` event (summary_strategy.rs), and the summarizer uses
//   the model of the request it runs for (`summary_request()`).
// - Forking a Session copies its main-branch events, ids and bodies unchanged,
//   into the fork (storage/timeline.rs `copy_fork`), so every event is counted
//   once by its event id, for the Session created first. For timing, the
//   fork's own `session/forked` marker excludes its copied main-branch prefix
//   even after the source Session was deleted. Other branches have local sequences.
// - Imported legacy history carries the tag `migration:legacy-import`, the
//   import instant as its time, and no usage (dim-migration native.rs): the
//   legacy TypeScript store already accounts for it.
//
// Only ids, kinds, times, model ids, cwd and the token counters are selected;
// prompts, replies and tool payloads are never read.

const SOURCE = 'dimagent';
const MIGRATION_TAG = 'migration:legacy-import';

const PRICED_TIERS = new Set(['fast', 'priority', 'flex', 'batch', 'ultrafast']);

function serviceTierSql(document, path) {
  const options = `${path}.config.providerOptions`;
  const openai = `json_extract(${document}, '${options}.openai.serviceTier')`;
  const compatible = `json_extract(${document}, '${options}."openai-compatible".serviceTier')`;
  return `CASE json_extract(${document}, '${path}.metadata.providerProtocol')
    WHEN 'openai-compatible' THEN ${compatible}
    WHEN 'openai-chat' THEN ${openai}
    WHEN 'openai-responses' THEN ${openai}
    ELSE coalesce(${openai}, ${compatible}) END`;
}

function pricedModel(model, serviceTier) {
  if (typeof model !== 'string' || !model) return null;
  const name = model.trim().toLowerCase() === 'auto' ? 'dimagent-auto' : model;
  const tier = typeof serviceTier === 'string' ? serviceTier.trim().toLowerCase() : null;
  return PRICED_TIERS.has(tier) && name !== 'unknown' ? `${name}-${tier}` : name;
}

function hasTag(tags, tag) {
  if (typeof tags !== 'string' || !tags) return false;
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) && parsed.includes(tag);
  } catch {
    return false;
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
    throw new Error('不认识的表结构');
  }
  const sessionColumns = new Set(query(dbPath, 'PRAGMA table_info(agent_sessions)').map(row => row.name));
  const leader = sessionColumns.has('leader_session_id') ? 's.leader_session_id' : 'NULL';
  const catalog = tables.has('session_catalog');

  const sessions = query(dbPath, `SELECT
    s.session_id AS sessionId,
    s.created_at_ms AS createdAt,
    ${leader} AS leaderId,
    ${catalog ? 'c.cwd' : 'NULL'} AS catalogCwd,
    json_extract(s.config, '$.cwd') AS configCwd,
    json_extract(s.config, '$.model.modelId') AS configModel,
    ${serviceTierSql('s.config', '$.model')} AS serviceTier
    FROM agent_sessions s
    ${catalog ? 'LEFT JOIN session_catalog c ON c.session_id = s.session_id' : ''}`);

  // Dim removes agent_sessions first and cleans up a deleted session's rows
  // in batches. The join also covers deletion after the metadata query.
  const events = query(dbPath, `WITH selected AS (
    SELECT e.session_id AS sessionId, e.branch_id AS branchId, e.sequence, e.kind,
      json_extract(e.body, '$.record.event.id') AS id,
      json_extract(e.body, '$.record.event.create_at') AS createdAt,
      json_extract(e.body, '$.record.event.tags') AS tags,
      json_extract(e.body, '$.record.event.data.request_id') AS requestId,
      CASE e.kind
        WHEN 'model/call' THEN json_extract(e.body, '$.record.event.data.request.modelId')
        WHEN 'context/configured' THEN json_extract(e.body, '$.record.event.data.settings.modelId')
      END AS modelId,
      CASE e.kind
        WHEN 'model/call' THEN ${serviceTierSql('e.body', '$.record.event.data.request')}
        WHEN 'context/configured' THEN ${serviceTierSql('e.body', '$.record.event.data.settings')}
      END AS serviceTier,
      CASE e.kind
        WHEN 'model/usage' THEN json_extract(e.body, '$.record.event.data.usage')
        WHEN 'context/compaction' THEN json_extract(e.body, '$.record.event.data.diagnostics.modelUsage')
      END AS usage,
      CASE e.kind
        WHEN 'input/message' THEN json_type(e.body, '$.record.event.data.user')
        WHEN 'input/applied' THEN json_extract(e.body, '$.record.event.data.input_id')
      END AS input
    FROM timeline_events e JOIN agent_sessions s ON s.session_id = e.session_id
    WHERE e.kind IN ('model/usage', 'model/call', 'context/compaction',
      'context/configured', 'input/message', 'input/applied', 'session/forked')
      OR (e.kind = 'step/model-output-end'
        AND json_extract(e.body, '$.record.event.data.status') = 'completed')
    LIMIT -1
  )
  SELECT sessionId, branchId, sequence, kind, id, createdAt, tags, requestId, modelId, serviceTier, input,
    json_extract(usage, '$.promptTokens') AS promptTokens,
    json_extract(usage, '$.completionTokens') AS completionTokens,
    json_extract(usage, '$.cacheReadTokens') AS cacheReadTokens,
    json_extract(usage, '$.cacheWriteTokens') AS cacheWriteTokens,
    json_extract(usage, '$.reasoningTokens') AS reasoningTokens
  FROM selected ORDER BY sessionId, branchId, sequence`);

  // A session may have been created between the metadata and event queries.
  // Check membership per store even when its id also exists in another home.
  const sessionIds = new Set(sessions.map(row => row.sessionId));
  return { sessions, events: events.filter(row => sessionIds.has(row.sessionId)) };
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
  while (!seen.has(current)) {
    seen.add(current);
    const leader = sessions.get(current)?.leaderId;
    if (!leader) return current;
    if (!sessions.has(leader)) break;
    current = leader;
  }
  // Orphan or cyclic leaders fail open: the Session stands on its own.
  return sessionId;
}

function existingPath(dbPath) {
  try {
    return realpathSync(dbPath);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
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
  const paths = new Set();

  for (const dbPath of dbPaths) {
    try {
      const path = existingPath(dbPath);
      if (!path || paths.has(path)) continue;
      paths.add(path);
      stores.push(readStore(path));
    } catch (err) {
      failed = true;
      if (isSqliteUnavailableError(err)) {
        warnings.push(sqliteUnavailableError('DimAgent').message);
      } else {
        const reason = /no such column:/i.test(err.message) ? '不认识的表结构（缺少必要列）' : err.message;
        warnings.push(`DimAgent: 无法读取 ${dbPath}: ${reason}`);
      }
    }
  }

  for (const store of stores) {
    for (const row of store.sessions) {
      if (!row.sessionId || sessions.has(row.sessionId)) continue;
      sessions.set(row.sessionId, {
        createdAt: Number(row.createdAt) || 0,
        leaderId: row.leaderId || null,
        project: projectFromCwd(row.catalogCwd || row.configCwd),
        model: pricedModel(row.configModel, row.serviceTier),
      });
    }
  }

  const models = new Map();
  const applied = new Set();
  const forkBoundaries = new Map();
  const usageRequests = new Set();
  const candidates = [];
  for (const store of stores) {
    const configured = new Map();
    for (const row of store.events) {
      const branch = `${row.sessionId}\0${row.branchId}`;
      const request = row.requestId ? `${branch}\0${row.requestId}` : null;
      switch (row.kind) {
        case 'model/call': {
          const model = pricedModel(row.modelId, row.serviceTier);
          if (request && model && !models.has(request)) models.set(request, model);
          break;
        }
        case 'context/configured':
          configured.set(branch, pricedModel(row.modelId, row.serviceTier));
          break;
        case 'input/applied':
          if (row.input) applied.add(`${branch}\0${row.input}`);
          break;
        case 'session/forked':
          if (row.branchId === 'main' && row.sequence > (forkBoundaries.get(row.sessionId) ?? 0)) {
            forkBoundaries.set(row.sessionId, row.sequence);
          }
          break;
        default:
          if (row.kind === 'model/usage' && request) usageRequests.add(request);
          candidates.push({ row, branch, request, configuredModel: configured.get(branch) });
      }
    }
  }

  // A fork holds copies of its source's events under the same ids: keep each
  // event for the Session created first (ties by id, so the choice is stable).
  const order = id => sessions.get(id).createdAt;
  candidates.sort(({ row: a }, { row: b }) => (order(a.sessionId) - order(b.sessionId))
    || a.sessionId.localeCompare(b.sessionId));

  const seenUsage = new Set();
  const seenTiming = new Set();
  const entries = [];
  const timings = [];
  for (const { row, branch, request, configuredModel } of candidates) {
    if (!row.id || hasTag(row.tags, MIGRATION_TAG)) continue;
    const timestamp = new Date(row.createdAt ?? 0);
    if (!(timestamp.getTime() > 0)) continue;
    const session = sessions.get(row.sessionId);

    if ((row.kind === 'model/usage' || row.kind === 'context/compaction') && !seenUsage.has(row.id)) {
      const tokens = tokenEntry(row);
      if (tokens.inputTokens + tokens.outputTokens + tokens.cachedInputTokens
        + tokens.reasoningOutputTokens + tokens.cacheCreation5mTokens > 0) {
        seenUsage.add(row.id);
        entries.push({
          source: SOURCE,
          model: models.get(request) || configuredModel || session.model || 'unknown',
          project: session.project,
          timestamp,
          ...tokens,
        });
      }
    }

    // A fork copies only main events. Other branches use local sequences.
    if (seenTiming.has(row.id)) continue;
    if (row.branchId === 'main' && row.sequence <= (forkBoundaries.get(row.sessionId) ?? 0)) continue;
    const prompt = row.kind === 'input/message' && row.input === 'object' && applied.has(`${branch}\0${row.id}`);
    const reply = row.kind === 'model/usage'
      || (row.kind === 'step/model-output-end' && request && !usageRequests.has(request));
    if (!prompt && !reply) continue;
    seenTiming.add(row.id);
    const root = rootOf(row.sessionId, sessions);
    timings.push({
      sessionId: root,
      source: SOURCE,
      project: sessions.get(root).project,
      timestamp,
      role: prompt && root === row.sessionId ? 'user' : 'assistant',
    });
  }

  // A Session counts once a person prompted it: internal work without a human
  // turn (and member Sessions, folded into their root above) adds none.
  const prompted = new Set(timings.filter(event => event.role === 'user').map(event => event.sessionId));
  const events = timings.filter(event => prompted.has(event.sessionId));

  return { entries, events, warnings, failed };
}
