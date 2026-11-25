import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import zlib from 'node:zlib';
import { getDshSessionsDir } from '../tools.js';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import {
  commitFileEntries,
  hashManifest,
  loadFileEntries,
  loadSourceSnapshot,
  localTimeZoneToken,
  parserCacheEnabled,
  pruneFileEntries,
  saveSourceSnapshot,
  statToken,
} from './parser-cache.js';

const SOURCE = 'dsh';
// 2: cached models carry `project` instead of the session's full `cwd`.
const DSH_CACHE_ALGO = 2;
// The whole-source snapshot holds sessions, so it moves with how they are
// computed: 3 is model time (2026-11-25). An earlier release keeps reading its
// own version and never sees sessions carrying 5-minute cells.
const DSH_SNAPSHOT_ALGO = 3;

// Verified against deepseek-ai/deepseek-harness, released formats V0-V4:
// packages/session/session-format/src/filename.ts, session-format-v0-to-v1,
// session-format-v1-to-v2, session-format-v2-to-v3, core/session/src/types.ts,
// and docs/persistence-changes/2026-09-16-session-format-v4.md.
// V0/V1 use header.seedLength; V2-V4 use a tagged inherited end-seed marker.
// V4 (SESSION_FORMAT_VERSION = 4, commit 669b724a78) keeps the filename, header
// fields, assistant usage block, and inherited cut; it lifts user-role tool
// results into tool-role messages, adds forked to turn/end.reason, and adds
// developer/message, none of which carry billable usage.
// Re-check the format before accepting another version; never silently read a
// frozen predecessor when a newer generation is present.
const MAX_SESSION_FORMAT_VERSION = 4;
const SESSION_FILENAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/;

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
let zstdCli;
export function findZstdCli(platform = process.platform, run = execFileSync) {
  const candidates = platform === 'darwin' ? ['zstd', '/opt/homebrew/bin/zstd', '/usr/local/bin/zstd'] : ['zstd'];
  for (const candidate of candidates) {
    try {
      run(candidate, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return candidate;
    } catch {
      // Try the next installation if this one is missing or unusable.
    }
  }
  return null;
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

  if (zstdCli === undefined) zstdCli = findZstdCli();
  if (!zstdCli) {
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
  return execFileSync(zstdCli, ['-d', '-c'], {
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
 * V0/V1 use header.seedLength. Their untagged end-seed markers can appear
 * after real history and must never be treated as a replay boundary. V2-V4
 * instead require isSeeded and use the LAST end-seed with data.inherited=true.
 * Only a proven inherited prefix also present in the parent is skipped.
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
function buildSessionModel(text, fileVersion) {
  let header = null;
  const messages = [];
  let inheritedSeq = null;
  let invalidInheritedSeed = false;

  let start = 0;
  const len = text.length;
  while (start < len) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = len;
    const line = text.slice(start, end);
    start = end + 1;
    if (line.length === 0) continue;

    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // torn final line: keep the complete records
    }
    if (!rec || typeof rec !== 'object') continue;

    if (header === null && rec.type === 'session') {
      header = rec;
    }

    const timeMs = recordTimeMs(rec);
    if (timeMs == null) continue;
    const seq = Number.isSafeInteger(rec.seq) && rec.seq >= 0 ? rec.seq : null;

    if (rec.type === 'session/end-seed' && rec.data?.inherited === true) {
      if (seq == null) {
        invalidInheritedSeed = true;
      } else {
        inheritedSeq = seq;
      }
    }

    if (isUserMessageRecord(rec)) {
      messages.push({ seq, messageId: messageId(rec.data.id), role: 'user', timeMs, usage: null, model: null });
      continue;
    }
    if (!isUsageRecord(rec)) continue;

    // Every assistant/message marks the end of a billable step, even when its
    // usage block is missing; the model keeps it so timing survives.
    messages.push({
      seq,
      messageId: messageId(rec.data.message?.id),
      role: 'assistant',
      timeMs,
      usage: parseUsage(rec.data.usage),
      model:
        typeof rec.data.message?.source?.model === 'string' && rec.data.message.source.model
          ? rec.data.message.source.model
          : 'unknown',
    });
  }

  if (!header || typeof header.id !== 'string' || header.id.length === 0) {
    throw new Error('missing session header record');
  }
  if (!Number.isInteger(header.version) || header.version < 0 || header.version > MAX_SESSION_FORMAT_VERSION) {
    const error = new Error(
      'session ' + header.id + ' uses format version ' + header.version +
      ' (parser supports 0–' + MAX_SESSION_FORMAT_VERSION + ')',
    );
    error.code = 'UNSUPPORTED_FORMAT_VERSION';
    throw error;
  }
  if (header.version !== fileVersion) {
    throw new Error('session header format version ' + header.version + ' disagrees with filename version ' + fileVersion);
  }
  if (header.version >= 2 && typeof header.isSeeded !== 'boolean') {
    throw new Error('format v' + header.version + ' session header lacks isSeeded');
  }
  if (header.version >= 2 && invalidInheritedSeed) {
    throw new Error('inherited end-seed marker lacks a valid seq');
  }
  if (header.version >= 2 && header.isSeeded !== (inheritedSeq !== null)) {
    throw new Error('isSeeded disagrees with the inherited end-seed marker');
  }

  return {
    formatVersion: header.version,
    sessionId: header.id,
    parentSessionId:
      typeof header.parentSession === 'string' && header.parentSession
        ? header.parentSession
        : null,
    seedLength: header.version >= 2 ? (inheritedSeq ?? 0) :
      Number.isSafeInteger(header.seedLength) && header.seedLength > 0
        ? header.seedLength
        : 0,
    // Only the project name is kept (it is all the output uses), so the
    // parser cache never stores a session's full working directory.
    project: projectFromCwd(header.cwd),
    messages,
  };
}

function messageId(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
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
 * seedLength is normalized from the version's durable inheritance boundary.
 * Each skipped message must still exist in the selected parent copy. Format
 * migrations renumber events, but preserve existing message ids; mixed-format
 * parents therefore need matching ids in order, never a token-count heuristic.
 * Missing, invalid, or divergent records fail open so usage is not lost.
 */
function replaySkipCount(child, parent) {
  if (child.seedLength <= 0 || child.messages.length === 0) return 0;
  let parentIndex = 0;
  let previousSeq = -1;
  let count = 0;
  const mixedVersions = child.formatVersion !== parent.formatVersion;
  for (const message of child.messages) {
    if (message.seq == null || message.seq <= previousSeq) return 0;
    previousSeq = message.seq;
    if (message.seq >= child.seedLength) break;

    if (mixedVersions) {
      if (!message.messageId) return 0;
      while (parentIndex < parent.messages.length && parent.messages[parentIndex].messageId !== message.messageId) {
        parentIndex++;
      }
    } else {
      while (
        parentIndex < parent.messages.length &&
        parent.messages[parentIndex].seq != null &&
        parent.messages[parentIndex].seq < message.seq
      ) {
        parentIndex++;
      }
    }
    const source = parent.messages[parentIndex];
    if (
      !source ||
      (!mixedVersions && source.seq !== message.seq) ||
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
  const project = model.project;
  const entries = [];
  const events = [];
  for (let i = skipCount; i < model.messages.length; i++) {
    const msg = model.messages[i];
    const timestamp = new Date(msg.timeMs);
    // Model time: a reply's output (reasoning included) sets its cap; a reply
    // without usage is unknown (aggregate.js replySpan()).
    const outputTokens = msg.role === 'assistant' && msg.usage
      ? msg.usage.outputTokens + msg.usage.reasoningOutputTokens
      : undefined;
    events.push({ sessionId, source: SOURCE, project, timestamp, role: msg.role,
      ...(outputTokens !== undefined ? { outputTokens } : {}) });
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

/** Pick the highest canonical generation per session, like DSH persistence. */
function selectSessionFile(sessionPath) {
  let selected = null;
  for (const entry of readdirSync(sessionPath, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const match = SESSION_FILENAME.exec(entry.name);
    if (!match) continue;
    const version = Number(match[1] || 0);
    if (!Number.isSafeInteger(version)) throw new Error('invalid format version in ' + entry.name);
    const compressed = Boolean(match[2]);
    if (!selected || version > selected.version || (version === selected.version && compressed)) {
      selected = { file: join(sessionPath, entry.name), version, compressed };
    }
  }
  if (selected && selected.version > MAX_SESSION_FORMAT_VERSION) {
    throw new Error('format version ' + selected.version + ' is not supported; update Vibe Usage');
  }
  return selected;
}

/** List session.jsonl[.zstd] (V0) and session.vN.jsonl[.zstd] (V1+). */
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
      try {
        const selected = selectSessionFile(sessionPath);
        if (selected) files.push(selected);
      } catch (error) {
        onFailure(
          'dsh: cannot read session directory ' + relative(sessionsDir, sessionPath) +
          ' (' + (error?.message || error?.code || 'read failed') + ')',
        );
      }
    }
  }
  return files;
}

/**
 * DeepSeek Harness (dsh) parser.
 *
 * Reads $DSH_HOME/sessions/<project-key>/<id>/session[.vN].jsonl[.zstd]
 * (default ~/.dsh, fixture/relocation override VIBE_USAGE_DSH_SESSIONS).
 * Zstandard session logs are multi-frame; node:zlib zstd (Node >= 22.15)
 * decodes one frame per call, so the buffer is walked frame-by-frame, with a
 * `zstd` CLI fallback for older Node.
 *
 * Replay handling: `header.parentSession` identifies a fork/subagent source,
 * with a version-specific inheritance boundary (see buildSessionModel).
 * Children whose parent is missing are counted in full.
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
    if (!anyFailure) pruneFileEntries(SOURCE, DSH_CACHE_ALGO, [sessionsDir], []);
    const result = { buckets: [], sessions: [] };
    if (anyFailure) Object.assign(result, { skipped: true, warnings });
    return result;
  }

  // L1 whole-source manifest fast path: when no directory read failed and
  // every session file's stat signature is unchanged, reuse the pre-aggregated
  // buckets/sessions directly without opening or decompressing any file.
  const fileStats = [];
  const cacheOn = parserCacheEnabled();
  let canUseManifest = !anyFailure && cacheOn;
  for (const item of files) {
    let stat = null;
    try {
      stat = statSync(item.file);
    } catch {
      canUseManifest = false;
    }
    if (stat && (!stat.isFile() || stat.size > MAX_SESSION_FILE_BYTES)) {
      canUseManifest = false;
    }
    // With the parser cache off, no per-file signature is built either.
    fileStats.push({ ...item, stat, sig: stat && cacheOn ? `${item.version}:${item.compressed ? 1 : 0}:${statToken(stat)}` : null });
  }

  // One snapshot per source; the sessions directory is in the manifest.
  const snapshotKey = SOURCE;
  const manifest = canUseManifest
    ? hashManifest([`tz|${localTimeZoneToken()}`, `dir|${sessionsDir}`, ...fileStats.map((f) => `${f.file}|${f.sig}`)])
    : null;
  if (manifest) {
    const snap = loadSourceSnapshot(snapshotKey, DSH_SNAPSHOT_ALGO, manifest);
    if (snap
      && Array.isArray(snap.buckets) && Array.isArray(snap.sessions)) {
      return snap;
    }
  }

  // L2 per-file incremental cache: reuse parsed models for unchanged logs and
  // only decompress/parse files that grew or appeared since the last run.
  const cachedEntries = loadFileEntries(SOURCE, DSH_CACHE_ALGO, fileStats.map(f => f.file));
  const cacheUpdates = [];

  // sessionId -> newest generation, then largest copy within that generation.
  // Migrations can shrink a log by embedding chunks, so size alone is unsafe.
  const perSession = new Map();
  for (const { file, compressed, version, stat, sig } of fileStats) {
    let model = null;
    let weight = 0;
    const cached = sig ? cachedEntries.get(file) : null;
    if (cached && cached.sig === sig) {
      try {
        const parsed = JSON.parse(cached.payload);
        if (parsed && parsed.model && typeof parsed.weight === 'number') {
          model = parsed.model;
          weight = parsed.weight;
        }
      } catch {
        model = null;
      }
    }

    if (!model) {
      let text;
      try {
        const s = stat || statSync(file);
        if (!s.isFile()) throw new Error('session log is no longer a file');
        if (s.size > MAX_SESSION_FILE_BYTES) {
          throw new Error('session log too large (' + s.size + ' bytes)');
        }
        const buffer = readFileSync(file);
        if (buffer.length < s.size) throw new Error('session log changed while reading');
        const snapshot = buffer.length === s.size ? buffer : buffer.subarray(0, s.size);
        text = compressed ? decompressSessionLog(snapshot, file) : snapshot.toString('utf8');
      } catch (error) {
        const reason = error?.code === 'ENOENT' && !hasBuiltinZstd && compressed
          ? ZSTD_HINT
          : error?.message || String(error);
        recordFailure('dsh: skipping ' + relative(process.cwd(), file) + ' (' + reason + ')');
        continue;
      }

      try {
        model = buildSessionModel(text, version);
      } catch (error) {
        recordFailure(
          'dsh: skipping ' + relative(process.cwd(), file) + ' (' + error.message + ')',
        );
        continue;
      }
      weight = text.length;
      if (sig) {
        cacheUpdates.push({ key: file, sig, payload: { model, weight } });
      }
    }

    const previous = perSession.get(model.sessionId);
    if (!previous || model.formatVersion > previous.model.formatVersion ||
      (model.formatVersion === previous.model.formatVersion && weight > previous.weight)) {
      perSession.set(model.sessionId, { model, weight });
    }
  }

  if (cacheUpdates.length > 0) {
    commitFileEntries(SOURCE, DSH_CACHE_ALGO, cacheUpdates);
  }
  if (!anyFailure) pruneFileEntries(SOURCE, DSH_CACHE_ALGO, [sessionsDir], fileStats.map(f => f.file));

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
    for (const entry of fileEntries) entries.push(entry);
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
      for (const event of sessionEvents) events.push(event);
    }
  }

  const result = {
    buckets: aggregateToBuckets(entries),
    sessions: extractSessions(events),
  };
  if (warnings.length > 0 || anyFailure) {
    result.skipped = anyFailure;
    result.warnings = warnings;
  } else if (manifest) {
    saveSourceSnapshot(snapshotKey, DSH_SNAPSHOT_ALGO, manifest, result);
  }
  return result;
}
