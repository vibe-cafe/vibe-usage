import { existsSync } from 'node:fs';
import { projectFromPath, toCount } from './fs-utils.js';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import {
  queryDbJsonSnapshotOnLock,
  isSqliteUnavailableError,
  sqliteUnavailableError,
} from './sqlite.js';
import { getDevinDbPath } from '../tools.js';

const SOURCE = 'devin';

// Devin (the CLI and the Desktop app's embedded agent share one backend) keeps
// every session in a single WAL SQLite database,
// $XDG_DATA_HOME/devin/cli/sessions.db (default ~/.local/share/devin/cli/
// sessions.db). Per-request token usage lives inside
// message_nodes.chat_message → metadata.metrics on assistant rows:
// input_tokens is the uncached prompt portion, cache_creation_tokens and
// cache_read_tokens are separate counters, and output_tokens is the full
// completion (there is no separate reasoning field).
//
// message_nodes is a forest: the same logical message can be stored at several
// adjacent nodes (verified on a live DB — duplicated rows carry byte-identical
// metrics), so rows are deduplicated by (session_id, message_id). Only
// allow-listed identity/accounting fields are extracted via json_extract;
// message content, cogs_json, and sessions.metadata (which carries
// credit/ACU billing totals — account funding, never collected) are never
// selected.
const NODE_COLUMNS = ['session_id', 'node_id', 'chat_message', 'created_at'];
const SESSION_COLUMNS = ['id', 'working_directory', 'model'];

const USAGE_SQL = `
  SELECT
    m.session_id AS sessionId,
    m.row_id AS rowId,
    m.created_at AS nodeCreated,
    json_extract(m.chat_message, '$.message_id') AS messageId,
    json_extract(m.chat_message, '$.role') AS role,
    json_extract(m.chat_message, '$.metadata.is_user_input') AS isUserInput,
    json_extract(m.chat_message, '$.metadata.created_at') AS msgCreatedAt,
    json_extract(m.chat_message, '$.metadata.generation_model') AS generationModel,
    json_extract(m.chat_message, '$.metadata.metrics.input_tokens') AS inputTokens,
    json_extract(m.chat_message, '$.metadata.metrics.output_tokens') AS outputTokens,
    json_extract(m.chat_message, '$.metadata.metrics.cache_read_tokens') AS cacheReadTokens,
    json_extract(m.chat_message, '$.metadata.metrics.cache_creation_tokens') AS cacheCreationTokens,
    s.working_directory AS workingDir,
    s.model AS sessionModel
  FROM message_nodes AS m
  LEFT JOIN sessions AS s ON s.id = m.session_id
`;

export function resolveDevinDbPath(env = process.env, home) {
  return getDevinDbPath(env, home);
}

/**
 * Per-message instant: metadata.created_at is an ISO-8601 string with
 * millisecond precision; the node column is integer unix seconds (defensive
 * ms/seconds sniffing matches the sibling parsers).
 */
function resolveTimestamp(row) {
  if (typeof row.msgCreatedAt === 'string') {
    const d = new Date(row.msgCreatedAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const n = Number(row.nodeCreated);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n < 1e12 ? n * 1000 : n);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Timing-event role. Only `is_user_input` user rows are human prompts —
 * Devin writes synthetic user records (e.g. `cache_keepalive` "continue"
 * prompts) that must not inflate the user-prompt count; they and tool results
 * still mark agent activity, so they join the assistant side. `system` rows
 * are prompt-assembly artifacts re-written on resume and are skipped.
 */
function eventRole(row) {
  if (row.role === 'system') return null;
  if (row.role === 'user' && (row.isUserInput === 1 || row.isUserInput === true)) {
    return 'user';
  }
  return 'assistant';
}

function dbHasColumns(dbPath, table, columns) {
  const info = queryDbJsonSnapshotOnLock(
    dbPath,
    `PRAGMA table_info(${table})`,
    { tempPrefix: 'vibe-usage-devin' },
  );
  const present = new Set(info.map(row => String(row.name)));
  return columns.every(col => present.has(col));
}

export async function parse() {
  const dbPath = resolveDevinDbPath();
  if (!existsSync(dbPath)) return { buckets: [], sessions: [] };

  // Schema guard: if a future Devin build renames or drops a relied-upon
  // column, fail soft (skipped) so incremental sync keeps this source's last
  // good upload state.
  let schemaOk;
  try {
    schemaOk =
      dbHasColumns(dbPath, 'message_nodes', NODE_COLUMNS) &&
      dbHasColumns(dbPath, 'sessions', SESSION_COLUMNS);
  } catch (err) {
    if (isSqliteUnavailableError(err)) throw sqliteUnavailableError('Devin');
    return { buckets: [], sessions: [], skipped: true };
  }
  if (!schemaOk) {
    return { buckets: [], sessions: [], skipped: true };
  }

  let rows;
  try {
    rows = queryDbJsonSnapshotOnLock(dbPath, USAGE_SQL, {
      tempPrefix: 'vibe-usage-devin',
    });
  } catch (err) {
    if (isSqliteUnavailableError(err)) throw sqliteUnavailableError('Devin');
    return { buckets: [], sessions: [], skipped: true };
  }

  const entries = [];
  const events = [];
  const sessionsWithUserPrompt = new Set();
  const seen = new Set();

  for (const row of rows) {
    const sessionId = row.sessionId != null ? String(row.sessionId) : '';
    if (!sessionId) continue;

    // The node forest stores the same logical message at several adjacent
    // nodes; dedupe on the stable message id (row id as fallback when absent).
    const messageId = row.messageId != null ? String(row.messageId) : `row:${row.rowId}`;
    const dedupKey = `${sessionId}|${messageId}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const timestamp = resolveTimestamp(row);
    if (!timestamp) continue;

    const project = row.workingDir ? projectFromPath(String(row.workingDir)) : 'unknown';
    const role = eventRole(row);
    if (role) {
      events.push({ sessionId, source: SOURCE, project, timestamp, role });
      if (role === 'user') sessionsWithUserPrompt.add(sessionId);
    }

    if (row.role !== 'assistant') continue;

    // Cache creation folds into input (the shared bucket schema has no
    // cache-write column); cache reads stay separate. Devin reports no
    // reasoning split, so output is taken as-is.
    const inputTokens = toCount(row.inputTokens) + toCount(row.cacheCreationTokens);
    const outputTokens = toCount(row.outputTokens);
    const cachedInputTokens = toCount(row.cacheReadTokens);
    if (inputTokens + outputTokens + cachedInputTokens === 0) continue;

    entries.push({
      source: SOURCE,
      model: row.generationModel || row.sessionModel || 'unknown',
      project,
      timestamp,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningOutputTokens: 0,
    });
  }

  // Only sessions containing a real human prompt reach extractSessions() —
  // keepalive-only or otherwise automated sessions still contribute their
  // token usage to buckets above.
  const sessionEvents = events.filter(e => sessionsWithUserPrompt.has(e.sessionId));

  return {
    buckets: aggregateToBuckets(entries),
    sessions: extractSessions(sessionEvents),
  };
}
