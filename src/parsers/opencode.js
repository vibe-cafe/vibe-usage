import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './index.js';

const DATA_DIR = join(homedir(), '.local', 'share', 'opencode');
const DB_PATH = join(DATA_DIR, 'opencode.db');
const MESSAGES_DIR = join(DATA_DIR, 'storage', 'message');

/**
 * Parse opencode usage data.
 * Tries SQLite database first (opencode >= v0.2), falls back to legacy JSON files.
 */
export async function parse() {
  if (existsSync(DB_PATH)) {
    try {
      return parseFromSqlite();
    } catch (err) {
      process.stderr.write(`warn: opencode sqlite parse failed (${err.message}), trying legacy json...\n`);
    }
  }
  return parseFromJson();
}

function parseFromSqlite() {
  const query = `SELECT
    session_id as sessionID,
    json_extract(data, '$.role') as role,
    json_extract(data, '$.time.created') as created,
    json_extract(data, '$.modelID') as modelID,
    json_extract(data, '$.tokens') as tokens,
    json_extract(data, '$.path.root') as rootPath
    FROM message`;

  let output;
  try {
    output = execFileSync('sqlite3', [
      '-json',
      DB_PATH,
      query,
    ], { encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024, timeout: 30000 });
  } catch (err) {
    if (err.status === 127 || (err.message && err.message.includes('ENOENT'))) {
      throw new Error('sqlite3 CLI not found. Install sqlite3 to sync opencode data.');
    }
    throw err;
  }

  output = output.trim();
  if (!output || output === '[]') return { buckets: [], sessions: [] };

  let rows;
  try {
    rows = JSON.parse(output);
  } catch {
    throw new Error('Failed to parse sqlite3 JSON output');
  }

  const entries = [];
  const sessionEvents = [];
  for (const row of rows) {
    const timestamp = new Date(row.created);
    if (isNaN(timestamp.getTime())) continue;

    const project = row.rootPath ? basename(row.rootPath) : 'unknown';
    const sessionId = row.sessionID || 'unknown';

    sessionEvents.push({
      sessionId,
      source: 'opencode',
      project,
      timestamp,
      role: row.role === 'user' ? 'user' : 'assistant',
    });

    if (!row.modelID) continue;
    let tokens;
    try {
      tokens = typeof row.tokens === 'string' ? JSON.parse(row.tokens) : row.tokens;
    } catch {
      continue;
    }
    if (!tokens || (!tokens.input && !tokens.output)) continue;

    entries.push({
      source: 'opencode',
      model: row.modelID || 'unknown',
      project,
      timestamp,
      inputTokens: tokens.input || 0,
      outputTokens: tokens.output || 0,
      cachedInputTokens: tokens.cache?.read || 0,
      reasoningOutputTokens: tokens.reasoning || 0,
    });
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(sessionEvents) };
}

function parseFromJson() {
  if (!existsSync(MESSAGES_DIR)) return { buckets: [], sessions: [] };

  const entries = [];
  const sessionEvents = [];
  let sessionDirs;
  try {
    sessionDirs = readdirSync(MESSAGES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith('ses_'));
  } catch {
    return { buckets: [], sessions: [] };
  }

  for (const sessionDir of sessionDirs) {
    const sessionPath = join(MESSAGES_DIR, sessionDir.name);
    let msgFiles;
    try {
      msgFiles = readdirSync(sessionPath).filter(f => f.endsWith('.json'));
    } catch {
      continue;
    }

    for (const file of msgFiles) {
      const filePath = join(sessionPath, file);

      let data;
      try {
        data = JSON.parse(readFileSync(filePath, 'utf-8'));
      } catch {
        continue;
      }

      const timestamp = new Date(data.time?.created);
      if (isNaN(timestamp.getTime())) continue;

      const rootPath = data.path?.root;
      const project = rootPath ? basename(rootPath) : 'unknown';

      sessionEvents.push({
        sessionId: sessionDir.name,
        source: 'opencode',
        project,
        timestamp,
        role: data.role === 'user' ? 'user' : 'assistant',
      });

      if (!data.modelID) continue;
      const tokens = data.tokens;
      if (!tokens) continue;
      if (!tokens.input && !tokens.output) continue;

      entries.push({
        source: 'opencode',
        model: data.modelID || 'unknown',
        project,
        timestamp,
        inputTokens: tokens.input || 0,
        outputTokens: tokens.output || 0,
        cachedInputTokens: tokens.cache?.read || 0,
        reasoningOutputTokens: tokens.reasoning || 0,
      });
    }
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(sessionEvents) };
}
