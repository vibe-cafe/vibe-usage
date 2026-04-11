import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './index.js';

const HERMES_HOME = process.env.HERMES_HOME || join(homedir(), '.hermes');
const DB_PATH = join(HERMES_HOME, 'state.db');

/**
 * Parse Hermes Agent usage data from its SQLite database (~/.hermes/state.db).
 *
 * Token buckets come from the sessions table (cumulative per-session totals).
 * Session timing comes from the messages table (per-message role + timestamp).
 */
export async function parse() {
  if (!existsSync(DB_PATH)) return { buckets: [], sessions: [] };

  let sessionRows;
  try {
    sessionRows = queryDb(`SELECT
      id,
      model,
      started_at as startedAt,
      input_tokens as inputTokens,
      output_tokens as outputTokens,
      cache_read_tokens as cacheReadTokens,
      reasoning_tokens as reasoningTokens
      FROM sessions
      WHERE input_tokens > 0 OR output_tokens > 0`);
  } catch (err) {
    if (err.message && err.message.includes('ENOENT')) {
      throw new Error('sqlite3 CLI not found. Install sqlite3 to sync Hermes data.');
    }
    throw err;
  }

  const entries = [];
  for (const row of sessionRows) {
    // started_at is a Unix timestamp (float)
    const timestamp = new Date(row.startedAt * 1000);
    if (isNaN(timestamp.getTime())) continue;

    // Hermes stores input_tokens exclusive of cache (Anthropic-style semantics)
    entries.push({
      source: 'hermes',
      model: row.model || 'unknown',
      project: 'unknown',
      timestamp,
      inputTokens: row.inputTokens || 0,
      outputTokens: row.outputTokens || 0,
      cachedInputTokens: row.cacheReadTokens || 0,
      reasoningOutputTokens: row.reasoningTokens || 0,
    });
  }

  // Session events from messages table for active time calculation
  let messageRows;
  try {
    messageRows = queryDb(`SELECT
      session_id as sessionId,
      role,
      timestamp
      FROM messages
      WHERE role IN ('user', 'assistant')
      ORDER BY timestamp`);
  } catch {
    // Messages query failed — return buckets only
    return { buckets: aggregateToBuckets(entries), sessions: [] };
  }

  const sessionEvents = [];
  for (const row of messageRows) {
    const timestamp = new Date(row.timestamp * 1000);
    if (isNaN(timestamp.getTime())) continue;

    sessionEvents.push({
      sessionId: row.sessionId,
      source: 'hermes',
      project: 'unknown',
      timestamp,
      role: row.role === 'user' ? 'user' : 'assistant',
    });
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(sessionEvents) };
}

function queryDb(sql) {
  const output = execFileSync('sqlite3', [
    '-json',
    DB_PATH,
    sql,
  ], { encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024, timeout: 30000 });

  const trimmed = output.trim();
  if (!trimmed || trimmed === '[]') return [];

  return JSON.parse(trimmed);
}
