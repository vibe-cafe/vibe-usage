import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './index.js';

const HERMES_HOME = process.env.HERMES_HOME || join(homedir(), '.hermes');

/**
 * Parse Hermes Agent usage data from its SQLite databases.
 *
 * Hermes supports multiple profiles — the default profile lives at
 * ~/.hermes/state.db, while named profiles live at ~/.hermes/profiles/<name>/state.db.
 * Each profile is an independent HERMES_HOME with its own state.db, so we scan all of them.
 *
 * Token buckets come from the sessions table (cumulative per-session totals).
 * Session timing comes from the messages table (per-message role + timestamp).
 */
export async function parse() {
  const dbs = discoverDbPaths(HERMES_HOME);
  if (dbs.length === 0) return { buckets: [], sessions: [] };

  const entries = [];
  const sessionEvents = [];

  for (const { path: dbPath, profile } of dbs) {
    let sessionRows;
    try {
      sessionRows = queryDb(dbPath, `SELECT
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

    for (const row of sessionRows) {
      // started_at is a Unix timestamp (float)
      const timestamp = new Date(row.startedAt * 1000);
      if (isNaN(timestamp.getTime())) continue;

      // Hermes stores input_tokens exclusive of cache (Anthropic-style semantics)
      entries.push({
        source: 'hermes',
        model: row.model || 'unknown',
        project: profile,
        timestamp,
        inputTokens: row.inputTokens || 0,
        outputTokens: row.outputTokens || 0,
        cachedInputTokens: row.cacheReadTokens || 0,
        reasoningOutputTokens: row.reasoningTokens || 0,
      });
    }

    let messageRows;
    try {
      messageRows = queryDb(dbPath, `SELECT
        session_id as sessionId,
        role,
        timestamp
        FROM messages
        WHERE role IN ('user', 'assistant')
        ORDER BY timestamp`);
    } catch {
      // Messages query failed for this profile — skip its session events
      continue;
    }

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

function discoverDbPaths(home) {
  const dbs = [];

  const defaultDb = join(home, 'state.db');
  if (existsSync(defaultDb)) dbs.push({ path: defaultDb, profile: 'default' });

  const profilesDir = join(home, 'profiles');
  if (existsSync(profilesDir)) {
    let entries;
    try {
      entries = readdirSync(profilesDir, { withFileTypes: true });
    } catch {
      return dbs;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const profileDb = join(profilesDir, entry.name, 'state.db');
      try {
        if (statSync(profileDb).isFile()) dbs.push({ path: profileDb, profile: entry.name });
      } catch {
        // missing or unreadable — skip
      }
    }
  }

  return dbs;
}

function queryDb(dbPath, sql) {
  const output = execFileSync('sqlite3', [
    '-json',
    dbPath,
    sql,
  ], { encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024, timeout: 30000 });

  const trimmed = output.trim();
  if (!trimmed || trimmed === '[]') return [];

  return JSON.parse(trimmed);
}
