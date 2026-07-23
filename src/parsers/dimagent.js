import { existsSync } from 'node:fs';
import { aggregateToBuckets, extractSessions } from './index.js';
import { queryDbJson } from './sqlite.js';
import { getDimAgentDbPath } from '../tools.js';

const SOURCE = 'dimagent';
const FORKED_LEDGER_ID = /^ledger_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function projectName(cwd) {
  if (!cwd) return 'unknown';
  const parts = String(cwd).replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts.at(-1) || 'unknown';
}

function tokenCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
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

    const promptTokens = tokenCount(usage.promptTokens);
    const cachedInputTokens = tokenCount(usage.cacheReadTokens);
    const inputTokens = Math.max(0, promptTokens - cachedInputTokens);
    const outputTokens = tokenCount(usage.completionTokens);
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
    if (err.code === 'ENOENT' || err.status === 127 || err.message?.includes('ENOENT')) {
      throw new Error('sqlite3 CLI not found. Install sqlite3 (or use Node >= 22.5) to sync DimAgent data.');
    }
    throw err;
  }
}

export async function parse() {
  const dbPath = getDimAgentDbPath();
  if (!existsSync(dbPath)) return { buckets: [], sessions: [] };

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

  return {
    buckets: aggregateToBuckets(parseUsageRows(usageRows)),
    sessions: extractSessions(sessionEvents),
  };
}
