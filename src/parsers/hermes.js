import { discoverHermesDatabases, hermesPathKey, inspectHermesHome } from '../hermes-roots.js';
import { normalizeExtraRoot } from '../extra-roots.js';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { toCount } from './fs-utils.js';
import { queryDbJson, sqliteUnavailableError, isSqliteUnavailableError } from './sqlite.js';

/**
 * Parse Hermes Agent usage data from its SQLite databases.
 *
 * Hermes supports multiple profiles — the default profile lives at
 * <home>/state.db, while named profiles live at <home>/profiles/<name>/state.db.
 * The home is shared by CLI/Desktop: ~/.hermes on macOS/Linux, LOCALAPPDATA/hermes
 * on Windows, or an explicit HERMES_HOME. Additional homes configured with
 * `config add-root hermes <path>` are scanned too and deduped against that default.
 * Each profile is an independent store with its own state.db, so we scan all of them.
 *
 * Token buckets come from the sessions table (cumulative per-session totals).
 * Session timing comes from the messages table (per-message role + timestamp).
 */
export async function parse({ extraRoots = [] } = {}) {
  const dbs = discoverHermesDatabases();
  const seen = new Set(dbs.map(db => hermesPathKey(db.path)));
  for (const root of extraRoots) {
    const path = normalizeExtraRoot(root);
    const inspected = inspectHermesHome(path);
    // Missing or unreadable configured homes must not look like an empty sync,
    // even when the path is the default home / HERMES_HOME already scanned above.
    // Databases already reached through that default are skipped via `seen`.
    if (inspected.error || !inspected.ok) return skippedExtra(path, inspected.error);
    for (const db of inspected.dbs) {
      const key = hermesPathKey(db.path);
      if (seen.has(key)) continue;
      seen.add(key);
      dbs.push(db);
    }
  }
  if (dbs.length === 0) return { buckets: [], sessions: [] };

  const entries = [];
  const sessionEvents = [];

  for (const { path: dbPath, profile } of dbs) {
    let sessionRows;
    try {
      const columns = new Set(queryDb(dbPath, 'PRAGMA table_info(sessions)').map(row => row.name));
      const cacheWriteColumn = columns.has('cache_write_tokens') ? 'cache_write_tokens' : '0';
      sessionRows = queryDb(dbPath, `SELECT
        id,
        model,
        started_at as startedAt,
        input_tokens as inputTokens,
        output_tokens as outputTokens,
        cache_read_tokens as cacheReadTokens,
        ${cacheWriteColumn} as cacheWriteTokens,
        reasoning_tokens as reasoningTokens
        FROM sessions
        WHERE input_tokens > 0 OR output_tokens > 0
          OR cache_read_tokens > 0 OR ${cacheWriteColumn} > 0 OR reasoning_tokens > 0`);
    } catch (err) {
      if (isSqliteUnavailableError(err)) throw sqliteUnavailableError('Hermes');
      throw err;
    }

    for (const row of sessionRows) {
      // started_at is a Unix timestamp (float)
      const timestamp = new Date(row.startedAt * 1000);
      if (isNaN(timestamp.getTime())) continue;

      // Hermes stores input_tokens exclusive of cache (Anthropic-style semantics)
      // and output_tokens inclusive of reasoning (CanonicalUsage.total_tokens
      // adds prompt + output only). Split reasoning instead of counting it twice.
      const output = toCount(row.outputTokens);
      const reasoning = Math.min(output, toCount(row.reasoningTokens));
      entries.push({
        source: 'hermes',
        model: row.model || 'unknown',
        project: profile,
        timestamp,
        inputTokens: toCount(row.inputTokens) + toCount(row.cacheWriteTokens),
        outputTokens: output - reasoning,
        cachedInputTokens: toCount(row.cacheReadTokens),
        reasoningOutputTokens: reasoning,
      });
    }

    // A failed query is not an empty session history. Let sync protect this
    // source's previous state instead of uploading/pruning a partial result.
    const messageRows = queryDb(dbPath, `SELECT
      session_id as sessionId,
      role,
      timestamp
      FROM messages
      WHERE role IN ('user', 'assistant')
      ORDER BY timestamp`);

    for (const row of messageRows) {
      const timestamp = new Date(row.timestamp * 1000);
      if (isNaN(timestamp.getTime())) continue;

      sessionEvents.push({
        sessionId: row.sessionId,
        source: 'hermes',
        project: profile,
        timestamp,
        role: row.role === 'user' ? 'user' : 'assistant',
      });
    }
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(sessionEvents) };
}

function queryDb(dbPath, sql) {
  return queryDbJson(dbPath, sql);
}

function skippedExtra(path, error) {
  return {
    buckets: [],
    sessions: [],
    skipped: true,
    warnings: [error
      ? `hermes: 额外根目录读取失败，已保留上次同步数据: ${path}`
      : `hermes: 额外根目录不可用，已跳过本次 Hermes 同步: ${path}`],
  };
}
