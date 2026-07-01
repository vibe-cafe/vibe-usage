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
const ESTIMATE_MODEL = 'kiro-token-estimate';
const CHARS_PER_TOKEN = 4;

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

export function getKiroCliDbPath() {
  const explicit = process.env.KIRO_CLI_DB_PATH?.trim();
  if (explicit) {
    const r = resolve(explicit);
    return existsSync(r) ? r : null;
  }
  let def;
  if (process.platform === 'darwin') {
    def = join(homedir(), 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3');
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
    def = join(appData, 'kiro-cli', 'data.sqlite3');
  } else {
    def = join(homedir(), '.local', 'share', 'kiro-cli', 'data.sqlite3');
  }
  return existsSync(def) ? def : null;
}

export function getKiroSessionsDir() {
  const explicit = process.env.KIRO_SESSIONS_DIR?.trim();
  if (explicit) {
    const r = resolve(explicit);
    return existsSync(r) ? r : null;
  }
  const def = join(homedir(), '.kiro_sessions');
  return existsSync(def) ? def : null;
}

function isLockError(err) {
  return err && typeof err.message === 'string' && /database is locked/i.test(err.message);
}

function queryDb(dbPath, sql) {
  return queryDbJson(dbPath, sql);
}

function queryDbSnapshotOnLock(dbPath, sql) {
  try {
    return queryDb(dbPath, sql);
  } catch (err) {
    if (!isLockError(err)) throw err;
    const snapshotDir = mkdtempSync(join(tmpdir(), 'vibe-usage-kiro-'));
    const queryPath = join(snapshotDir, 'data.sqlite3');
    copyFileSync(dbPath, queryPath);
    for (const suffix of ['-shm', '-wal']) {
      const companion = `${dbPath}${suffix}`;
      if (existsSync(companion)) copyFileSync(companion, `${queryPath}${suffix}`);
    }
    try {
      return queryDb(queryPath, sql);
    } finally {
      rmSync(snapshotDir, { recursive: true, force: true });
    }
  }
}

function queryOptionalDb(dbPath, sql) {
  try {
    return queryDbSnapshotOnLock(dbPath, sql);
  } catch (err) {
    const msg = err && typeof err.message === 'string' ? err.message : '';
    if (/no such table|no such column/i.test(msg)) return [];
    throw err;
  }
}

const TOKENS_SQL =
  'SELECT id, model, tokens_prompt, tokens_generated, timestamp ' +
  'FROM tokens_generated ' +
  'WHERE tokens_prompt > 0 OR tokens_generated > 0 ' +
  'ORDER BY id ASC';

function readLegacyDb(dbPath) {
  return queryDbSnapshotOnLock(dbPath, TOKENS_SQL);
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
        model: obj.model || ESTIMATE_MODEL,
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
  if (!model || model.toLowerCase() === 'agent') return ESTIMATE_MODEL;
  if (model === model.toLowerCase() && model.includes('-')) return model;
  return model
    .replace(/_\d{8}_V\d+_\d+$/i, '')
    .replace(/_V\d+$/i, '')
    .toLowerCase()
    .replace(/_/g, '-') || ESTIMATE_MODEL;
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

function textLength(field) {
  if (!field) return 0;
  if (typeof field !== 'object' || Array.isArray(field)) return String(field).length;
  let len = 0;
  for (const [key, value] of Object.entries(field)) {
    if (key === 'images') continue;
    len += String(value ?? '').length;
  }
  return len;
}

function imageTokens(field) {
  if (!field || typeof field !== 'object' || Array.isArray(field)) return 0;
  const images = field.images;
  if (!Array.isArray(images)) return 0;
  let total = 0;
  for (const image of images) {
    const source = image && typeof image === 'object' ? image.source || {} : {};
    const rawData = source.Bytes;
    try {
      let buf;
      if (Array.isArray(rawData)) {
        buf = Buffer.from(rawData);
      } else if (typeof rawData === 'string') {
        buf = Buffer.from(rawData, 'base64');
      }
      if (buf?.length >= 24 && buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
        total += Math.floor((buf.readUInt32BE(16) * buf.readUInt32BE(20)) / 750);
        continue;
      }
    } catch {
      // fall back below
    }
    total += 1600;
  }
  return total;
}

function estimateTextTokens(field) {
  return Math.floor(textLength(field) / CHARS_PER_TOKEN);
}

function normalizeCliModel(raw) {
  const model = typeof raw === 'string' ? raw.trim() : '';
  return model || ESTIMATE_MODEL;
}

function parseMsTimestamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return isNaN(d.getTime()) ? null : d;
}

function extractConversationTimes(data) {
  const turns = Array.isArray(data?.history) ? data.history : [];
  const first = turns[0]?.request_metadata?.request_start_timestamp_ms;
  const last = turns[turns.length - 1]?.request_metadata?.request_start_timestamp_ms;
  return {
    createdAt: Number(first) || 0,
    updatedAt: Number(last) || Number(first) || 0,
  };
}

function conversationToEntries(conversation) {
  const data = conversation?.value;
  const turns = Array.isArray(data?.history) ? data.history : [];
  const summary = data?.latest_summary || [];
  const summaryTokens = summary ? Math.floor(String(summary).length / CHARS_PER_TOKEN) : 0;
  let cumulative = summaryTokens;
  let prevAssistantTokens = 0;
  const entries = [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i] || {};
    const meta = turn.request_metadata || {};
    const timestamp = parseMsTimestamp(meta.request_start_timestamp_ms);
    if (!timestamp) continue;

    const userTokens = estimateTextTokens(turn.user) + imageTokens(turn.user);
    const assistantTokens = estimateTextTokens(turn.assistant);
    const outputTokens = Array.isArray(meta.time_between_chunks) ? meta.time_between_chunks.length : 0;
    const cachedInputTokens = i > 0 ? cumulative : 0;
    const inputTokens = userTokens + (i > 0 ? prevAssistantTokens : 0);

    cumulative += userTokens + assistantTokens;
    prevAssistantTokens = assistantTokens;

    if (inputTokens === 0 && outputTokens === 0 && cachedInputTokens === 0) continue;
    entries.push({
      source: 'kiro',
      model: normalizeCliModel(meta.model_id),
      project: conversation.cwd || 'unknown',
      timestamp,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningOutputTokens: 0,
    });
  }

  return entries;
}

export function conversationsToEstimateEntries(conversations) {
  const entries = [];
  const byId = new Map();
  for (const conversation of conversations) {
    const id = conversation?.conversation_id;
    if (!id) continue;
    const updatedAt = Number(conversation.updated_at) || 0;
    const existing = byId.get(id);
    if (!existing || updatedAt >= (Number(existing.updated_at) || 0)) {
      byId.set(id, conversation);
    }
  }
  for (const conversation of byId.values()) {
    entries.push(...conversationToEntries(conversation));
  }
  return entries;
}

function readArchivedConversations(sessionsDir) {
  if (!sessionsDir) return [];
  let files;
  try {
    files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const conversations = [];
  for (const file of files) {
    try {
      const obj = JSON.parse(readFileSync(join(sessionsDir, file), 'utf-8'));
      if (obj?.conversation_id && obj?.value) conversations.push(obj);
    } catch {
      // skip malformed archives
    }
  }
  return conversations;
}

function readCliDbConversations(dbPath) {
  if (!dbPath) return [];
  const conversations = [];
  for (const row of queryOptionalDb(
    dbPath,
    'SELECT conversation_id, key as cwd, created_at, updated_at, value FROM conversations_v2',
  )) {
    try {
      conversations.push({
        conversation_id: row.conversation_id,
        cwd: row.cwd || 'unknown',
        created_at: Number(row.created_at) || 0,
        updated_at: Number(row.updated_at) || 0,
        value: JSON.parse(row.value),
      });
    } catch {
      // skip malformed conversations
    }
  }

  for (const row of queryOptionalDb(dbPath, 'SELECT key as cwd, value FROM conversations')) {
    try {
      const data = JSON.parse(row.value);
      const conversationId = data?.conversation_id;
      if (!conversationId) continue;
      const { createdAt, updatedAt } = extractConversationTimes(data);
      conversations.push({
        conversation_id: conversationId,
        cwd: row.cwd || 'unknown',
        created_at: createdAt,
        updated_at: updatedAt,
        value: data,
      });
    } catch {
      // skip malformed conversations
    }
  }
  return conversations;
}

function readCliEstimateEntries() {
  const conversations = [
    ...readArchivedConversations(getKiroSessionsDir()),
    ...readCliDbConversations(getKiroCliDbPath()),
  ];
  return conversationsToEstimateEntries(conversations);
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
  try {
    const estimateEntries = readCliEstimateEntries();
    if (estimateEntries.length > 0) {
      return { buckets: aggregateToBuckets(estimateEntries), sessions: [] };
    }
  } catch (err) {
    if (err && typeof err.message === 'string' && err.message.includes('ENOENT')) {
      throw new Error('sqlite3 CLI not found. Install sqlite3 (or use Node >= 22.5) to sync Kiro CLI data.');
    }
    throw err;
  }

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
