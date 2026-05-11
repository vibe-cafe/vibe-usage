import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { aggregateToBuckets } from './index.js';
import { queryDbJson } from './sqlite.js';

const KIROAGENT_RELATIVE = join('User', 'globalStorage', 'kiro.kiroagent');

function getDefaultBasePath() {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Kiro', KIROAGENT_RELATIVE);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Kiro', KIROAGENT_RELATIVE);
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(xdgConfigHome, 'Kiro', KIROAGENT_RELATIVE);
}

export function getKiroBasePath() {
  const explicit = process.env.KIRO_BASE_PATH?.trim();
  if (explicit) {
    const r = resolve(explicit);
    return existsSync(r) ? r : null;
  }
  const def = getDefaultBasePath();
  return existsSync(def) ? def : null;
}

function isLockError(err) {
  return err && typeof err.message === 'string' && /database is locked/i.test(err.message);
}

function queryDb(dbPath, sql) {
  return queryDbJson(dbPath, sql);
}

const TOKENS_SQL =
  'SELECT id, model, tokens_prompt, tokens_generated, timestamp ' +
  'FROM tokens_generated ' +
  'WHERE tokens_prompt > 0 OR tokens_generated > 0 ' +
  'ORDER BY id ASC';

function readDb(dbPath) {
  try {
    return queryDb(dbPath, TOKENS_SQL);
  } catch (err) {
    if (!isLockError(err)) throw err;
    // Kiro app holds a write lock; snapshot WAL set to a temp dir and retry.
    const snapshotDir = mkdtempSync(join(tmpdir(), 'vibe-usage-kiro-'));
    const queryPath = join(snapshotDir, 'devdata.sqlite');
    copyFileSync(dbPath, queryPath);
    for (const suffix of ['-shm', '-wal']) {
      const companion = `${dbPath}${suffix}`;
      if (existsSync(companion)) copyFileSync(companion, `${queryPath}${suffix}`);
    }
    try {
      return queryDb(queryPath, TOKENS_SQL);
    } finally {
      rmSync(snapshotDir, { recursive: true, force: true });
    }
  }
}

// JSONL fallback: tokens_generated.jsonl. Each line:
// {"model":"agent","provider":"kiro","promptTokens":N,"generatedTokens":N}
// No per-row timestamp — bucket all rows under the file mtime.
function readJsonl(jsonlPath) {
  let raw;
  try { raw = readFileSync(jsonlPath, 'utf-8'); } catch { return []; }
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  let mtime;
  try { mtime = statSync(jsonlPath).mtime; } catch { mtime = new Date(); }
  const ts = mtime.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]);
      rows.push({
        id: i + 1,
        model: obj.model || 'agent',
        tokens_prompt: obj.promptTokens || 0,
        tokens_generated: obj.generatedTokens || 0,
        timestamp: ts,
      });
    } catch {
      // skip malformed lines
    }
  }
  return rows;
}

// Walk workspace dirs under kiro.kiroagent/ and collect every .chat file's
// modelId + start/end window. Used to attribute each tokens_generated row to
// a real model (the SQLite `model` column is usually the literal "agent").
function buildModelTimeline(base) {
  const timeline = [];
  let entries;
  try { entries = readdirSync(base, { withFileTypes: true }); } catch { return timeline; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'dev_data') continue;
    const dirPath = join(base, entry.name);
    let files;
    try {
      files = readdirSync(dirPath).filter(f => f.endsWith('.chat'));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(dirPath, file), 'utf-8'));
        const meta = data?.metadata;
        if (!meta?.modelId || !meta?.startTime) continue;
        const startMs = Number(meta.startTime);
        const endMs = Number(meta.endTime || meta.startTime);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
        timeline.push({ startMs, endMs, model: String(meta.modelId) });
      } catch {
        // skip unreadable / malformed chat files
      }
    }
  }
  timeline.sort((a, b) => a.startMs - b.startMs);
  return timeline;
}

function resolveModel(timeline, ts) {
  if (!timeline.length || !ts) return null;
  const t = ts.getTime();
  if (!Number.isFinite(t)) return null;
  let best = null;
  let bestDist = Infinity;
  for (const e of timeline) {
    if (t >= e.startMs && t <= e.endMs) return e.model;
    const d = Math.min(Math.abs(t - e.startMs), Math.abs(t - e.endMs));
    if (d < bestDist) { bestDist = d; best = e.model; }
  }
  // 10-minute tolerance — beyond that, treat as no match.
  return bestDist < 10 * 60 * 1000 ? best : null;
}

// "CLAUDE_SONNET_4_20250514_V1_0" -> "claude-sonnet-4"
function normalizeModelName(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === trimmed.toLowerCase() && trimmed.includes('-')) return trimmed;
  const cleaned = trimmed
    .replace(/_\d{8}_V\d+_\d+$/i, '')
    .replace(/_V\d+$/i, '')
    .toLowerCase()
    .replace(/_/g, '-');
  return cleaned || null;
}

function parseDbTimestamp(value) {
  if (!value) return null;
  // SQLite CURRENT_TIMESTAMP: "2026-01-09 15:25:30" (UTC, naive — append Z).
  const d = new Date(String(value).trim().replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

export async function parse() {
  const base = getKiroBasePath();
  if (!base) return { buckets: [], sessions: [] };

  const dbPath = join(base, 'dev_data', 'devdata.sqlite');
  const jsonlPath = join(base, 'dev_data', 'tokens_generated.jsonl');

  let rows;
  try {
    if (existsSync(dbPath)) {
      rows = readDb(dbPath);
    } else if (existsSync(jsonlPath)) {
      rows = readJsonl(jsonlPath);
    } else {
      return { buckets: [], sessions: [] };
    }
  } catch (err) {
    if (err && typeof err.message === 'string' && err.message.includes('ENOENT')) {
      throw new Error('sqlite3 CLI not found. Install sqlite3 (or use Node >= 22.5) to sync Kiro data.');
    }
    throw err;
  }

  if (!rows.length) return { buckets: [], sessions: [] };

  const timeline = buildModelTimeline(base);
  const entries = [];
  for (const row of rows) {
    const inputTokens = Math.max(0, Number(row.tokens_prompt) || 0);
    const outputTokens = Math.max(0, Number(row.tokens_generated) || 0);
    if (inputTokens === 0 && outputTokens === 0) continue;
    const timestamp = parseDbTimestamp(row.timestamp);
    if (!timestamp) continue;

    // Prefer the .chat timeline; fall back to the row's literal model (skip
    // the placeholder "agent"); then "kiro-agent".
    let model = normalizeModelName(resolveModel(timeline, timestamp));
    if (!model) {
      const literal = (row.model || '').trim();
      if (literal && literal.toLowerCase() !== 'agent') {
        model = normalizeModelName(literal);
      }
    }
    if (!model) model = 'kiro-agent';

    entries.push({
      source: 'kiro',
      model,
      project: 'unknown',
      timestamp,
      inputTokens,
      outputTokens,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
    });
  }

  return { buckets: aggregateToBuckets(entries), sessions: [] };
}
