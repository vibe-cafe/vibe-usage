import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets } from './index.js';

function getDefaultLogDir() {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Cursor', 'logs');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim();
    return appData ? join(appData, 'Cursor', 'logs') : join(homedir(), 'AppData', 'Roaming', 'Cursor', 'logs');
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(xdgConfigHome, 'Cursor', 'logs');
}

export function getCursorLogDir() {
  const explicit = process.env.CURSOR_LOG_DIR?.trim();
  if (explicit) return explicit;
  return getDefaultLogDir();
}

async function findLogFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await findLogFiles(full);
      out.push(...sub);
    } else if (entry.isFile() && entry.name.endsWith('.log')) {
      out.push(full);
    }
  }
  return out.sort();
}

function extractJsonObject(text, startIndex) {
  const jsonStart = text.indexOf('{', startIndex);
  if (jsonStart === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = jsonStart; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) { escape = false; }
      else if (ch === '\\') { escape = true; }
      else if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; }
    else if (ch === '{') { depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(jsonStart, i + 1);
    }
  }
  return null;
}

function extractTimestampBefore(text, markerIndex) {
  const before = text.slice(0, markerIndex);
  const match = /\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\]/g;
  let last = null;
  let m;
  while ((m = match.exec(before)) !== null) {
    last = m[1];
  }
  return last;
}

function parseProjectFromRoots(workspaceRoots) {
  if (!Array.isArray(workspaceRoots) || workspaceRoots.length === 0) return 'unknown';
  const root = workspaceRoots[0];
  const parts = root.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : 'unknown';
}

function n(v) {
  const num = Number(v);
  return Number.isFinite(num) ? num : 0;
}

async function parseLogFiles(logDir) {
  const files = await findLogFiles(logDir);
  if (files.length === 0) return [];

  const entries = [];
  for (const filePath of files) {
    let text;
    try {
      text = await readFile(filePath, 'utf8');
    } catch {
      continue;
    }
    let cursor = 0;
    while (cursor < text.length) {
      const markerIndex = text.indexOf('INPUT:', cursor);
      if (markerIndex === -1) break;

      const jsonText = extractJsonObject(text, markerIndex + 6);
      cursor = markerIndex + 6;
      if (!jsonText) continue;

      let raw;
      try {
        raw = JSON.parse(jsonText);
      } catch {
        continue;
      }

      const prompt = n(raw.input_tokens ?? raw.prompt_tokens);
      const output = n(raw.output_tokens ?? raw.completion_tokens);
      const cacheRead = n(raw.cache_read_tokens ?? raw.cache_read_input_tokens);
      const cacheWrite = n(raw.cache_write_tokens ?? raw.cache_creation_input_tokens);
      const reasoning = n(raw.reasoning_tokens ?? raw.reasoning_output_tokens);
      if (prompt + output + reasoning === 0) continue;

      const ts = raw.timestamp
        ? new Date(raw.timestamp)
        : new Date(extractTimestampBefore(text, markerIndex) || '1970-01-01T00:00:00.000Z');

      const isClaudeLike = raw.model && (raw.model.startsWith('gpt-5.') || raw.model.startsWith('claude-'));
      const inputTokens = isClaudeLike
        ? Math.max(prompt - cacheRead - cacheWrite, 0)
        : prompt;

      entries.push({
        source: 'cursor',
        model: raw.model || 'unknown',
        project: parseProjectFromRoots(raw.workspace_roots),
        timestamp: ts,
        inputTokens,
        outputTokens: output,
        cachedInputTokens: cacheRead,
        reasoningOutputTokens: reasoning,
      });
    }
  }
  return entries;
}

export async function parse() {
  const logDir = getCursorLogDir();
  const entries = await parseLogFiles(logDir);
  if (entries.length === 0) return { buckets: [], sessions: [] };
  return { buckets: aggregateToBuckets(entries), sessions: [] };
}
