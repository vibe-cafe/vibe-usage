import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import zlib from 'node:zlib';
import { getDshSessionsDir } from '../tools.js';
import { aggregateToBuckets, extractSessions } from './aggregate.js';

const SOURCE = 'dsh';

// DeepSeek Harness session-log format version this parser understands. DeepSeek
// Harness is currently in developer preview and is iterating rapidly — THERE
// WILL BE COMPATIBILITY-BREAKING CHANGES. When the CLI bumps the header
// `version` field, bump this constant (and the record-shape mapping below)
// after re-checking the on-disk format instead of guessing against stale
// assumptions.
const SESSION_FORMAT_VERSION = 0;

// Safety cap for a single session log. DSH stores many small zstd frames per
// file; anything beyond this is either a runaway log or not a session file.
const MAX_SESSION_FILE_BYTES = 256 * 1024 * 1024;

// Maximum decompressed size for one session log, for both decoder paths.
const MAX_DECOMPRESSED_SESSION_BYTES = 512 * 1024 * 1024;

// Zstandard frame magic (0xFD2FB528 little-endian) and the skippable-frame
// magic range (0x184D2A50–0x184D2A5F), per RFC 8878.
const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC_MIN = 0x184d2a50;
const SKIPPABLE_MAGIC_MAX = 0x184d2a5f;

const MAX_WARNINGS = 20;

/**
 * Split concatenated Zstandard input into independently decodable frame ranges.
 *
 * DSH writes one frame for the header and one per durable append batch. Node's
 * one-shot zstd API decodes only one standard frame, so each standard frame is
 * returned as an independent `{ start, end }` range. Complete skippable frames
 * are omitted without joining the standard frames around them. An incomplete
 * tail is ignored, matching DSH's append-recovery boundary.
 *
 * @param {Buffer} buffer
 * @returns {{ start: number, end: number }[]}
 */
export function splitZstdFrames(buffer) {
  const frames = [];
  let pos = 0;
  while (pos < buffer.length) {
    if (pos + 4 > buffer.length) break;
    const magic = buffer.readUInt32LE(pos);
    if (magic >= SKIPPABLE_MAGIC_MIN && magic <= SKIPPABLE_MAGIC_MAX) {
      if (pos + 8 > buffer.length) break;
      const end = pos + 8 + buffer.readUInt32LE(pos + 4);
      if (end > buffer.length) break;
      pos = end;
      continue;
    }
    if (magic !== ZSTD_MAGIC) {
      throw new Error('invalid Zstandard frame magic at byte ' + pos);
    }

    const start = pos;
    pos += 4;
    if (pos >= buffer.length) break;
    const descriptor = buffer[pos++];
    if ((descriptor & 0x18) !== 0) {
      throw new Error('reserved Zstandard frame-header bit at byte ' + (pos - 1));
    }
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const contentSizeFlag = descriptor >>> 6;

    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (pos + remainingHeaderBytes > buffer.length) break;
    pos += remainingHeaderBytes;

    for (;;) {
      if (pos + 3 > buffer.length) return frames;
      const blockHeader = buffer.readUIntLE(pos, 3);
      pos += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error('reserved Zstandard block type at byte ' + (pos - 3));
      }
      // An RLE block stores one encoded byte; blockSize is its decoded size.
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (pos + payloadBytes > buffer.length) return frames;
      pos += payloadBytes;
      if (lastBlock) break;
    }

    if (checksum) {
      if (pos + 4 > buffer.length) return frames;
      pos += 4;
    }
    frames.push({ start, end: pos });
  }
  return frames;
}

const hasBuiltinZstd = typeof zlib.zstdDecompressSync === 'function';
let zstdCliProbe = null;
function hasZstdCli() {
  if (zstdCliProbe !== null) return zstdCliProbe;
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore', timeout: 5000 });
    zstdCliProbe = true;
  } catch {
    zstdCliProbe = false;
  }
  return zstdCliProbe;
}

const ZSTD_HINT =
  'decompress with node:zlib zstd (Node >= 22.15) or install the zstd CLI';

/** Decompress the complete frames captured from one DSH session log. */
function decompressSessionLog(buffer, file) {
  const frames = splitZstdFrames(buffer);
  if (frames.length === 0) {
    throw new Error('no complete zstd frames found in ' + relative(process.cwd(), file));
  }

  if (hasBuiltinZstd) {
    const parts = [];
    let remaining = MAX_DECOMPRESSED_SESSION_BYTES;
    for (const { start, end } of frames) {
      if (remaining <= 0) throw new Error('decompressed session log is too large');
      const part = zlib.zstdDecompressSync(buffer.subarray(start, end), {
        maxOutputLength: remaining,
      });
      parts.push(part);
      remaining -= part.length;
    }
    return Buffer.concat(parts).toString('utf8');
  }

  if (!hasZstdCli()) {
    const error = new Error('zstd unavailable for ' + file + ': ' + ZSTD_HINT);
    error.code = 'ENOENT';
    throw error;
  }

  const first = frames[0];
  const last = frames.at(-1);
  const contiguous = frames.every((frame, index) =>
    index === 0 || frame.start === frames[index - 1].end
  );
  const completeInput = contiguous
    ? buffer.subarray(first.start, last.end)
    : Buffer.concat(frames.map(({ start, end }) => buffer.subarray(start, end)));
  return execFileSync('zstd', ['-d', '-c'], {
    input: completeInput,
    maxBuffer: MAX_DECOMPRESSED_SESSION_BYTES,
    stdio: ['pipe', 'pipe', 'ignore'],
  }).toString('utf8');
}

function projectFromCwd(cwd) {
  if (typeof cwd !== 'string') return 'unknown';
  const trimmed = cwd.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return 'unknown';
  const name = basename(trimmed.replace(/\\/g, '/'));
  return name || 'unknown';
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isUsageRecord(rec) {
  return rec.type === 'assistant/message' && rec.data && typeof rec.data === 'object';
}

function isUserMessageRecord(rec) {
  return (
    rec.type === 'user/message' &&
    rec.data &&
    typeof rec.data === 'object' &&
    rec.data.source?.kind === 'user'
  );
}

/**
 * Build a session model from one decompressed session log.
 *
 * Layout (DeepSeek Harness session-persistence-jsonl):
 *   line 0: {"type":"session","version":0,"id":...,"createdAt":...,"cwd":...,
 *            "parentSession":...?, ...}
 *   ... possibly a resumed/forked seed replay, then ...
 *   {"type":"user/message"|"assistant/message","time":...,"data":{...}}
 *
 * DSH (developer preview) writes session/end-seed records in three situations:
 * right after session creation (empty seed), at each resume boundary, and
 * appended at the END of a file when that session becomes the seed for a
 * further resume. The marker's position is therefore NOT a replay boundary —
 * a trailing marker would make "skip everything before the last marker"
 * discard the session's entire real history.
 *
 * Fork/subagent lineage is encoded separately in the immutable header.
 * `parentSession` identifies the source and `seedLength` is the exact number
 * of leading event seqs inherited from it. Only those seqs are skipped, and
 * only while the parent file is also present, so a missing/corrupt source
 * fails open instead of dropping the sole local copy of its usage.
 *
 * Only user/message (source.kind === 'user') and assistant/message records
 * are kept in the model — they are the only records that produce usage
 * entries or timing events. Their seq is retained so the header's seed
 * boundary can be applied without inspecting or hashing message content.
 *
 * usage.outputTokens includes reasoningTokens (verified against the
 * session_projcache totals DSH itself maintains), so reasoning is split out of
 * output before aggregation, like the Pi-family parsers.
 */
function buildSessionModel(text) {
  const lines = text.split('\n');

  let header = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length === 0) continue;
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue; // torn final line: keep the complete records
    }
    if (rec && typeof rec === 'object' && header === null && rec.type === 'session') {
      header = rec;
    }
  }

  if (!header || typeof header.id !== 'string' || header.id.length === 0) {
    throw new Error('missing session header record');
  }
  if (header.version !== SESSION_FORMAT_VERSION) {
    const error = new Error(
      'session ' + header.id + ' uses format version ' + header.version +
      ' (parser supports ' + SESSION_FORMAT_VERSION + ')',
    );
    error.code = 'UNSUPPORTED_FORMAT_VERSION';
    throw error;
  }

  const messages = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length === 0) continue;
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;
    const timeMs = recordTimeMs(rec);
    if (timeMs == null) continue;
    const seq = Number.isSafeInteger(rec.seq) && rec.seq >= 0 ? rec.seq : null;

    if (isUserMessageRecord(rec)) {
      messages.push({ seq, role: 'user', timeMs, usage: null, model: null });
      continue;
    }
    if (!isUsageRecord(rec)) continue;

    // Every assistant/message marks the end of a billable step, even when its
    // usage block is missing; the model keeps it so timing survives.
    messages.push({
      seq,
      role: 'assistant',
      timeMs,
      usage: parseUsage(rec.data.usage),
      model:
        typeof rec.data.message?.source?.model === 'string' && rec.data.message.source.model
          ? rec.data.message.source.model
          : 'unknown',
    });
  }

  return {
    sessionId: header.id,
    parentSessionId:
      typeof header.parentSession === 'string' && header.parentSession
        ? header.parentSession
        : null,
    seedLength:
      Number.isSafeInteger(header.seedLength) && header.seedLength > 0
        ? header.seedLength
        : 0,
    cwd: header.cwd,
    messages,
  };
}

/** Record wall-clock time in epoch ms; null when absent/invalid. */
function recordTimeMs(rec) {
  const t = rec.time;
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  if (typeof t === 'string' && t.trim()) {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  return null;
}

/** Usage numbers from an assistant/message usage block, or null when empty. */
function parseUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  // Harness counts are disjoint. The common bucket model has no cache-write
  // column, so cache writes join uncached input, matching the other parsers.
  const inputTokens = toCount(usage.inputTokens) + toCount(usage.cacheWriteTokens);
  const cachedInputTokens = toCount(usage.cacheReadTokens);
  const totalOutputTokens = toCount(usage.outputTokens);
  const reasoningOutputTokens = Math.min(totalOutputTokens, toCount(usage.reasoningTokens));
  const outputTokens = totalOutputTokens - reasoningOutputTokens;
  if (inputTokens + cachedInputTokens + reasoningOutputTokens + outputTokens === 0) return null;
  return { inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens };
}

/** Token-accounting equality for a copied assistant record. */
function sameUsage(left, right) {
  if (left == null || right == null) return left === right;
  return (
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.reasoningOutputTokens === right.reasoningOutputTokens
  );
}

/**
 * Number of leading child messages inherited from a parent seed.
 *
 * `header.seedLength` is DSH's durable fork-lineage boundary: event seqs below
 * it came from the parent, while later seqs belong to the child. Each skipped
 * message must still exist at the same seq in the selected parent copy.
 * Missing, invalid, or divergent records fail open so usage is not lost.
 */
function replaySkipCount(child, parent) {
  if (child.seedLength <= 0 || child.messages.length === 0) return 0;
  let parentIndex = 0;
  let previousSeq = -1;
  let count = 0;
  for (const message of child.messages) {
    if (message.seq == null || message.seq <= previousSeq) return 0;
    previousSeq = message.seq;
    if (message.seq >= child.seedLength) break;

    while (
      parentIndex < parent.messages.length &&
      parent.messages[parentIndex].seq != null &&
      parent.messages[parentIndex].seq < message.seq
    ) {
      parentIndex++;
    }
    const source = parent.messages[parentIndex];
    if (
      source?.seq !== message.seq ||
      source.role !== message.role ||
      source.model !== message.model ||
      !sameUsage(source.usage, message.usage)
    ) {
      return 0;
    }
    parentIndex++;
    count++;
  }
  return count;
}

/** Fold a (possibly replay-trimmed) model into flat usage entries + timing events. */
function modelToResult(model, skipCount) {
  const sessionId = model.sessionId;
  const project = projectFromCwd(model.cwd);
  const entries = [];
  const events = [];
  for (let i = skipCount; i < model.messages.length; i++) {
    const msg = model.messages[i];
    const timestamp = new Date(msg.timeMs);
    events.push({ sessionId, source: SOURCE, project, timestamp, role: msg.role });
    if (msg.usage) {
      entries.push({
        source: SOURCE,
        model: msg.model || 'unknown',
        project,
        timestamp,
        ...msg.usage,
      });
    }
  }
  return { entries, events };
}

/** List session log files under a DSH sessions root (session.jsonl[.zstd]). */
function listSessionFiles(sessionsDir, onFailure) {
  const files = [];
  const projectKeys = readdirSync(sessionsDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const projectKey of projectKeys) {
    if (!projectKey.isDirectory()) continue;
    const projectDir = join(sessionsDir, projectKey.name);
    let sessionDirs;
    try {
      sessionDirs = readdirSync(projectDir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      onFailure(
        'dsh: cannot read project directory ' + projectKey.name +
        ' (' + (error?.code || error?.message || 'read failed') + ')',
      );
      continue;
    }
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue;
      const sessionPath = join(projectDir, sessionDir.name);
      for (const name of ['session.jsonl.zstd', 'session.jsonl']) {
        const file = join(sessionPath, name);
        try {
          if (statSync(file).isFile()) {
            files.push({ file, compressed: name.endsWith('.zstd') });
            break;
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            onFailure(
              'dsh: cannot inspect ' + relative(sessionsDir, file) +
              ' (' + (error?.code || error?.message || 'stat failed') + ')',
            );
            break;
          }
        }
      }
    }
  }
  return files;
}

/**
 * DeepSeek Harness (dsh) parser.
 *
 * Reads $DSH_HOME/sessions/<project-key>/session-<id>/session.jsonl.zstd
 * (default ~/.dsh, fixture/relocation override VIBE_USAGE_DSH_SESSIONS).
 * Zstandard session logs are multi-frame; node:zlib zstd (Node >= 22.15)
 * decodes one frame per call, so the buffer is walked frame-by-frame, with a
 * `zstd` CLI fallback for older Node.
 *
 * Replay handling: `header.parentSession` identifies a fork/subagent source,
 * and `header.seedLength` is the exact count of leading event seqs inherited
 * from it. Those records are skipped only when the parent file is also
 * present. Files without either field, and children whose parent is missing,
 * are counted in full. `session/end-seed` positions are never used.
 */
export async function parse() {
  const sessionsDir = getDshSessionsDir();
  if (!existsSync(sessionsDir)) return { buckets: [], sessions: [] };

  const warnings = [];
  let anyFailure = false;
  const recordFailure = (message) => {
    anyFailure = true;
    if (warnings.length < MAX_WARNINGS && !warnings.includes(message)) {
      warnings.push(message);
    }
  };

  let files;
  try {
    files = listSessionFiles(sessionsDir, recordFailure);
  } catch (error) {
    recordFailure(
      'dsh: cannot read sessions directory ' + sessionsDir +
      ' (' + (error?.code || error?.message || 'read failed') + ')',
    );
    return { buckets: [], sessions: [], skipped: true, warnings };
  }
  if (files.length === 0) {
    const result = { buckets: [], sessions: [] };
    if (anyFailure) Object.assign(result, { skipped: true, warnings });
    return result;
  }

  // sessionId -> most complete model (largest decompressed log wins, so a
  // session copied between project dirs is counted once).
  const perSession = new Map();
  for (const { file, compressed } of files) {
    let text;
    try {
      const stat = statSync(file);
      if (!stat.isFile()) throw new Error('session log is no longer a file');
      if (stat.size > MAX_SESSION_FILE_BYTES) {
        throw new Error('session log too large (' + stat.size + ' bytes)');
      }
      const buffer = readFileSync(file);
      if (buffer.length < stat.size) throw new Error('session log changed while reading');
      const snapshot = buffer.length === stat.size ? buffer : buffer.subarray(0, stat.size);
      text = compressed ? decompressSessionLog(snapshot, file) : snapshot.toString('utf8');
    } catch (error) {
      const reason = error?.code === 'ENOENT' && !hasBuiltinZstd && compressed
        ? ZSTD_HINT
        : error?.message || String(error);
      recordFailure('dsh: skipping ' + relative(process.cwd(), file) + ' (' + reason + ')');
      continue;
    }

    let model;
    try {
      model = buildSessionModel(text);
    } catch (error) {
      recordFailure(
        'dsh: skipping ' + relative(process.cwd(), file) + ' (' + error.message + ')',
      );
      continue;
    }

    const weight = text.length;
    const previous = perSession.get(model.sessionId);
    if (!previous || weight > previous.weight) {
      perSession.set(model.sessionId, { model, weight });
    }
  }

  const entries = [];
  const eventsBySession = new Map();
  for (const { model } of perSession.values()) {
    // seedLength supplies the exact inherited boundary; matching source seqs
    // prove the selected parent copy still contains what the child inherited.
    // Missing/corrupt parents fail open so the child remains the local copy.
    const parent =
      model.parentSessionId == null ? null : perSession.get(model.parentSessionId);
    const skip = parent ? replaySkipCount(model, parent.model) : 0;
    const { entries: fileEntries, events: fileEvents } = modelToResult(model, skip);
    entries.push(...fileEntries);
    for (const event of fileEvents) {
      if (!eventsBySession.has(event.sessionId)) eventsBySession.set(event.sessionId, []);
      eventsBySession.get(event.sessionId).push(event);
    }
  }

  // Only sessions with at least one real user prompt are meaningful timing
  // data; assistant-only logs (e.g. plugin-driven sessions) are skipped.
  const events = [];
  for (const sessionEvents of eventsBySession.values()) {
    if (sessionEvents.some((event) => event.role === 'user')) {
      events.push(...sessionEvents);
    }
  }

  const result = {
    buckets: aggregateToBuckets(entries),
    sessions: extractSessions(events),
  };
  if (warnings.length > 0 || anyFailure) {
    result.skipped = anyFailure;
    result.warnings = warnings;
  }
  return result;
}
