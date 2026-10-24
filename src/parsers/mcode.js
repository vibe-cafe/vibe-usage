import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { projectFromPath } from './fs-utils.js';
import { aggregateToBuckets } from './aggregate.js';
import {
  queryDbJsonSnapshotOnLock,
  isSqliteUnavailableError,
  sqliteUnavailableError,
} from './sqlite.js';
import { getMcodeDbPath, getMcodeDbPaths } from '../tools.js';

const SOURCE = 'mcode';

// Strict column allow-list. The mcode token table also stores a `raw` JSON
// payload (and the sessions table stores `record_json` / `extra_data_json`)
// that contains message bodies — we never select those, neither in this
// parser nor in any test fixture.
const TOKEN_COLUMNS = [
  'session_id',
  'model',
  'ts',
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
];

// `turn_id` groups the token rows of one assistant turn (a single user prompt
// can drive several model calls). It is optional: a store without the column
// still parses, and each token row then counts as its own turn.
const OPTIONAL_TOKEN_COLUMNS = ['turn_id'];

// `local_runtime_sessions` carries both `workspace_dir` (per-session scratch
// dir, always present) and `project_workspace_dir` (the project root when one
// is known). We pick the project column first, then the workspace, then
// fall back to "unknown". Never read `record_json` / `extra_data_json`.
const SESSION_COLUMNS = ['session_id', 'workspace_dir', 'project_workspace_dir'];

// Keep token rows and their project metadata in one SQLite statement. Separate
// reads can observe different WAL snapshots while mcode is writing, causing a
// token row to be uploaded once as "unknown" and again under its real project.
function usageSql(includeTurnId) {
  const columns = includeTurnId
    ? [...TOKEN_COLUMNS, ...OPTIONAL_TOKEN_COLUMNS]
    : TOKEN_COLUMNS;
  return `
  SELECT
    ${columns.map(column => `token.${column}`).join(', ')},
    session.workspace_dir,
    session.project_workspace_dir
  FROM local_runtime_token_usage AS token
  LEFT JOIN local_runtime_sessions AS session
    ON session.session_id = token.session_id
`;
}

/**
 * Resolve the mcode runtime-state SQLite database. Mirrors the precedence used
 * by sibling tools (MiMoCode, DimAgent): explicit env var wins, then a
 * tool-specific HOME (MCODE_HOME), then the mcode CLI's own relocation
 * variables (MINIMAX_DATA_DIR / MAVIS_DATA_DIR), then the default layout.
 *
 * Defaults to `<homedir()>/.minimax/v2/sqlite/runtime-state.sqlite`, which is
 * where the mcode CLI keeps its WAL database on macOS / Linux.
 */
export function resolveMcodeDbPath(env = process.env) {
  return getMcodeDbPath(env);
}

/**
 * Every mcode store worth reading: the resolved default above, plus a
 * `~/.minimax-<profile>` per active profile, the pre-npm `~/.minimax-code`
 * and the pre-rename `~/.mavis` homes (and their profiles) when they hold a
 * runtime-state database.
 */
export function resolveMcodeDbPaths(env = process.env, home) {
  return getMcodeDbPaths(env, home);
}

/**
 * Token count (ms vs seconds). The mcode runtime writes ts as integer
 * milliseconds — confirmed against the live schema (`typeof(ts)=integer`,
 * values ≈ 1.787e12 for 2026-08-29). Stay defensive: anything < 1e12 is
 * treated as seconds and scaled up.
 */
function tsToDate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}



function toNonNegative(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function dbHasColumns(dbPath, table, columns) {
  const info = queryDbJsonSnapshotOnLock(
    dbPath,
    `PRAGMA table_info(${table})`,
    { tempPrefix: 'vibe-usage-mcode' },
  );
  const present = new Set(info.map(row => String(row.name)));
  return columns.every(col => present.has(col));
}

export async function parse() {
  const dbPaths = getMcodeDbPaths();
  // The first store that exists is the one the running CLI would use; schema
  // or read failures there keep the fail-soft contract below. Later stores are
  // best-effort extras (profiles, pre-npm / pre-rename homes) and a broken one
  // must not suppress the live store.
  const primary = dbPaths.find(path => existsSync(path));

  const entries = [];
  const warnings = [];
  // Per-session usage stats, so mcode reports sessions like every other
  // source instead of leaving the dashboard without an active-duration column.
  const sessionStats = new Map();
  // mcode's own migration can COPY a relocated legacy tree into ~/.minimax, so
  // both copies exist. Collapse rows that reappear unchanged in a later store;
  // duplicates inside one store are left alone — there they are the ledger.
  const seenAcrossStores = new Set();
  // The same session can live in more than one store; the first store wins.
  const seenSessions = new Set();

  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) continue;
    const isPrimary = dbPath === primary;

    // Schema guard: every allow-listed column must exist. If the mcode
    // runtime ever renames / drops a column, fail soft (skipped) so the
    // incremental sync keeps the last good upload state for this source.
    let schemaOk;
    let hasTurnId = false;
    try {
      schemaOk =
        dbHasColumns(dbPath, 'local_runtime_token_usage', TOKEN_COLUMNS) &&
        dbHasColumns(dbPath, 'local_runtime_sessions', SESSION_COLUMNS);
      // Optional column: a store without `turn_id` still parses, each token
      // row then counts as its own turn.
      hasTurnId = schemaOk &&
        dbHasColumns(dbPath, 'local_runtime_token_usage', OPTIONAL_TOKEN_COLUMNS);
    } catch (err) {
      if (isSqliteUnavailableError(err)) throw sqliteUnavailableError('mcode');
      schemaOk = false;
    }
    if (!schemaOk) {
      if (isPrimary) return { buckets: [], sessions: [], skipped: true };
      warnings.push(`MiniMax Code: 跳过结构不兼容的数据库 ${dbPath}`);
      continue;
    }

    // Read tokens and session project metadata from one statement/snapshot.
    let usageRows;
    try {
      usageRows = queryDbJsonSnapshotOnLock(dbPath, usageSql(hasTurnId), {
        tempPrefix: 'vibe-usage-mcode',
      });
    } catch (err) {
      if (isSqliteUnavailableError(err)) throw sqliteUnavailableError('mcode');
      if (isPrimary) return { buckets: [], sessions: [], skipped: true };
      warnings.push(`MiniMax Code: 无法读取 ${dbPath}，已跳过: ${err.message}`);
      continue;
    }

    const identitiesInStore = new Set();
    const storeSessionIds = new Set();
    for (const row of usageRows) {
      // Identity covers every selected column; only a byte-identical ledger
      // row can collapse, and only against an earlier store.
      const identity = JSON.stringify(row);
      if (seenAcrossStores.has(identity)) continue;
      identitiesInStore.add(identity);

      const sessionId = row.session_id != null ? String(row.session_id) : '';
      if (!sessionId) continue;
      storeSessionIds.add(sessionId);
      const ts = tsToDate(row.ts);
      if (!ts) continue;

      // MCode stores output and reasoning as separate counters. Its own
      // summary code computes total = input + output + reasoning, so do not
      // subtract reasoning from output here.
      const inputRaw = toNonNegative(row.input_tokens);
      const cacheWrite = toNonNegative(row.cache_write_tokens);
      const outputRaw = toNonNegative(row.output_tokens);
      const reasoningRaw = toNonNegative(row.reasoning_tokens);
      const cacheRead = toNonNegative(row.cache_read_tokens);

      const inputTokens = inputRaw + cacheWrite;
      const reasoningOutputTokens = reasoningRaw;
      const outputTokens = outputRaw;
      const cachedInputTokens = cacheRead;

      if (
        inputTokens +
          outputTokens +
          cachedInputTokens +
          reasoningOutputTokens ===
        0
      ) {
        continue;
      }

      const projectPath = row.project_workspace_dir || row.workspace_dir;
      const project = projectPath ? projectFromPath(String(projectPath)) : 'unknown';
      const model = row.model != null && String(row.model).trim()
        ? String(row.model).trim()
        : 'unknown';

      entries.push({
        source: SOURCE,
        model,
        project,
        timestamp: ts,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        reasoningOutputTokens,
      });

      accumulateSessionStat(sessionStats, {
        sessionId,
        project,
        timestamp: ts,
        turnId: hasTurnId && row.turn_id != null ? String(row.turn_id) : null,
      });
    }
    for (const identity of identitiesInStore) seenAcrossStores.add(identity);

    // The same session can live in more than one store; the first store wins.
    for (const sessionId of storeSessionIds) {
      if (seenSessions.has(sessionId)) sessionStats.delete(sessionId);
      else seenSessions.add(sessionId);
    }
  }

  return {
    buckets: aggregateToBuckets(entries),
    sessions: buildSessions(sessionStats),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Fold one token row into the per-session stats.
 *
 * The token ledger is the only mcode data the privacy allow-list lets us read,
 * so a session is reconstructed from its usage rows: the first and last row
 * bound the wall clock, and every row of one `turn_id` belongs to the same
 * assistant turn (one user prompt can drive several model calls).
 */
function accumulateSessionStat(sessionStats, row) {
  const { sessionId, project, timestamp, turnId } = row;

  let stat = sessionStats.get(sessionId);
  if (!stat) {
    stat = {
      project,
      first: timestamp,
      last: timestamp,
      messageCount: 0,
      turns: new Map(),
    };
    sessionStats.set(sessionId, stat);
  }
  if (timestamp < stat.first) stat.first = timestamp;
  if (timestamp > stat.last) stat.last = timestamp;
  stat.messageCount += 1;

  // Without a turn id each row is its own turn.
  const key = turnId ?? `#${stat.messageCount}`;
  const turn = stat.turns.get(key);
  if (!turn) {
    stat.turns.set(key, { first: timestamp, last: timestamp });
    return;
  }
  if (timestamp < turn.first) turn.first = timestamp;
  if (timestamp > turn.last) turn.last = timestamp;
}

/**
 * Build the session records from the per-session stats.
 *
 * `activeSeconds` is the sum of the assistant turns' spans: the time between
 * the first and the last model call of a turn. The gap between two turns is
 * the user thinking / typing, which is not active time. The token ledger has
 * no user messages, so `userMessageCount` stays 0 and the prompt hours stay
 * empty — same shape as the codex parser, whose usage data is equally
 * user-message-free.
 */
function buildSessions(sessionStats) {
  const sessions = [];
  for (const [sessionId, stat] of sessionStats) {
    let activeSeconds = 0;
    for (const turn of stat.turns.values()) {
      if (turn.last > turn.first) {
        activeSeconds += Math.round((turn.last - turn.first) / 1000);
      }
    }
    sessions.push({
      source: SOURCE,
      project: stat.project || 'unknown',
      sessionHash: createHash('sha256').update(sessionId).digest('hex').slice(0, 16),
      firstMessageAt: stat.first.toISOString(),
      lastMessageAt: stat.last.toISOString(),
      durationSeconds: Math.round((stat.last - stat.first) / 1000),
      activeSeconds,
      messageCount: stat.messageCount,
      userMessageCount: 0,
      userPromptHours: new Array(24).fill(0),
    });
  }
  return sessions;
}

// Re-export for tests / external consumers.
export { SOURCE as MCODE_SOURCE };
