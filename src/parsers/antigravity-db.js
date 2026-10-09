import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { queryDbJsonSnapshotOnLock, sqliteUnavailableError, isSqliteUnavailableError } from './sqlite.js';

/**
 * Offline reader for Antigravity SQLite conversation stores.
 *
 * Antigravity 2.0 (standalone app) and the `agy` CLI both persist each cascade
 * as a per-conversation SQLite `.db` file whose `gen_metadata` table holds one
 * protobuf-encoded GeneratorMetadata per row. Unlike the legacy `.pb` files
 * (which are encrypted/opaque and only decodable by a running language server),
 * these blobs are plain protobuf, so we can extract token usage directly from
 * disk — no running process, no RPC.
 *
 * The wire-format tag numbers below were cross-verified against the language
 * server's GetCascadeTrajectory JSON for the same responseId:
 *
 *   chatModel = field 1
 *     usage = field 4
 *       inputTokens          = 4.2
 *       outputTokens         = 4.3
 *       cacheReadTokens      = 4.5
 *       thinkingOutputTokens = 4.9
 *       responseId           = 4.11
 *     chatStartMetadata = field 9
 *       createdAt (Timestamp) = 9.4  → seconds = 9.4.1
 *     responseModel      = field 19  ("gemini-3-flash-a" / "gemini-default")
 *     modelDisplayName   = field 21  ("Gemini 3.5 Flash (High/Medium/Low)")
 *
 * Gemini 3.7 CLI blobs still have usage (4) and responseModel (19) but omit
 * 9.4 and 21. Timestamps are recovered from steps.metadata field 1.1 at the
 * same gen_metadata.idx; the model name falls back to responseModel.
 */

// ── Minimal protobuf wire-format decoder (no dependency) ──────────────

/** Read a base-128 varint. Returns [value: number, newPos]. */
function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return [Number(result), pos];
}

/**
 * Decode one protobuf message into Map<fieldNumber, Array<{wireType, value}>>.
 * Length-delimited values are kept as raw Buffers (caller decides string vs
 * sub-message). Unknown wire types abort parsing of the rest of the message.
 */
function decodeMessage(buf) {
  const fields = new Map();
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const fieldNum = tag >> 3;
    const wireType = tag & 0x7;
    let value;
    if (wireType === 0) {
      [value, pos] = readVarint(buf, pos);
    } else if (wireType === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      value = buf.subarray(pos, pos + len);
      pos += len;
    } else if (wireType === 5) {
      value = buf.subarray(pos, pos + 4);
      pos += 4;
    } else if (wireType === 1) {
      value = buf.subarray(pos, pos + 8);
      pos += 8;
    } else {
      break; // group/unknown — stop
    }
    if (!fields.has(fieldNum)) fields.set(fieldNum, []);
    fields.get(fieldNum).push({ wireType, value });
  }
  return fields;
}

function firstVarint(fields, num) {
  const arr = fields.get(num);
  const e = arr && arr.find((x) => x.wireType === 0);
  return e ? e.value : undefined;
}

function firstBytes(fields, num) {
  const arr = fields.get(num);
  const e = arr && arr.find((x) => x.wireType === 2);
  return e ? e.value : undefined;
}

function firstString(fields, num) {
  const b = firstBytes(fields, num);
  return b ? Buffer.from(b).toString('utf-8') : undefined;
}

function firstMessage(fields, num) {
  const b = firstBytes(fields, num);
  return b ? decodeMessage(b) : undefined;
}

// ── Usage message decoding ────────────────────────────────────────────

/**
 * Decode one ModelUsage message. The identical wire shape appears in three
 * carriers — `gen_metadata` chatModel.usage (1.4), that message's per-attempt
 * retry entries (1.17.2), and `steps.metadata` usage (9) with its retries
 * (28.2) — so every carrier shares this decoder:
 *
 *   modelId           = 1
 *   inputTokens       = 2
 *   totalOutputTokens = 3   (visible + thinking)
 *   cacheCreation     = 4
 *   cacheReadTokens   = 5
 *   provider          = 6
 *   messageId         = 7
 *   thinkingOutput    = 9
 *   visibleOutput     = 10
 *   responseId        = 11
 *   providerMessageId = 12
 *
 * Field 3 is the *total* output: verified on a live store where 3 = 9 + 10 on
 * every usage row. The bucket schema bills output + reasoning at the output
 * rate, so thinking must leave `outputTokens` here — leaving it inside counts
 * every thinking token a second time in 总 Token and once more in cost.
 */
function parseUsageMessage(usage) {
  const inputTokens = firstVarint(usage, 2) || 0;
  const totalOutputTokens = firstVarint(usage, 3) || 0;
  const cacheCreationTokens = firstVarint(usage, 4) || 0;
  const cacheReadTokens = firstVarint(usage, 5) || 0;
  const thinkingOutputTokens = firstVarint(usage, 9) || 0;
  const visibleOutputTokens = firstVarint(usage, 10);
  const outputTokens = visibleOutputTokens === undefined
    ? Math.max(0, totalOutputTokens - thinkingOutputTokens)
    : Math.min(visibleOutputTokens, totalOutputTokens);
  return {
    modelId: firstVarint(usage, 1) || 0,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    // Older blobs omit the visible/reasoning split; the remainder after the
    // visible part is thinking, and vice versa, so the two always sum to 3.
    thinkingOutputTokens: Math.max(thinkingOutputTokens, totalOutputTokens - outputTokens),
    messageId: firstString(usage, 7) || '',
    responseId: firstString(usage, 11) || '',
    providerMessageId: firstString(usage, 12) || '',
    totalOutputTokens,
  };
}

/** True when a decoded usage message carries any real token count. */
export function hasTokenUsage(usage) {
  return Boolean(usage && (usage.inputTokens || usage.totalOutputTokens ||
    usage.cacheCreationTokens || usage.cacheReadTokens || usage.thinkingOutputTokens));
}

/** Decode the usage of every retry entry carried at `fieldNumber` (2 = usage). */
function parseRetryUsages(fields, fieldNumber) {
  const out = [];
  for (const entry of fields.get(fieldNumber) || []) {
    if (entry.wireType !== 2) continue;
    const usage = firstMessage(decodeMessage(entry.value), 2);
    if (usage) out.push(parseUsageMessage(usage));
  }
  return out;
}

/**
 * Parse one gen_metadata blob into a normalized usage record, or null if it
 * carries no token usage (error/planning placeholders have none).
 *
 * @param {Buffer} buf raw protobuf bytes of a GeneratorMetadata row
 * @returns {{inputTokens, outputTokens, cacheReadTokens, thinkingOutputTokens,
 *            responseId, timestamp: Date|null, displayName, responseModel,
 *            retryUsages}|null}
 */
export function parseGenMetadataBlob(buf) {
  const chatModel = firstMessage(decodeMessage(buf), 1);
  if (!chatModel) return null;

  const usage = firstMessage(chatModel, 4);
  if (!usage) return null;

  const parsed = parseUsageMessage(usage);
  if (!hasTokenUsage(parsed)) return null;

  const chatStartMetadata = firstMessage(chatModel, 9);
  const createdAt = chatStartMetadata ? firstMessage(chatStartMetadata, 4) : undefined;
  const seconds = createdAt ? firstVarint(createdAt, 1) : undefined;

  return {
    ...parsed,
    timestamp: seconds ? new Date(seconds * 1000) : null,
    displayName: firstString(chatModel, 21) || '',
    responseModel: firstString(chatModel, 19) || '',
    retryUsages: parseRetryUsages(chatModel, 17),
  };
}

/**
 * Decode the usage a `steps.metadata` blob carries itself. Newer Antigravity
 * builds stop writing usage into `gen_metadata` while the step keeps it (field
 * 9), so a store can have a live step stream with no generator usage at all —
 * the exact shape where the parser used to go silently empty.
 *
 * @returns {{usage, retryUsages, modelName, modelId}} usage/entries may be null
 */
function decodeStepUsage(meta) {
  const usage = firstMessage(meta, 9);
  const modelInfo = firstMessage(meta, 24);
  return {
    usage: usage ? parseUsageMessage(usage) : null,
    retryUsages: parseRetryUsages(meta, 28),
    modelName: modelInfo ? (firstString(modelInfo, 12) || firstString(modelInfo, 8) || '') : '',
    modelId: modelInfo ? (firstVarint(modelInfo, 1) || 0) : 0,
  };
}

/** Parse one steps.metadata blob's own usage record (field 9 + retries). */
export function parseStepUsageBlob(buf) {
  return decodeStepUsage(decodeMessage(buf));
}

/**
 * Extract a step's own clock, regardless of step source. Field 1.1 is the
 * createdAt this parser has always used (Gemini 3.7 CLI gen_metadata blobs no
 * longer carry chatStartMetadata, so the step is the remaining clock); field 8
 * carries a completion timestamp on some builds and only fills in when 1.1 is
 * absent, so every timestamp that resolved before keeps its exact second.
 */
function stepTimestamp(meta) {
  let seconds;
  for (const fieldNumber of [1, 8]) {
    const message = firstMessage(meta, fieldNumber);
    seconds = message ? firstVarint(message, 1) : undefined;
    if (seconds) break;
  }
  if (!seconds) return null;
  const timestamp = new Date(seconds * 1000);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

/**
 * Extract a steps.metadata blob's own timestamp (see {@link stepTimestamp}).
 *
 * @param {Buffer} buf
 * @returns {Date|null}
 */
export function parseStepTimestamp(buf) {
  return stepTimestamp(decodeMessage(buf));
}

/**
 * Prefer the blob's own createdAt; if Gemini 3.7 omitted it, use the step
 * with the same idx. idx-join is exact on current CLI stores (every
 * gen_metadata idx exists in steps).
 *
 * @param {{timestamp: Date|null, idx?: number}} rec
 * @param {Map<number, Date>} stepTimestampsByIdx
 * @returns {Date|null}
 */
export function resolveUsageTimestamp(rec, stepTimestampsByIdx) {
  if (rec?.timestamp && !Number.isNaN(rec.timestamp.getTime())) return rec.timestamp;
  if (rec?.idx == null || !stepTimestampsByIdx) return null;
  const stepTs = stepTimestampsByIdx.get(rec.idx);
  if (stepTs && !Number.isNaN(stepTs.getTime())) return stepTs;
  return null;
}

// ── SQLite store reading ──────────────────────────────────────────────

function queryCascadeDb(conversationsDir, cascadeId, sql) {
  const dbPath = join(conversationsDir, `${cascadeId}.db`);
  try {
    // The App can hold the live DB open; queryDbJsonSnapshotOnLock copies the
    // WAL set to a temp dir and retries on "database is locked" so one active
    // cascade does not make the whole Antigravity parser go empty.
    return queryDbJsonSnapshotOnLock(dbPath, sql, { tempPrefix: 'vibe-usage-antigravity-' });
  } catch (err) {
    if (isSqliteUnavailableError(err)) throw sqliteUnavailableError('Antigravity');
    throw err;
  }
}

/** List cascade IDs backed by a `.db` file in a conversations directory. */
export function listDbCascades(conversationsDir, { strict = false } = {}) {
  try {
    const out = [];
    for (const f of readdirSync(conversationsDir)) {
      if (f.endsWith('.db') && f !== 'db.sqlite') out.push(f.slice(0, -3));
    }
    return out;
  } catch (err) {
    if (strict) throw err;
    return [];
  }
}

/**
 * Read all gen_metadata blobs from one cascade `.db` and return parsed usage
 * records. blob is fetched as hex text so it round-trips through both the
 * node:sqlite and sqlite3-CLI backends uniformly.
 */
export function readDbUsageRecords(conversationsDir, cascadeId, { strict = false } = {}) {
  let rows;
  try {
    rows = queryCascadeDb(conversationsDir, cascadeId, 'SELECT idx, hex(data) AS h FROM gen_metadata ORDER BY idx');
  } catch (err) {
    if (isSqliteUnavailableError(err) || strict) throw err;
    return [];
  }
  const records = [];
  for (const row of rows) {
    if (!row.h) continue;
    let rec;
    try {
      rec = parseGenMetadataBlob(Buffer.from(row.h, 'hex'));
    } catch {
      continue; // one malformed blob must not kill the rest
    }
    if (rec) {
      rec.idx = Number.isFinite(Number(row.idx)) ? Number(row.idx) : null;
      records.push(rec);
    }
  }
  return records;
}

/**
 * Read every `steps` row in one pass and derive everything the parser needs
 * from that same scan:
 *
 *  - `usages` — the usage each step carries itself (field 9, plus the field 28
 *    retry entries). Newer Antigravity builds keep the live usage here instead
 *    of `gen_metadata`, so a store whose generator rows carry no usage still
 *    has its tokens on the step.
 *  - `timestamps` — idx → clock for every step that has one, including the
 *    system/tool steps that produce no event. Used to timestamp gen_metadata
 *    rows that no longer embed chatStartMetadata.
 *  - `events` — user/assistant turns, chronological by idx, for session timing.
 *
 * Step source enum in steps.metadata field 3 (behavior-verified against payload
 * contents, since it mirrors the RPC's CORTEX_STEP_SOURCE_*): 4 = user turn,
 * 2 = model turn. Everything else (system, tool, unspecified) contributes a
 * timestamp and nothing else.
 */
export function readDbStepRows(conversationsDir, cascadeId, { strict = false } = {}) {
  let rows;
  try {
    rows = queryCascadeDb(
      conversationsDir,
      cascadeId,
      'SELECT idx, hex(metadata) AS h FROM steps WHERE metadata IS NOT NULL ORDER BY idx',
    );
  } catch (err) {
    if (isSqliteUnavailableError(err) || strict) throw err;
    return { usages: [], timestamps: new Map(), events: [] };
  }
  const usages = [];
  const timestamps = new Map();
  const events = [];
  for (const row of rows) {
    if (!row.h) continue;
    let meta;
    try {
      meta = decodeMessage(Buffer.from(row.h, 'hex'));
    } catch {
      continue; // one malformed blob must not kill the rest
    }
    const idx = Number(row.idx);
    const timestamp = stepTimestamp(meta);
    if (timestamp && Number.isFinite(idx)) timestamps.set(idx, timestamp);

    const source = firstVarint(meta, 3);
    const role = source === STEP_SOURCE_USER
      ? 'user'
      : source === STEP_SOURCE_MODEL ? 'assistant' : null;
    if (role && timestamp) events.push({ role, timestamp });

    const stepUsage = decodeStepUsage(meta);
    if (!stepUsage.usage && stepUsage.retryUsages.length === 0) continue;
    usages.push({
      idx: Number.isFinite(idx) ? idx : null,
      timestamp,
      modelName: stepUsage.modelName,
      modelId: stepUsage.modelId,
      usage: stepUsage.usage,
      retryUsages: stepUsage.retryUsages,
    });
  }
  return { usages, timestamps, events };
}

/**
 * Read the workspace URI for a cascade from trajectory_metadata_blob.
 * Structure: field 1 = workspaces[0], 1.1 = workspaceFolderAbsoluteUri.
 * Returns the raw file:// URI, or null.
 */
export function readDbWorkspaceUri(conversationsDir, cascadeId) {
  let rows;
  try {
    rows = queryCascadeDb(conversationsDir, cascadeId, 'SELECT hex(data) AS h FROM trajectory_metadata_blob LIMIT 1');
  } catch (err) {
    if (isSqliteUnavailableError(err)) throw err;
    return null;
  }
  if (!rows.length || !rows[0].h) return null;
  try {
    const meta = decodeMessage(Buffer.from(rows[0].h, 'hex'));
    const ws0 = firstMessage(meta, 1);
    return (ws0 && firstString(ws0, 1)) || null;
  } catch {
    return null;
  }
}

// Step source enum in steps.metadata field 3 (behavior-verified against payload
// contents, since it mirrors the RPC's CORTEX_STEP_SOURCE_*): 4 = user turn,
// 2 = model turn. Everything else (system, tool, unspecified) is skipped.
const STEP_SOURCE_USER = 4;
const STEP_SOURCE_MODEL = 2;
