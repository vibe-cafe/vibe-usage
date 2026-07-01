import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { aggregateToBuckets } from './index.js';
import { queryDbJson } from './sqlite.js';

const KIRO_AGENT_RELATIVE = join('User', 'globalStorage', 'kiro.kiroagent');
const KIRO_USER_RELATIVE = 'User';
const CREDIT_MODEL = 'kiro-credits';

function getDefaultAppPath() {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Kiro');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Kiro');
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(xdgConfigHome, 'Kiro');
}

function getDefaultUserPath() {
  return join(getDefaultAppPath(), KIRO_USER_RELATIVE);
}

export function getKiroBasePath() {
  const explicit = process.env.KIRO_BASE_PATH?.trim();
  if (explicit) {
    const r = resolve(explicit);
    return existsSync(r) ? r : null;
  }
  const def = join(getDefaultAppPath(), KIRO_AGENT_RELATIVE);
  return existsSync(def) ? def : null;
}

export function getKiroUserPath() {
  const explicitUser = process.env.KIRO_USER_PATH?.trim();
  if (explicitUser) {
    const r = resolve(explicitUser);
    return existsSync(r) ? r : null;
  }

  const explicitBase = process.env.KIRO_BASE_PATH?.trim();
  if (explicitBase) {
    const base = resolve(explicitBase);
    const userPath = resolve(base, '..', '..');
    return existsSync(userPath) ? userPath : null;
  }

  const def = getDefaultUserPath();
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

function readLegacyDb(dbPath) {
  try {
    return queryDb(dbPath, TOKENS_SQL);
  } catch (err) {
    if (!isLockError(err)) throw err;
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

// Legacy Kiro dev telemetry fallback. This is opt-in because recent Kiro builds
// bill by server-side credits, while this table is often empty, estimated, or
// populated with placeholder model names such as "agent".
function readLegacyJsonl(jsonlPath) {
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
        model: obj.model || 'kiro-token-estimate',
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

function parseDbTimestamp(value) {
  if (!value) return null;
  const s = String(value).trim();
  const hasZone = /(?:Z|[+-]\d\d:?\d\d)$/.test(s);
  const d = new Date(hasZone ? s.replace(' ', 'T') : `${s.replace(' ', 'T')}Z`);
  return isNaN(d.getTime()) ? null : d;
}

function normalizeLegacyModel(raw) {
  const model = typeof raw === 'string' ? raw.trim() : '';
  if (!model || model.toLowerCase() === 'agent') return 'kiro-token-estimate';
  if (model === model.toLowerCase() && model.includes('-')) return model;
  return model
    .replace(/_\d{8}_V\d+_\d+$/i, '')
    .replace(/_V\d+$/i, '')
    .toLowerCase()
    .replace(/_/g, '-') || 'kiro-token-estimate';
}

function rowsToLegacyEntries(rows) {
  const entries = [];
  for (const row of rows) {
    const inputTokens = Math.max(0, Number(row.tokens_prompt) || 0);
    const outputTokens = Math.max(0, Number(row.tokens_generated) || 0);
    if (inputTokens === 0 && outputTokens === 0) continue;
    const timestamp = parseDbTimestamp(row.timestamp);
    if (!timestamp) continue;
    entries.push({
      source: 'kiro',
      model: normalizeLegacyModel(row.model),
      project: 'unknown',
      timestamp,
      inputTokens,
      outputTokens,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
    });
  }
  return entries;
}

function parseLogTimestamp(raw) {
  const d = new Date(String(raw).replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

function parseLogLine(line) {
  const match = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}) \[[^\]]+\] (\{.*\})$/.exec(line);
  if (!match) return null;
  const timestamp = parseLogTimestamp(match[1]);
  if (!timestamp) return null;
  try {
    return { timestamp, obj: JSON.parse(match[2]) };
  } catch {
    return null;
  }
}

function usageBreakdownsFromCommand(obj) {
  if (obj?.commandName !== 'GetUsageLimitsCommand') return [];
  const out = obj.output || {};
  if (Array.isArray(out.usageBreakdownList)) return out.usageBreakdownList;
  if (Array.isArray(out.usageBreakdowns)) return out.usageBreakdowns;
  return [];
}

function numberFrom(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function maxNumberFrom(...values) {
  const nums = values
    .map(value => Number(value))
    .filter(Number.isFinite);
  if (nums.length === 0) return null;
  return Math.max(...nums);
}

function snapshotFromBreakdown(timestamp, breakdown) {
  const type = String(breakdown.resourceType || breakdown.type || '').toUpperCase();
  const unit = String(breakdown.unit || '').toUpperCase();
  if (type !== 'CREDIT' || unit !== 'INVOCATIONS') return null;

  const currentUsage = maxNumberFrom(
    breakdown.currentUsageWithPrecision,
    breakdown.currentUsage,
    breakdown.freeTrialInfo?.currentUsageWithPrecision,
    breakdown.freeTrialInfo?.currentUsage,
    breakdown.freeTrialUsage?.currentUsage,
  );
  if (currentUsage === null) return null;

  return {
    timestamp,
    currentUsage,
    resetDate: String(breakdown.nextDateReset || breakdown.resetDate || ''),
    usageLimit: numberFrom(
      breakdown.usageLimitWithPrecision,
      breakdown.usageLimit,
      breakdown.freeTrialInfo?.usageLimitWithPrecision,
      breakdown.freeTrialInfo?.usageLimit,
      breakdown.freeTrialUsage?.usageLimit,
    ),
  };
}

function findQClientLogs(logsRoot) {
  const files = [];
  const stack = [logsRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
      } else if (entry.isFile() && /^q-client\.log(?:\.\d+)?$/.test(entry.name)) {
        files.push(p);
      }
    }
  }
  return files.sort();
}

async function readLogSnapshots(logPath) {
  const snapshots = [];
  const rl = createInterface({
    input: createReadStream(logPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const parsed = parseLogLine(line);
    if (!parsed) continue;
    for (const breakdown of usageBreakdownsFromCommand(parsed.obj)) {
      const snapshot = snapshotFromBreakdown(parsed.timestamp, breakdown);
      if (snapshot) snapshots.push(snapshot);
    }
  }
  return snapshots;
}

async function readUsageSnapshots(userPath) {
  const appPath = dirname(userPath);
  const logsRoot = join(appPath, 'logs');
  const files = findQClientLogs(logsRoot);
  const snapshots = [];
  for (const file of files) {
    try {
      snapshots.push(...await readLogSnapshots(file));
    } catch {
      // skip unreadable / concurrently rotated logs
    }
  }
  return snapshots;
}

function dedupeSnapshots(snapshots) {
  const map = new Map();
  for (const s of snapshots) {
    const key = `${s.timestamp.toISOString()}|${s.resetDate}|${s.currentUsage}`;
    map.set(key, s);
  }
  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
}

export function snapshotsToCreditEntries(snapshots) {
  const ordered = dedupeSnapshots(snapshots);
  const entries = [];
  let prev = null;

  for (const snapshot of ordered) {
    if (!prev || snapshot.resetDate !== prev.resetDate || snapshot.currentUsage < prev.currentUsage) {
      prev = snapshot;
      continue;
    }

    const delta = Number((snapshot.currentUsage - prev.currentUsage).toFixed(4));
    if (delta > 0) {
      entries.push({
        source: 'kiro',
        model: CREDIT_MODEL,
        project: 'unknown',
        timestamp: snapshot.timestamp,
        inputTokens: 0,
        outputTokens: delta,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
      });
    }
    prev = snapshot;
  }

  return entries;
}

function parseLegacyTokens(base) {
  const dbPath = join(base, 'dev_data', 'devdata.sqlite');
  const jsonlPath = join(base, 'dev_data', 'tokens_generated.jsonl');
  let rows;
  if (existsSync(dbPath)) {
    rows = readLegacyDb(dbPath);
  } else if (existsSync(jsonlPath)) {
    rows = readLegacyJsonl(jsonlPath);
  } else {
    rows = [];
  }
  return rowsToLegacyEntries(rows);
}

export async function parse() {
  const userPath = getKiroUserPath();
  if (!userPath) return { buckets: [], sessions: [] };

  const snapshots = await readUsageSnapshots(userPath);
  const entries = snapshotsToCreditEntries(snapshots);
  if (entries.length > 0) {
    return { buckets: aggregateToBuckets(entries), sessions: [] };
  }

  // Keep old token telemetry available for explicit debugging, but do not use
  // it by default: it is not Kiro's billing source and causes false model rows.
  if (process.env.VIBE_USAGE_KIRO_LEGACY_TOKENS === '1') {
    const base = getKiroBasePath();
    if (!base) return { buckets: [], sessions: [] };
    const legacyEntries = parseLegacyTokens(base);
    return { buckets: aggregateToBuckets(legacyEntries), sessions: [] };
  }

  // state.vscdb contains only the latest cumulative credit snapshot. The parser
  // stays stateless, so a single cumulative point cannot be uploaded as a bucket
  // without double-counting on later syncs.
  return { buckets: [], sessions: [] };
}
