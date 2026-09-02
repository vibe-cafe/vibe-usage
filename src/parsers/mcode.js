import { existsSync } from 'node:fs';
import { projectFromPath } from './fs-utils.js';
import { aggregateToBuckets } from './aggregate.js';
import {
  queryDbJsonSnapshotOnLock,
  isSqliteUnavailableError,
  sqliteUnavailableError,
} from './sqlite.js';
import { getMcodeDbPath } from '../tools.js';

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

// `local_runtime_sessions` carries both `workspace_dir` (per-session scratch
// dir, always present) and `project_workspace_dir` (the project root when one
// is known). We pick the project column first, then the workspace, then
// fall back to "unknown". Never read `record_json` / `extra_data_json`.
const SESSION_COLUMNS = ['session_id', 'workspace_dir', 'project_workspace_dir'];

// Keep token rows and their project metadata in one SQLite statement. Separate
// reads can observe different WAL snapshots while mcode is writing, causing a
// token row to be uploaded once as "unknown" and again under its real project.
const USAGE_SQL = `
  SELECT
    ${TOKEN_COLUMNS.map(column => `token.${column}`).join(', ')},
    session.workspace_dir,
    session.project_workspace_dir
  FROM local_runtime_token_usage AS token
  LEFT JOIN local_runtime_sessions AS session
    ON session.session_id = token.session_id
`;

/**
 * Resolve the mcode runtime-state SQLite database. Mirrors the precedence used
 * by sibling tools (MiMoCode, DimAgent): explicit env var wins, then a
 * tool-specific HOME, then the default layout.
 *
 * Defaults to `<homedir()>/.minimax/v2/sqlite/runtime-state.sqlite`, which is
 * where the mcode CLI keeps its WAL database on macOS / Linux.
 */
export function resolveMcodeDbPath(env = process.env) {
  return getMcodeDbPath(env);
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
  const dbPath = resolveMcodeDbPath();
  if (!existsSync(dbPath)) return { buckets: [], sessions: [] };

  // Schema guard: every allow-listed column must exist. If the mcode
  // runtime ever renames / drops a column, fail soft (skipped) so the
  // incremental sync keeps the last good upload state for this source.
  let schemaOk;
  try {
    schemaOk =
      dbHasColumns(dbPath, 'local_runtime_token_usage', TOKEN_COLUMNS) &&
      dbHasColumns(dbPath, 'local_runtime_sessions', SESSION_COLUMNS);
  } catch (err) {
    if (isSqliteUnavailableError(err)) throw sqliteUnavailableError('mcode');
    return { buckets: [], sessions: [], skipped: true };
  }
  if (!schemaOk) {
    return { buckets: [], sessions: [], skipped: true };
  }

  // Read tokens and session project metadata from one statement/snapshot.
  let usageRows;
  try {
    usageRows = queryDbJsonSnapshotOnLock(dbPath, USAGE_SQL, {
      tempPrefix: 'vibe-usage-mcode',
    });
  } catch (err) {
    if (isSqliteUnavailableError(err)) throw sqliteUnavailableError('mcode');
    return { buckets: [], sessions: [], skipped: true };
  }

  const entries = [];

  for (const row of usageRows) {
    const sessionId = row.session_id != null ? String(row.session_id) : '';
    if (!sessionId) continue;
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
  }

  return {
    buckets: aggregateToBuckets(entries),
    // The token ledger contains assistant usage rows only. Reconstructing
    // user prompts would require reading message payloads, which this parser
    // deliberately never selects, so mcode emits buckets only like Alma.
    sessions: [],
  };
}

// Re-export for tests / external consumers.
export { SOURCE as MCODE_SOURCE };
