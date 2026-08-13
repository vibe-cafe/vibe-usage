import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, sep } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './index.js';

// WorkBuddy stores one JSONL transcript per session under
// ~/.workbuddy/projects/<project>/<sessionId>.jsonl. Each line is an event:
//   - type "message"          → timing event (role user|assistant, cwd, sessionId, timestamp)
//   - type "function_call"    → carries the per-request token usage in
//                                providerData.usage (normalized) or providerData.rawUsage
//                                (provider-native, e.g. OpenAI-style prompt/completion_tokens).
// Unlike Claude Code (which puts usage on the assistant message), WorkBuddy
// attaches usage to the function_call that triggered the underlying LLM request.
const PROJECTS_DIR = join(homedir(), '.workbuddy', 'projects');
const MAX_WARNINGS = 20;

function addWarning(ctx, message) {
  ctx.incomplete = true;
  if (ctx.warnings.length < MAX_WARNINGS) ctx.warnings.push(message);
}

/** Recursively collect JSONL files without making one unreadable branch fatal. */
function findJsonlFiles(dir, ctx) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      addWarning(ctx, `WorkBuddy: cannot read directory ${dir}: ${err.message}`);
    }
    return [];
  }
  const results = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonlFiles(fullPath, ctx));
    } else if (entry.name.endsWith('.jsonl')) {
      results.push(fullPath);
    }
  }
  return results;
}

/** Last path component of a Windows/Unix cwd, matching how other parsers name projects. */
function projectFromCwd(cwd, fallback) {
  if (typeof cwd !== 'string') return fallback;
  const trimmed = cwd.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return fallback;
  // Drop bare drive-letter components (e.g. "C:" / "g:") so a cwd like
  // `g:\foo` resolves to "foo" and a bare `g:` falls back instead of "g:".
  const parts = trimmed.split(/[\\/]/).filter(Boolean).filter((p) => !/^[a-zA-Z]:$/.test(p));
  return parts.at(-1) || fallback;
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Pull cached-input tokens from either the normalized or raw usage shape. */
function cachedInputTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  if (Number.isFinite(usage.cachedInputTokens)) return toCount(usage.cachedInputTokens);
  const details = usage.inputTokensDetails;
  if (Array.isArray(details)) {
    let sum = 0;
    for (const d of details) sum += toCount(d?.cached_tokens);
    if (sum > 0) return sum;
  }
  if (usage.prompt_tokens_details && Number.isFinite(usage.prompt_tokens_details.cached_tokens)) {
    return toCount(usage.prompt_tokens_details.cached_tokens);
  }
  if (Number.isFinite(usage.cache_read_input_tokens)) return toCount(usage.cache_read_input_tokens);
  return 0;
}

/** Pull reasoning-output tokens from either the normalized or raw usage shape. */
function reasoningOutputTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  if (Number.isFinite(usage.reasoningOutputTokens)) return toCount(usage.reasoningOutputTokens);
  const details = usage.outputTokensDetails;
  if (Array.isArray(details)) {
    let sum = 0;
    for (const d of details) sum += toCount(d?.reasoning_tokens);
    if (sum > 0) return sum;
  }
  if (usage.completion_tokens_details && Number.isFinite(usage.completion_tokens_details.reasoning_tokens)) {
    return toCount(usage.completion_tokens_details.reasoning_tokens);
  }
  if (Number.isFinite(usage.completion_thinking_tokens)) return toCount(usage.completion_thinking_tokens);
  return 0;
}

function extractUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = toCount(usage.inputTokens ?? usage.prompt_tokens);
  const outputTokens = toCount(usage.outputTokens ?? usage.completion_tokens);
  const cached = cachedInputTokens(usage);
  const reasoning = reasoningOutputTokens(usage);
  if (inputTokens + outputTokens + cached + reasoning === 0) return null;
  return { inputTokens, outputTokens, cached, reasoning };
}

/**
 * Read up to the file size captured at call time so a concurrently-appending
 * transcript doesn't feed us a half-written final line.
 */
async function readJsonl(filePath, onObject) {
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    return;
  }
  if (size === 0) return;
  const stream = createReadStream(filePath, {
    encoding: 'utf8',
    start: 0,
    end: size - 1,
  });
  let streamError = null;
  stream.on('error', (err) => { streamError = err; });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        onObject(JSON.parse(line));
      } catch {
        // A record Claude/WorkBuddy is still appending may be incomplete; a
        // later sync sees the full line. Skip malformed historical lines
        // instead of taking the whole parser down.
      }
    }
    if (streamError) throw streamError;
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function scanFile(filePath, ctx) {
  const entries = [];
  const events = [];
  let sessionProject = 'unknown';
  let foundCwd = false;

  await readJsonl(filePath, (obj) => {
    if (!foundCwd && typeof obj.cwd === 'string' && obj.cwd.trim()) {
      sessionProject = projectFromCwd(obj.cwd, 'unknown');
      foundCwd = true;
    }

    // Timing events come from message rows (user/assistant). The sessionId
    // lets extractSessions group events into sessions.
    if (
      obj.type === 'message' &&
      (obj.role === 'user' || obj.role === 'assistant') &&
      obj.timestamp
    ) {
      const timestamp = new Date(obj.timestamp);
      if (!Number.isNaN(timestamp.getTime())) {
        events.push({
          sessionId: obj.sessionId || 'unknown',
          source: 'workbuddy',
          project: sessionProject,
          timestamp,
          role: obj.role,
        });
      }
    }

    // Token usage lives on function_call rows.
    if (obj.type !== 'function_call' || !obj.providerData) return;
    const usage = extractUsage(obj.providerData.usage) || extractUsage(obj.providerData.rawUsage);
    if (!usage) return;
    const timestamp = new Date(obj.timestamp);
    if (Number.isNaN(timestamp.getTime())) return;

    const model = obj.providerData.model || obj.providerData.requestModelId || obj.providerData.requestModelName || 'unknown';
    entries.push({
      source: 'workbuddy',
      model,
      project: sessionProject,
      timestamp,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cached,
      reasoningOutputTokens: usage.reasoning,
    });
  });

  for (const entry of entries) entry.project = sessionProject;
  for (const event of events) event.project = sessionProject;
  return { entries, events };
}

export async function parse() {
  const ctx = { warnings: [], incomplete: false };

  // Test/diagnostic override (consistent with other parsers).
  const override = process.env.VIBE_USAGE_WORKBUDDY_DIRS?.trim();
  const roots = override
    ? override.split(';').map((s) => s.trim()).filter(Boolean)
    : [PROJECTS_DIR];

  const files = [];
  for (const root of roots) files.push(...findJsonlFiles(root, ctx));

  const allEntries = [];
  const allEvents = [];

  for (const filePath of files) {
    try {
      const parsed = await scanFile(filePath, ctx);
      allEntries.push(...parsed.entries);
      allEvents.push(...parsed.events);
    } catch (err) {
      addWarning(ctx, `WorkBuddy: cannot read ${filePath}: ${err.message}`);
    }
  }

  return {
    buckets: aggregateToBuckets(allEntries),
    sessions: extractSessions(allEvents),
    ...(ctx.incomplete ? { skipped: true } : {}),
    ...(ctx.warnings.length > 0 ? { warnings: ctx.warnings } : {}),
  };
}
