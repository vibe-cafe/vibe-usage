import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets } from './index.js';

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
  // Build WHERE clause: only messages with token data
  const conditions = [
    "(json_extract(data, '$.tokens.input') > 0 OR json_extract(data, '$.tokens.output') > 0)",
  ];

  const query = `SELECT data FROM message WHERE ${conditions.join(' AND ')}`;

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
  if (!output || output === '[]') return [];

  let rows;
  try {
    rows = JSON.parse(output);
  } catch {
    throw new Error('Failed to parse sqlite3 JSON output');
  }

  const entries = [];
  for (const row of rows) {
    let data;
    try {
      data = JSON.parse(row.data);
    } catch {
      continue;
    }

    if (!data.modelID) continue;

    const tokens = data.tokens;
    if (!tokens) continue;
    if (!tokens.input && !tokens.output) continue;

    const timestamp = new Date(data.time?.created);
    if (isNaN(timestamp.getTime())) continue;

    const rootPath = data.path?.root;
    const project = rootPath ? basename(rootPath) : 'unknown';

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

  return aggregateToBuckets(entries);
}

/** Legacy parser: reads JSON files from storage/message directories. */
function parseFromJson() {
  if (!existsSync(MESSAGES_DIR)) return [];

  const entries = [];
  let sessionDirs;
  try {
    sessionDirs = readdirSync(MESSAGES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith('ses_'));
  } catch {
    return [];
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

      if (!data.modelID) continue;

      const tokens = data.tokens;
      if (!tokens) continue;
      if (!tokens.input && !tokens.output) continue;

      const timestamp = new Date(data.time?.created);
      if (isNaN(timestamp.getTime())) continue;

      const rootPath = data.path?.root;
      const project = rootPath ? basename(rootPath) : 'unknown';

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

  return aggregateToBuckets(entries);
}
