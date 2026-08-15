import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join, relative, sep } from 'node:path';
import { findWorkbuddyDataDirs } from '../workbuddy-roots.js';
import { aggregateToBuckets, extractSessions } from './aggregate.js';

const SOURCE = 'workbuddy';
const MAX_WARNINGS = 20;

function warn(ctx, message) {
  ctx.skipped = true;
  if (ctx.warnings.length < MAX_WARNINGS && !ctx.warnings.includes(message)) {
    ctx.warnings.push(message);
  }
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function dateFrom(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function projectFromFile(filePath, projectsDir) {
  const first = relative(projectsDir, filePath).split(sep).filter(Boolean)[0];
  return first ? basename(first) : 'unknown';
}

function projectFromRecord(record) {
  const cwd = typeof record.cwd === 'string' ? record.cwd.trim() : '';
  if (!cwd) return null;
  const parts = cwd
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)
    .filter(part => !/^[a-zA-Z]:$/.test(part));
  return parts.at(-1) || null;
}

function findJsonlFiles(dir, ctx) {
  let children;
  try {
    children = readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    warn(ctx, 'workbuddy: cannot read a data directory');
    return [];
  }

  const files = [];
  for (const child of children) {
    const filePath = join(dir, child.name);
    if (child.isDirectory()) files.push(...findJsonlFiles(filePath, ctx));
    else if (child.isFile() && child.name.endsWith('.jsonl')) files.push(filePath);
  }
  return files;
}

async function readJsonl(filePath, size, onRecord, ctx) {
  if (size <= 0) return;
  const stream = createReadStream(filePath, {
    encoding: 'utf8',
    start: 0,
    end: size - 1,
  });
  let streamError = null;
  stream.on('error', error => { streamError = error; });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record && typeof record === 'object') onRecord(record);
    }
    if (streamError) throw streamError;
  } catch {
    warn(ctx, 'workbuddy: cannot read a session file');
  } finally {
    lines.close();
    stream.destroy();
  }
}

function recordId(record) {
  if (typeof record.id !== 'string' && typeof record.id !== 'number') return null;
  const id = String(record.id).trim();
  return id || null;
}

function roleFor(record) {
  const role = record.role ?? record.message?.role;
  if (role === 'user') return 'user';
  if (role === 'assistant' || role === 'assistant_message') return 'assistant';
  return null;
}

function isCompletedAssistant(record) {
  if (record.type !== 'message' || roleFor(record) !== 'assistant') return false;
  const status = String(
    record.status ?? record.message?.status ?? record.state ?? record.message?.state ?? ''
  ).toLowerCase();
  return status === 'completed' || status === 'complete' || status === 'success';
}

function isUsageRecord(record) {
  return isCompletedAssistant(record)
    || (record.type === 'function_call'
      && record.providerData
      && typeof record.providerData === 'object');
}

function modelFor(record) {
  const providerData = record.providerData && typeof record.providerData === 'object'
    ? record.providerData
    : {};
  for (const value of [
    providerData.requestModelId,
    record.requestModelName,
    providerData.requestModelName,
    providerData.model,
  ]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return 'unknown';
}

function firstDetailValue(details, ...keys) {
  for (const detail of Array.isArray(details) ? details : [details]) {
    if (!detail || typeof detail !== 'object') continue;
    for (const key of keys) {
      if (detail[key] != null) return finite(detail[key]);
    }
  }
  return 0;
}

function usageFor(record) {
  const providerData = record.providerData && typeof record.providerData === 'object'
    ? record.providerData
    : {};
  const primary = providerData.usage && typeof providerData.usage === 'object'
    ? providerData.usage
    : record.message?.usage && typeof record.message.usage === 'object'
      ? record.message.usage
      : null;
  const raw = providerData.rawUsage && typeof providerData.rawUsage === 'object'
    ? providerData.rawUsage
    : null;
  if (!primary && !raw) return null;

  const inputDetails = primary?.input_details
    ?? primary?.inputDetails
    ?? primary?.inputTokensDetails
    ?? raw?.prompt_tokens_details;
  const outputDetails = primary?.output_details
    ?? primary?.outputDetails
    ?? primary?.outputTokensDetails
    ?? raw?.completion_tokens_details;
  const cachedInputTokens = firstDetailValue(inputDetails, 'cached_tokens', 'cachedTokens')
    || finite(
      primary?.cachedInputTokens
      ?? primary?.cache_read_input_tokens
      ?? primary?.cacheReadInputTokens
      ?? raw?.prompt_cache_hit_tokens
      ?? raw?.cache_read_input_tokens
    );
  const reasoningOutputTokens = firstDetailValue(outputDetails, 'reasoning_tokens', 'reasoningTokens')
    || finite(
      primary?.reasoningOutputTokens
      ?? primary?.completion_thinking_tokens
      ?? primary?.reasoning_tokens
      ?? primary?.reasoningTokens
      ?? raw?.completion_thinking_tokens
    );
  const inclusiveInput = finite(primary?.inputTokens ?? primary?.input_tokens ?? raw?.prompt_tokens);
  const inclusiveOutput = finite(primary?.outputTokens ?? primary?.output_tokens ?? raw?.completion_tokens);
  const cacheMiss = finite(raw?.prompt_cache_miss_tokens);

  // WorkBuddy's aggregate input/output fields include cache reads/reasoning.
  // Prefer the provider's exclusive cache-miss field when available.
  const inputTokens = cacheMiss > 0
    ? cacheMiss
    : Math.max(0, inclusiveInput - cachedInputTokens);
  const outputTokens = Math.max(0, inclusiveOutput - reasoningOutputTokens);
  const score = inputTokens + outputTokens + cachedInputTokens + reasoningOutputTokens;
  if (score === 0) return null;

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    score,
  };
}

function timestampFor(record) {
  return dateFrom(
    record.completedAt
    ?? record.completed_at
    ?? record.timestamp
    ?? record.createdAt
    ?? record.created_at
    ?? record.message?.createdAt
  );
}

function sessionEventsWithPrompts(events) {
  const sessionsWithUsers = new Set(
    events.filter(event => event.role === 'user').map(event => event.sessionId)
  );
  return events.filter(event => sessionsWithUsers.has(event.sessionId));
}

export async function parse() {
  const entriesById = new Map();
  const eventsByKey = new Map();
  const ctx = { skipped: false, warnings: [] };
  const projectDirs = [...new Set(findWorkbuddyDataDirs().map(root => (
    basename(root) === 'projects' ? root : join(root, 'projects')
  )))];

  for (const projectsDir of projectDirs) {
    for (const filePath of findJsonlFiles(projectsDir, ctx)) {
      let size;
      try {
        size = statSync(filePath).size;
      } catch {
        warn(ctx, 'workbuddy: cannot stat a session file');
        continue;
      }

      const fallbackSessionId = basename(filePath, '.jsonl');
      let project = projectFromFile(filePath, projectsDir);
      const fileEntries = [];
      const fileEvents = [];

      await readJsonl(filePath, size, record => {
        project = projectFromRecord(record) || project;
        const timestamp = timestampFor(record);
        const id = recordId(record);
        const role = roleFor(record);
        const explicitSessionId = record.sessionId ?? record.session_id;
        const sessionId = explicitSessionId == null || String(explicitSessionId).trim() === ''
          ? fallbackSessionId
          : String(explicitSessionId);

        const usage = isUsageRecord(record) ? usageFor(record) : null;
        const eventRole = role === 'user'
          ? 'user'
          : isCompletedAssistant(record) || (record.type === 'function_call' && usage)
            ? 'assistant'
            : null;
        if (timestamp && eventRole) {
          fileEvents.push({ id, sessionId, timestamp, role: eventRole });
        }

        if (!id || !timestamp || !usage) return;
        fileEntries.push({
          id,
          score: usage.score,
          entry: {
            source: SOURCE,
            model: modelFor(record),
            timestamp,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            reasoningOutputTokens: usage.reasoningOutputTokens,
          },
        });
      }, ctx);

      for (const candidate of fileEntries) {
        candidate.entry.project = project;
        const current = entriesById.get(candidate.id);
        if (!current || candidate.score > current.score) entriesById.set(candidate.id, candidate);
      }
      for (const candidate of fileEvents) {
        const event = {
          sessionId: candidate.sessionId,
          source: SOURCE,
          project,
          timestamp: candidate.timestamp,
          role: candidate.role,
        };
        const key = candidate.id
          ? `id:${candidate.sessionId}:${candidate.id}:${candidate.role}`
          : `fallback:${candidate.sessionId}:${candidate.role}:${candidate.timestamp.toISOString()}`;
        eventsByKey.set(key, event);
      }
    }
  }

  return {
    buckets: aggregateToBuckets([...entriesById.values()].map(({ entry }) => entry)),
    sessions: extractSessions(sessionEventsWithPrompts([...eventsByKey.values()])),
    ...(ctx.skipped ? { skipped: true } : {}),
    ...(ctx.warnings.length > 0 ? { warnings: ctx.warnings } : {}),
  };
}
