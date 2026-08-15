import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import zlib from 'node:zlib';
import { getDshSessionsDir } from '../tools.js';
import { aggregateToBuckets, extractSessions } from './index.js';

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

// execFileSync maxBuffer for the zstd CLI fallback (decompressed size cap).
const ZSTD_CLI_MAX_BUFFER = 512 * 1024 * 1024;

// Zstandard frame magic (0xFD2FB528 little-endian) and the skippable-frame
// magic range (0x184D2A50–0x184D2A5F), per RFC 8878.
const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC_MIN = 0x184d2a50;
const SKIPPABLE_MAGIC_MAX = 0x184d2a5f;

// How many session files to decompress at once. Decompression is CPU-bound, so
// a small pool keeps a large session tree from spiking memory.
const FILE_CONCURRENCY = 4;

/**
 * Split a buffer of concatenated Zstandard frames into frame boundaries.
 *
 * DSH compresses every write batch as its own frame, and Node's zstd support
 * (zlib.zstdDecompressSync / createZstdDecompress) decodes exactly one frame
 * per call, so the whole log must be walked frame-by-frame. Returns the byte
 * offset just past each frame (i.e. [frame0End, frame1End, ...]). Trailing
 * bytes that do not begin a frame are ignored: DSH's own reader treats them as
 * a torn append and truncates to the last complete frame.
 *
 * @param {Buffer} buffer
 * @returns {number[]} frame end offsets, strictly increasing
 */
export function splitZstdFrames(buffer) {
  const ends = [];
  let pos = 0;
  while (pos < buffer.length) {
    if (pos + 4 > buffer.length) break; // torn tail: keep complete frames only
    const magic = buffer.readUInt32LE(pos);
    if (magic >= SKIPPABLE_MAGIC_MIN && magic <= SKIPPABLE_MAGIC_MAX) {
      if (pos + 8 > buffer.length) break;
      pos += 8 + buffer.readUInt32LE(pos + 4);
      continue;
    }
    if (magic !== ZSTD_MAGIC) break; // non-frame tail: treat as torn append

    pos += 4;
    if (pos >= buffer.length) break;
    const fhd = buffer[pos++];
    const singleSegment = (fhd & 0x20) !== 0;
    const checksum = (fhd & 0x04) !== 0;
    const didFlag = fhd & 0x03;
    const fcsFlag = fhd >>> 6;

    if (!singleSegment) pos += 1; // window descriptor
    pos += [0, 1, 2, 4][didFlag]; // dictionary id
    if (fcsFlag === 0) {
      if (singleSegment) pos += 1;
    } else if (fcsFlag === 1) {
      pos += 2;
    } else if (fcsFlag === 2) {
      pos += 4;
    } else {
      pos += 8;
    }

    // Walk the block section: 3-byte little-endian header per block, top 21
    // bits are the block content size, low 3 bits are flags (bit 0 = last).
    for (;;) {
      if (pos + 3 > buffer.length) return ends; // torn block header
      const b0 = buffer[pos];
      const b1 = buffer[pos + 1];
      const b2 = buffer[pos + 2];
      const blockSize = (b0 >> 3) | (b1 << 5) | (b2 << 13);
      pos += 3 + blockSize;
      if (b0 & 0x01) break;
    }
    if (checksum) pos += 4;
    if (pos > buffer.length) return ends; // torn frame body
    ends.push(pos);
  }
  return ends;
}

const hasBuiltinZstd = typeof zlib.zstdDecompressSync === 'function';
let zstdCliProbe = null;
function hasZstdCli() {
  if (zstdCliProbe !== null) return zstdCliProbe;
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' });
    zstdCliProbe = true;
  } catch {
    zstdCliProbe = false;
  }
  return zstdCliProbe;
}

const ZSTD_HINT =
  'decompress with node:zlib zstd (Node >= 22.15) or install the zstd CLI';

/** Decompress one DSH session log buffer back to JSONL text. */
function decompressSessionLog(buffer, file) {
  if (hasBuiltinZstd) {
    const frameEnds = splitZstdFrames(buffer);
    if (frameEnds.length === 0) {
      throw new Error('no complete zstd frames found in ' + relative(process.cwd(), file));
    }
    const parts = [];
    let start = 0;
    for (const end of frameEnds) {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(start, end)));
      start = end;
    }
    return Buffer.concat(parts).toString('utf8');
  }
  if (!hasZstdCli()) {
    const error = new Error('zstd unavailable for ' + file + ': ' + ZSTD_HINT);
    error.code = 'ENOENT';
    throw error;
  }
  return execFileSync('zstd', ['-d', '-c', file], {
    maxBuffer: ZSTD_CLI_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'ignore'],
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
 * Parse one decompressed session log into flat entries/events.
 *
 * Layout (DeepSeek Harness session-persistence-jsonl):
 *   line 0: {"type":"session","version":0,"id":...,"createdAt":...,"cwd":...,...}
 *   ... possibly a resumed/forked seed replay, then ...
 *   {"type":"session/end-seed",...}          (absent in fresh sessions)
 *   {"type":"assistant/message","data":{"turn","step","message":{"source":
 *     {"kind":"model","provider","model"},...},"usage":{"inputTokens",
 *     "outputTokens","cacheReadTokens","reasoningTokens"}},...}
 *
 * When a session is resumed (or forked) the stored log begins with a replay of
 * the seed history. Everything before the LAST session/end-seed marker is a
 * replay of records that were already counted from their original file, so it
 * must be skipped or the same usage would be counted twice.
 *
 * usage.outputTokens includes reasoningTokens (verified against the
 * session_projcache totals DSH itself maintains), so reasoning is split out of
 * output before aggregation, like the Pi-family parsers.
 */
function parseSessionText(text) {
  const entries = [];
  const events = [];
  const lines = text.split('\n');

  let header = null;
  let endSeedIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length === 0) continue;
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue; // torn final line: keep the complete records
    }
    if (rec && typeof rec === 'object') {
      if (header === null && rec.type === 'session') header = rec;
      if (rec.type === 'session/end-seed') endSeedIndex = i;
    }
  }

  if (!header || typeof header.id !== 'string' || header.id.length === 0) {
    throw new Error('missing session header record');
  }
  if (typeof header.version === 'number' && header.version !== SESSION_FORMAT_VERSION) {
    const error = new Error(
      'session ' + header.id + ' uses format version ' + header.version +
      ' (parser supports ' + SESSION_FORMAT_VERSION + ')',
    );
    error.code = 'UNSUPPORTED_FORMAT_VERSION';
    throw error;
  }

  const sessionId = header.id;
  const project = projectFromCwd(header.cwd);

  for (let i = 0; i < lines.length; i++) {
    if (i <= endSeedIndex) continue;
    if (lines[i].length === 0) continue;
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;
    const timestamp = new Date(rec.time);
    if (Number.isNaN(timestamp.getTime())) continue;

    if (isUserMessageRecord(rec)) {
      events.push({ sessionId, source: SOURCE, project, timestamp, role: 'user' });
      continue;
    }
    if (!isUsageRecord(rec)) continue;

    // Every assistant/message marks the end of a billable step, even when its
    // usage block is missing.
    events.push({ sessionId, source: SOURCE, project, timestamp, role: 'assistant' });

    const usage = rec.data.usage;
    if (!usage || typeof usage !== 'object') continue;
    const inputTokens = toCount(usage.inputTokens);
    const cachedInputTokens = toCount(usage.cacheReadTokens);
    const reasoningOutputTokens = toCount(usage.reasoningTokens);
    const outputTokens = Math.max(0, toCount(usage.outputTokens) - reasoningOutputTokens);
    if (inputTokens + cachedInputTokens + reasoningOutputTokens + outputTokens === 0) continue;

    const model =
      typeof rec.data.message?.source?.model === 'string' && rec.data.message.source.model
        ? rec.data.message.source.model
        : 'unknown';

    entries.push({
      source: SOURCE,
      model,
      project,
      timestamp,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningOutputTokens,
    });
  }

  return { sessionId, entries, events };
}

/** List session log files under a DSH sessions root (session.jsonl[.zstd]). */
function listSessionFiles(sessionsDir) {
  const files = [];
  for (const projectKey of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!projectKey.isDirectory()) continue;
    let sessionDirs;
    try {
      sessionDirs = readdirSync(join(sessionsDir, projectKey.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue;
      const sessionPath = join(sessionsDir, projectKey.name, sessionDir.name);
      for (const name of ['session.jsonl.zstd', 'session.jsonl']) {
        const file = join(sessionPath, name);
        try {
          if (statSync(file).isFile()) {
            files.push({ file, compressed: name.endsWith('.zstd') });
            break;
          }
        } catch {
          // not present under this name
        }
      }
    }
  }
  return files;
}

function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  return Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await fn(items[index], index);
      }
    }),
  ).then(() => results);
}

/**
 * DeepSeek Harness (dsh) parser.
 *
 * Reads $DSH_HOME/sessions/<project-key>/session-<id>/session.jsonl.zstd
 * (default ~/.dsh, fixture/relocation override VIBE_USAGE_DSH_SESSIONS).
 * Zstandard session logs are multi-frame; node:zlib zstd (Node >= 22.15)
 * decodes one frame per call, so the buffer is walked frame-by-frame, with a
 * `zstd` CLI fallback for older Node.
 */
export async function parse() {
  const sessionsDir = getDshSessionsDir();
  if (!existsSync(sessionsDir)) return { buckets: [], sessions: [] };

  let files;
  try {
    files = listSessionFiles(sessionsDir);
  } catch {
    return {
      buckets: [],
      sessions: [],
      skipped: true,
      warnings: ['dsh: cannot read sessions directory ' + sessionsDir],
    };
  }
  if (files.length === 0) return { buckets: [], sessions: [] };

  const warnings = [];
  let anyFailure = false;

  const perSession = new Map(); // sessionId -> parsed view (largest file wins)
  await mapWithConcurrency(files, FILE_CONCURRENCY, async ({ file, compressed }) => {
    let text;
    try {
      if (!statSync(file).isFile()) return;
      const size = statSync(file).size;
      if (size > MAX_SESSION_FILE_BYTES) {
        throw new Error('session log too large (' + size + ' bytes)');
      }
      const buffer = readFileSync(file);
      text = compressed ? decompressSessionLog(buffer, file) : buffer.toString('utf8');
    } catch (error) {
      anyFailure = true;
      const reason = error?.code === 'ENOENT' && !hasBuiltinZstd && compressed
        ? ZSTD_HINT
        : error?.message || String(error);
      warnings.push('dsh: skipping ' + relative(process.cwd(), file) + ' (' + reason + ')');
      return;
    }

    let parsed;
    try {
      parsed = parseSessionText(text);
    } catch (error) {
      anyFailure = true;
      warnings.push('dsh: skipping ' + relative(process.cwd(), file) + ' (' + error.message + ')');
      return;
    }

    const weight = parsed.entries.length * 2 + parsed.events.length;
    const previous = perSession.get(parsed.sessionId);
    if (!previous || weight > previous.weight) {
      perSession.set(parsed.sessionId, { ...parsed, weight });
    }
  });

  const entries = [];
  const eventsBySession = new Map();
  for (const parsed of perSession.values()) {
    entries.push(...parsed.entries);
    for (const event of parsed.events) {
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
