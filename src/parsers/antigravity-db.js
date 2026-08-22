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

// ── GeneratorMetadata parsing ─────────────────────────────────────────

/**
 * Parse one gen_metadata blob into a normalized usage record, or null if it
 * carries no token usage (error/planning placeholders have none).
 *
 * @param {Buffer} buf raw protobuf bytes of a GeneratorMetadata row
 * @returns {{inputTokens, outputTokens, cacheReadTokens, thinkingOutputTokens,
 *            responseId, timestamp: Date|null, displayName, responseModel}|null}
 */
export function parseGenMetadataBlob(buf) {
  const chatModel = firstMessage(decodeMessage(buf), 1);
  if (!chatModel) return null;

  const usage = firstMessage(chatModel, 4);
  if (!usage) return null;

  const inputTokens = firstVarint(usage, 2) || 0;
  const outputTokens = firstVarint(usage, 3) || 0;
  const cacheReadTokens = firstVarint(usage, 5) || 0;
  const thinkingOutputTokens = firstVarint(usage, 9) || 0;
  const responseId = firstString(usage, 11) || '';

  // Skip rows with no real usage (errors, planning-only steps).
  if (!inputTokens && !outputTokens && !cacheReadTokens && !thinkingOutputTokens) {
    return null;
  }

  const chatStartMetadata = firstMessage(chatModel, 9);
  const createdAt = chatStartMetadata ? firstMessage(chatStartMetadata, 4) : undefined;
  const seconds = createdAt ? firstVarint(createdAt, 1) : undefined;
  const timestamp = seconds ? new Date(seconds * 1000) : null;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    thinkingOutputTokens,
    responseId,
    timestamp,
    displayName: firstString(chatModel, 21) || '',
    responseModel: firstString(chatModel, 19) || '',
  };
}

/**
 * Extract createdAt seconds from a steps.metadata blob, regardless of step
 * source. Gemini 3.7 CLI gen_metadata blobs no longer carry chatStartMetadata
 * (field 9.4); the step timestamp at field 1.1 is the remaining clock.
 *
 * @param {Buffer} buf
 * @returns {Date|null}
 */
export function parseStepTimestamp(buf) {
  const meta = decodeMessage(buf);
  const createdAt = firstMessage(meta, 1);
  const seconds = createdAt ? firstVarint(createdAt, 1) : undefined;
  if (!seconds) return null;
  const timestamp = new Date(seconds * 1000);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
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
export function listDbCascades(conversationsDir) {
  try {
    const out = [];
    for (const f of readdirSync(conversationsDir)) {
      if (f.endsWith('.db') && f !== 'db.sqlite') out.push(f.slice(0, -3));
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Read all gen_metadata blobs from one cascade `.db` and return parsed usage
 * records. blob is fetched as hex text so it round-trips through both the
 * node:sqlite and sqlite3-CLI backends uniformly.
 */
export function readDbUsageRecords(conversationsDir, cascadeId) {
  let rows;
  try {
    rows = queryCascadeDb(conversationsDir, cascadeId, 'SELECT idx, hex(data) AS h FROM gen_metadata ORDER BY idx');
  } catch (err) {
    if (isSqliteUnavailableError(err)) throw err;
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
 * Map steps.idx → createdAt for every step that has a timestamp, including
 * system/tool steps that parseStepMetadata skips. Used to timestamp 3.7
 * gen_metadata rows that no longer embed chatStartMetadata.
 */
export function readDbStepTimestamps(conversationsDir, cascadeId) {
  let rows;
  try {
    rows = queryCascadeDb(
      conversationsDir,
      cascadeId,
      'SELECT idx, hex(metadata) AS h FROM steps WHERE metadata IS NOT NULL ORDER BY idx',
    );
  } catch (err) {
    if (isSqliteUnavailableError(err)) throw err;
    return new Map();
  }
  const byIdx = new Map();
  for (const row of rows) {
    if (!row.h) continue;
    let ts;
    try {
      ts = parseStepTimestamp(Buffer.from(row.h, 'hex'));
    } catch {
      continue;
    }
    if (!ts) continue;
    const idx = Number(row.idx);
    if (Number.isFinite(idx)) byIdx.set(idx, ts);
  }
  return byIdx;
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

/**
 * Parse one steps.metadata blob into a session-timing event, or null if the
 * step is neither a user nor a model turn (system/tool/unspecified). createdAt
 * is a Timestamp at field 1 (seconds at 1.1); source enum is field 3.
 *
 * @param {Buffer} buf
 * @returns {{role:'user'|'assistant', timestamp: Date}|null}
 */
export function parseStepMetadata(buf) {
  const meta = decodeMessage(buf);
  const source = firstVarint(meta, 3);
  let role;
  if (source === STEP_SOURCE_USER) role = 'user';
  else if (source === STEP_SOURCE_MODEL) role = 'assistant';
  else return null;

  const createdAt = firstMessage(meta, 1);
  const seconds = createdAt ? firstVarint(createdAt, 1) : undefined;
  if (!seconds) return null;

  return { role, timestamp: new Date(seconds * 1000) };
}

/**
 * Read session timing events (user/assistant turns) for a cascade from the
 * steps table, chronological by idx.
 */
export function readDbSessionEvents(conversationsDir, cascadeId) {
  let rows;
  try {
    rows = queryCascadeDb(
      conversationsDir,
      cascadeId,
      'SELECT hex(metadata) AS h FROM steps WHERE metadata IS NOT NULL ORDER BY idx',
    );
  } catch (err) {
    if (isSqliteUnavailableError(err)) throw err;
    return [];
  }
  const events = [];
  for (const row of rows) {
    if (!row.h) continue;
    let ev;
    try {
      ev = parseStepMetadata(Buffer.from(row.h, 'hex'));
    } catch {
      continue;
    }
    if (ev) events.push(ev);
  }
  return events;
}
