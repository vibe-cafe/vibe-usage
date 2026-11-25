import { createHash } from 'node:crypto';

// Shared bucket/session aggregation used by every parser. Lives in its own
// module (not the parser registry in index.js) so parsers never have to import
// the registry that imports them — that circular dependency only worked because
// these functions are hoisted declarations. Keeping them here breaks the cycle.
//
// Data model: parsers emit flat per-message "entries" (token usage) and
// per-message "events" (timing), and these two functions fold them into the
// bucket/session shapes described in AGENTS.md.

export function roundToHalfHour(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() < 30 ? 0 : 30, 0, 0);
  return d;
}

// Server column limits (usage_buckets: model varchar(100), project varchar(200)).
// Anything longer aborts the whole INSERT chunk with 22001, so clamp here.
const MODEL_MAX_LENGTH = 100;
const PROJECT_MAX_LENGTH = 200;

// Server token columns are bigint — a single fractional/NaN value aborts the
// whole INSERT chunk with 22P02, taking every other tool's rows in the batch
// down with it.
function toTokenCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

export function aggregateToBuckets(entries) {
  const map = new Map();

  for (const e of entries) {
    const model = String(e.model || 'unknown').slice(0, MODEL_MAX_LENGTH);
    const project = String(e.project || 'unknown').slice(0, PROJECT_MAX_LENGTH);
    const bucketStart = roundToHalfHour(e.timestamp).toISOString();
    const key = `${e.source}|${model}|${project}|${e.hostname || ''}|${bucketStart}`;

    if (!map.has(key)) {
      map.set(key, {
        source: e.source,
        model,
        project,
        // Cloud-sourced parsers (cursor) pre-set a fixed hostname sentinel; it
        // must survive aggregation, or sync.js stamps the machine hostname and
        // every machine gets its own duplicate row server-side.
        ...(e.hostname ? { hostname: e.hostname } : {}),
        bucketStart,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        // Prompt-cache *writes*, split by TTL. Anthropic prices them at 1.25x
        // (5m) and 2x (1h) the base input rate, so they cannot be folded into
        // inputTokens without under-billing. Parsers that cannot tell the two
        // TTLs apart leave these at 0 and keep their existing behaviour.
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
      });
    }

    const b = map.get(key);
    b.inputTokens += e.inputTokens || 0;
    b.outputTokens += e.outputTokens || 0;
    b.cachedInputTokens += e.cachedInputTokens || 0;
    b.reasoningOutputTokens += e.reasoningOutputTokens || 0;
    b.cacheCreation5mTokens += e.cacheCreation5mTokens || 0;
    b.cacheCreation1hTokens += e.cacheCreation1hTokens || 0;
  }

  // Clamp after summation, not per entry — rounding each entry first would
  // discard sub-integer values instead of letting them accumulate.
  return Array.from(map.values()).map((b) => {
    const inputTokens = toTokenCount(b.inputTokens);
    const outputTokens = toTokenCount(b.outputTokens);
    const cachedInputTokens = toTokenCount(b.cachedInputTokens);
    const reasoningOutputTokens = toTokenCount(b.reasoningOutputTokens);
    const cacheCreation5mTokens = toTokenCount(b.cacheCreation5mTokens);
    const cacheCreation1hTokens = toTokenCount(b.cacheCreation1hTokens);
    return {
      ...b,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningOutputTokens,
      cacheCreation5mTokens,
      cacheCreation1hTokens,
      // Cache writes stay inside totalTokens: they used to arrive folded into
      // inputTokens, and the server uses this field only as a `> 0` liveness
      // filter. Keeping them in makes the number bit-identical to what the same
      // logs produced before the split, so no bucket drops out of any view.
      totalTokens: inputTokens + outputTokens + reasoningOutputTokens +
        cacheCreation5mTokens + cacheCreation1hTokens,
    };
  });
}

// ---------------------------------------------------------------------------
// Model time (approved 2026-11-25 by the maintainer, Hogan).
//
// "Active time" counts only the time a model spends on a reply: one reply (one
// API call) is one span, from the moment the request went out to the moment the
// reply was written. Running tools, reading files, waiting for a tool or a
// sub-agent, and idle time between prompts are not inside any span.
//
//   - end: when the reply was written (its last record);
//   - start: when the request went out -- the parser's own value where the log
//     has one, else the nearest preceding user message or tool result;
//   - cap: a span is at most 30 s + output tokens / 20 per second, or 2 minutes
//     when the tool does not record per-reply output tokens. This removes the
//     long waits (retries, queueing, rate limits) a boundary-based start would
//     otherwise include: on the maintainer's machine 0.2% of Claude replies
//     waited over 5 minutes for their first line and made half of the uncapped
//     total;
//   - a reply with a known output of 0 tokens (an API error, an interrupted
//     call) counts nothing;
//   - spans of one session never overlap.
//
// Per session the spans become `activeSeconds` (their sum) and `activity`: per
// half-hour bucket (the same local half-hour as token buckets), the seconds of
// model time in each of its six 5-minute cells. sync.js adds the cells of all
// sessions of one tool, project and machine and uploads them; the server's
// union estimate is the sum over cells of min(300 s, seconds in that cell), so
// one session alone is exact and parallel sessions are counted once per cell.
// ---------------------------------------------------------------------------

export const ACTIVITY_CELL_MS = 5 * 60 * 1000;
export const ACTIVITY_CELLS = 6;
const REPLY_CAP_BASE_MS = 30_000;
const REPLY_CAP_OUTPUT_TOKENS_PER_SECOND = 20;
const REPLY_CAP_WITHOUT_TOKENS_MS = 120_000;

function knownTokens(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Longest span one reply may count, from its output tokens (null/undefined: unknown). */
export function replyCapMs(outputTokens) {
  return knownTokens(outputTokens)
    ? REPLY_CAP_BASE_MS + (outputTokens / REPLY_CAP_OUTPUT_TOKENS_PER_SECOND) * 1000
    : REPLY_CAP_WITHOUT_TOKENS_MS;
}

/**
 * The span one reply counts: [start, end] in ms, or null when it counts nothing.
 * `startMs` may be null (no request time and no preceding boundary): the reply
 * then starts at its cap. `prevEndMs` is where the session's previous span
 * ended; spans of one session never overlap.
 */
export function replySpan(startMs, endMs, outputTokens, prevEndMs = null) {
  if (!Number.isFinite(endMs)) return null;
  if (knownTokens(outputTokens) && outputTokens === 0) return null;
  let start = endMs - replyCapMs(outputTokens);
  if (Number.isFinite(startMs) && startMs > start) start = startMs;
  if (Number.isFinite(prevEndMs) && prevEndMs > start) start = prevEndMs;
  return endMs > start ? [start, endMs] : null;
}

/** Empty per-session model-time tally: total ms plus per-bucket cell ms. */
export function createModelTime() {
  return { totalMs: 0, cells: new Map() };
}

/** Add one span to a tally, split over half-hour buckets and 5-minute cells. */
export function addModelTimeSpan(tally, startMs, endMs) {
  if (!(endMs > startMs)) return;
  tally.totalMs += endMs - startMs;
  let t = startMs;
  while (t < endMs) {
    const bucketStartMs = roundToHalfHour(t).getTime();
    let cell = Math.floor((t - bucketStartMs) / ACTIVITY_CELL_MS);
    let cellEnd = bucketStartMs + (cell + 1) * ACTIVITY_CELL_MS;
    // Local half-hours are 30 minutes everywhere except across an ambiguous
    // DST hour; never loop or index outside the six cells.
    if (cell < 0 || cell >= ACTIVITY_CELLS || !(cellEnd > t)) {
      cell = Math.min(ACTIVITY_CELLS - 1, Math.max(0, cell));
      cellEnd = t + ACTIVITY_CELL_MS;
    }
    const pieceEnd = Math.min(cellEnd, endMs);
    const key = new Date(bucketStartMs).toISOString();
    let row = tally.cells.get(key);
    if (!row) {
      row = new Array(ACTIVITY_CELLS).fill(0);
      tally.cells.set(key, row);
    }
    row[cell] += pieceEnd - t;
    t = pieceEnd;
  }
}

/**
 * A tally as session fields: `activeSeconds`, and `activity` as rows of
 * [bucketStart ISO, s0..s5] in whole seconds (rows that round to nothing are
 * left out). `activity` is local only: sync.js turns it into upload rows and
 * never sends it with the session.
 */
export function modelTimeFields(tally) {
  const activity = [];
  for (const [bucketStart, cells] of [...tally.cells].sort((a, b) => a[0].localeCompare(b[0]))) {
    const seconds = cells.map(ms => Math.round(ms / 1000));
    if (seconds.some(s => s > 0)) activity.push([bucketStart, ...seconds]);
  }
  return { activeSeconds: Math.round(tally.totalMs / 1000), activity };
}

/** Serializable copy of a tally (parser caches keep one in an append tail). */
export function serializeModelTime(tally) {
  return { totalMs: tally.totalMs, cells: [...tally.cells] };
}

export function restoreModelTime(saved) {
  const tally = createModelTime();
  if (!saved || typeof saved !== 'object') return tally;
  tally.totalMs = Number(saved.totalMs) || 0;
  for (const [key, row] of Array.isArray(saved.cells) ? saved.cells : []) {
    if (typeof key === 'string' && Array.isArray(row) && row.length === ACTIVITY_CELLS) {
      tally.cells.set(key, row.map(v => Number(v) || 0));
    }
  }
  return tally;
}

/**
 * Incremental session aggregation for parsers whose event stream is already
 * chronological. `extractSessions()` below keeps the sorting fallback for
 * parsers that emit mixed or out-of-order sessions.
 *
 * Events are { timestamp: Date, role: 'user' | 'assistant', outputTokens?,
 * requestAt? }. How replies are read from them (`replyMode`):
 *
 *   - 'events' (default): every assistant event ends a reply that started at
 *     the previous event of either role -- or at its own `requestAt` (a Date),
 *     when the parser records when the request went out (OpenCode: a reply's
 *     created and completed times). This is what every parser gets until
 *     its own log is mapped to replies: a parser that records one event per
 *     reply and per tool result is then measured exactly; one that folds tool
 *     results into assistant events, or drops them, counts at most 2 minutes
 *     (or the token cap) of tool time per event.
 *   - 'runs': consecutive assistant events are one reply (Claude Code writes a
 *     reply as one line per content block, with tool results as user lines);
 *     it starts at the preceding user event and its output tokens are the sum
 *     of the events' `outputTokens`.
 */
export function createSessionAccumulator({ replyMode = 'events' } = {}) {
  return {
    ordered: true,
    replyMode,
    first: null,
    last: null,
    lastTimestampMs: null,
    lastUserMs: null,
    runStartMs: null,
    runEndMs: null,
    runTokens: null,
    prevSpanEndMs: null,
    modelTime: createModelTime(),
    messageCount: 0,
    userMessageCount: 0,
    userPromptHours: new Array(24).fill(0),
  };
}

function countReply(accumulator, startMs, endMs, outputTokens) {
  const span = replySpan(startMs, endMs, outputTokens, accumulator.prevSpanEndMs);
  if (!span) return;
  addModelTimeSpan(accumulator.modelTime, span[0], span[1]);
  accumulator.prevSpanEndMs = span[1];
}

function closeRun(accumulator) {
  if (accumulator.runEndMs === null) return;
  countReply(accumulator, accumulator.runStartMs, accumulator.runEndMs, accumulator.runTokens);
  accumulator.runStartMs = null;
  accumulator.runEndMs = null;
  accumulator.runTokens = null;
}

export function accumulateSessionEvent(accumulator, event) {
  const timestampMs = event.timestamp.getTime();
  if (accumulator.lastTimestampMs !== null && timestampMs < accumulator.lastTimestampMs) {
    accumulator.ordered = false;
  }
  const previousMs = accumulator.lastTimestampMs;
  if (accumulator.first === null) accumulator.first = event;
  accumulator.last = event;
  accumulator.lastTimestampMs = timestampMs;
  accumulator.messageCount++;

  if (event.role === 'user') {
    if (accumulator.replyMode === 'runs') closeRun(accumulator);
    accumulator.lastUserMs = timestampMs;
    accumulator.userMessageCount++;
    accumulator.userPromptHours[event.timestamp.getUTCHours()]++;
    return;
  }
  if (accumulator.replyMode === 'runs') {
    if (accumulator.runEndMs === null) {
      // A session that opens with a reply (no prompt recorded) starts at it.
      accumulator.runStartMs = accumulator.lastUserMs ?? timestampMs;
      accumulator.runTokens = null;
    }
    accumulator.runEndMs = timestampMs;
    if (knownTokens(event.outputTokens)) {
      accumulator.runTokens = (accumulator.runTokens ?? 0) + event.outputTokens;
    }
    return;
  }
  // The first event of a session has nothing before it to start from, unless
  // it records its own request time.
  const requestMs = event.requestAt instanceof Date ? event.requestAt.getTime() : NaN;
  const startMs = Number.isFinite(requestMs) && requestMs <= timestampMs ? requestMs : previousMs;
  if (startMs !== null) countReply(accumulator, startMs, timestampMs, event.outputTokens);
}

export function sessionAccumulatorIsOrdered(accumulator) {
  return accumulator.ordered;
}

export function finalizeSessionAccumulator(accumulator, sessionId, projectOverride) {
  if (accumulator.first === null || accumulator.last === null) return null;
  if (!accumulator.ordered) {
    throw new TypeError('Session accumulator received out-of-order events');
  }
  if (accumulator.replyMode === 'runs') closeRun(accumulator);

  const first = accumulator.first;
  const last = accumulator.last;
  const sessionHash = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  const { activeSeconds, activity } = modelTimeFields(accumulator.modelTime);
  return {
    source: first.source,
    project: projectOverride || first.project || 'unknown',
    sessionHash,
    firstMessageAt: first.timestamp.toISOString(),
    lastMessageAt: last.timestamp.toISOString(),
    durationSeconds: Math.round((last.timestamp - first.timestamp) / 1000),
    activeSeconds,
    messageCount: accumulator.messageCount,
    userMessageCount: accumulator.userMessageCount,
    userPromptHours: accumulator.userPromptHours,
    activity,
  };
}

/**
 * Extract session metadata from timing events.
 * Each event: { sessionId, source, project, timestamp: Date, role: 'user'|'assistant', outputTokens? }
 *
 * activeSeconds = model time (see above); durationSeconds = wall clock from
 * first to last message. `options.replyMode` as for createSessionAccumulator().
 */
export function extractSessions(events, options = {}) {
  const groups = new Map();
  for (const event of events) {
    if (!groups.has(event.sessionId)) groups.set(event.sessionId, []);
    groups.get(event.sessionId).push(event);
  }

  const sessions = [];
  for (const [sessionId, sessionEvents] of groups) {
    sessionEvents.sort((a, b) => a.timestamp - b.timestamp);
    const accumulator = createSessionAccumulator(options);
    for (const event of sessionEvents) accumulateSessionEvent(accumulator, event);
    const session = finalizeSessionAccumulator(accumulator, sessionId);
    if (session) sessions.push(session);
  }
  return sessions;
}
