import { existsSync } from 'node:fs';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { toCount } from './fs-utils.js';
import { queryDbJson, sqliteUnavailableError, isSqliteUnavailableError } from './sqlite.js';
import { getDimAgentDbPath, getDimAgentRustDbPaths } from '../tools.js';
import { readDimAgentRustStores } from './dimagent-rust.js';

const SOURCE = 'dimagent';
const FORKED_LEDGER_ID = /^ledger_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function projectName(cwd) {
  if (!cwd) return 'unknown';
  const parts = String(cwd).replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts.at(-1) || 'unknown';
}

function usageSignature(row) {
  return [
    row.runId || '',
    row.providerId || '',
    row.modelId || '',
    row.usage || '',
    row.cost ?? '',
    row.createdAt || '',
  ].join('\0');
}

function parseUsageRows(rows) {
  const entries = [];
  const originalSignatures = new Set(
    rows
      .filter(row => !FORKED_LEDGER_ID.test(row.ledgerId || ''))
      .map(usageSignature),
  );
  const keptOrphanClones = new Set();

  for (const row of rows) {
    const signature = usageSignature(row);
    if (FORKED_LEDGER_ID.test(row.ledgerId || '')) {
      if (originalSignatures.has(signature) || keptOrphanClones.has(signature)) continue;
      keptOrphanClones.add(signature);
    }

    let usage;
    try {
      usage = typeof row.usage === 'string' ? JSON.parse(row.usage) : row.usage;
    } catch {
      continue;
    }
    if (!usage || typeof usage !== 'object') continue;

    const timestamp = new Date(row.createdAt);
    if (Number.isNaN(timestamp.getTime())) continue;

    const promptTokens = toCount(usage.promptTokens);
    const cachedInputTokens = toCount(usage.cacheReadTokens);
    const inputTokens = Math.max(0, promptTokens - cachedInputTokens);
    const outputTokens = toCount(usage.completionTokens);
    if (inputTokens + outputTokens + cachedInputTokens === 0) continue;

    entries.push({
      source: SOURCE,
      model: row.modelId || 'unknown',
      project: projectName(row.cwd),
      timestamp,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningOutputTokens: 0,
    });
  }

  return entries;
}

function queryDb(dbPath, sql) {
  try {
    return queryDbJson(dbPath, sql);
  } catch (err) {
    if (isSqliteUnavailableError(err)) throw sqliteUnavailableError('DimAgent');
    throw err;
  }
}

// The legacy TypeScript DimAgent store (`~/.dimcode/v2/dimcode.sqlite`).
function readLegacyStore(dbPath) {
  const usageRows = queryDb(dbPath, `SELECT
    u.ledgerId,
    u.runId,
    u.providerId,
    u.modelId,
    u.usage,
    u.cost,
    u.createdAt,
    s.cwd
    FROM usage_ledger u
    LEFT JOIN sessions s ON s.sessionId = u.sessionId`);

  const messageRows = queryDb(dbPath, `SELECT
    m.sessionId,
    m.role,
    m.createdAt,
    s.cwd
    FROM messages m
    LEFT JOIN sessions s ON s.sessionId = m.sessionId
    WHERE m.role IN ('user', 'assistant')
      AND m.messageId NOT LIKE 'msg_fork_%'`);

  const sessionEvents = [];
  for (const row of messageRows) {
    const timestamp = new Date(row.createdAt);
    if (Number.isNaN(timestamp.getTime())) continue;
    sessionEvents.push({
      sessionId: row.sessionId,
      source: SOURCE,
      project: projectName(row.cwd),
      timestamp,
      role: row.role,
    });
  }

  return { entries: parseUsageRows(usageRows), events: sessionEvents };
}

// One source for both generations: the legacy store and every Rust Dim store
// (dimagent-rust.js). Imported legacy history carries no usage in the Rust
// store, so the two never count the same call. Each store is read on its own:
// one that fails is reported as a warning and the others still sync, while
// `skipped` keeps sync.js from pruning what the failed one uploaded before.
export async function parse() {
  let entries = [];
  let events = [];
  const warnings = [];
  let skipped = false;

  const dbPath = getDimAgentDbPath();
  if (existsSync(dbPath)) {
    try {
      ({ entries, events } = readLegacyStore(dbPath));
    } catch (err) {
      skipped = true;
      // queryDb() already turned a missing SQLite into the standard hint.
      warnings.push(/sqlite3 CLI not found/.test(err?.message || '')
        ? err.message
        : `DimAgent: 无法读取 ${dbPath}: ${err.message}`);
    }
  }

  const rust = readDimAgentRustStores(getDimAgentRustDbPaths());
  // Loops, not push(...rows): a large store overflows the argument stack.
  for (const entry of rust.entries) entries.push(entry);
  for (const event of rust.events) events.push(event);
  for (const warning of rust.warnings) {
    if (!warnings.includes(warning)) warnings.push(warning);
  }
  if (rust.failed) skipped = true;

  return {
    buckets: aggregateToBuckets(entries),
    sessions: extractSessions(events),
    ...(skipped ? { skipped: true } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
