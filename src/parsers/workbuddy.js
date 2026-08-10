import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join, relative, sep } from 'node:path';
import { findWorkbuddyDataDirs } from '../workbuddy-roots.js';
import { aggregateToBuckets } from './index.js';

const SOURCE = 'workbuddy';

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
  const rel = relative(projectsDir, filePath);
  const first = rel.split(sep).filter(Boolean)[0];
  return first ? basename(first) : 'unknown';
}

function projectFromRecord(record, fallback) {
  const cwd = typeof record.cwd === 'string' ? record.cwd.trim() : '';
  if (!cwd) return fallback;
  const project = basename(cwd.replace(/[\\/]+$/, ''));
  return project || fallback;
}

function findJsonlFiles(dir, ctx) {
  let children;
  try {
    children = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    ctx.skipped = true;
    ctx.warnings.push('workbuddy: cannot read a data directory');
    return [];
  }

  const files = [];
  for (const child of children) {
    const fullPath = join(dir, child.name);
    if (child.isDirectory()) files.push(...findJsonlFiles(fullPath, ctx));
    else if (child.isFile() && child.name.endsWith('.jsonl')) files.push(fullPath);
  }
  return files;
}

async function readJsonl(filePath, size, onRecord, ctx) {
  if (size <= 0) return;
  let stream;
  try {
    stream = createReadStream(filePath, {
      encoding: 'utf8',
      start: 0,
      end: size - 1,
    });
  } catch (error) {
    ctx.skipped = true;
    ctx.warnings.push('workbuddy: cannot read a session file');
    return;
  }

  let streamError = null;
  stream.on('error', (error) => { streamError = error; });
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
  } catch (error) {
    ctx.skipped = true;
    ctx.warnings.push('workbuddy: cannot read a session file');
  } finally {
    lines.close();
    stream.destroy();
  }
}

function isCompletedAssistant(record) {
  const message = record.message;
  if (!message || typeof message !== 'object') return false;
  if (record.type !== 'message') return false;
  const role = record.role ?? message.role;
  if (role !== 'assistant' && role !== 'assistant_message') return false;
  const status = String(record.status ?? message.status ?? record.state ?? message.state ?? '').toLowerCase();
  return status === 'completed' || status === 'complete' || status === 'success';
}

function modelFor(record) {
  const providerData = record.providerData;
  if (providerData && typeof providerData.requestModelId === 'string' && providerData.requestModelId.trim()) {
    return providerData.requestModelId.trim();
  }
  for (const value of [record.requestModelName, providerData?.requestModelName, providerData?.model]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return 'unknown';
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

  const firstDetailValue = (details, ...keys) => {
    const values = Array.isArray(details) ? details : [details];
    for (const detail of values) {
      if (!detail || typeof detail !== 'object') continue;
      for (const key of keys) {
        if (detail[key] != null) return finite(detail[key]);
      }
    }
    return 0;
  };
  const inputDetails = primary?.input_details ?? primary?.inputDetails;
  const outputDetails = primary?.output_details ?? primary?.outputDetails;
  const cached = firstDetailValue(inputDetails, 'cached_tokens', 'cachedTokens')
    || finite(primary?.cache_read_input_tokens ?? primary?.cacheReadInputTokens ?? raw?.prompt_cache_hit_tokens ?? raw?.cache_read_input_tokens);
  const reasoning = firstDetailValue(outputDetails, 'reasoning_tokens', 'reasoningTokens')
    || finite(primary?.completion_thinking_tokens ?? primary?.reasoning_tokens ?? primary?.reasoningTokens ?? raw?.completion_thinking_tokens);
  const totalInput = finite(primary?.inputTokens ?? primary?.input_tokens ?? raw?.prompt_tokens);
  const totalOutput = finite(primary?.outputTokens ?? primary?.output_tokens ?? raw?.completion_tokens);
  const rawMiss = finite(raw?.prompt_cache_miss_tokens);
  // `prompt_cache_miss_tokens` is already exclusive of cache reads. The
  // aggregate `inputTokens` field is inclusive, so only that fallback needs
  // cache subtraction.
  const inputTokens = rawMiss > 0 ? rawMiss : Math.max(0, totalInput - cached);
  const outputTokens = Math.max(0, totalOutput - reasoning);
  const totalTokens = finite(primary?.totalTokens ?? primary?.total_tokens ?? raw?.total_tokens);
  if (inputTokens + outputTokens + cached + reasoning === 0) return null;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: cached,
    reasoningOutputTokens: reasoning,
    totalTokens,
  };
}

function timestampFor(record) {
  return dateFrom(record.completedAt ?? record.completed_at ?? record.timestamp ?? record.createdAt ?? record.created_at ?? record.message?.createdAt);
}

export async function parse() {
  const entries = [];
  const ctx = { skipped: false, warnings: [] };
  const seenIds = new Set();

  for (const configuredRoot of findWorkbuddyDataDirs()) {
    const projectsDir = basename(configuredRoot) === 'projects' ? configuredRoot : join(configuredRoot, 'projects');
    const files = findJsonlFiles(projectsDir, ctx);
    for (const filePath of files) {
      let size;
      try {
        size = statSync(filePath).size;
      } catch (error) {
        ctx.skipped = true;
        ctx.warnings.push('workbuddy: cannot stat a session file');
        continue;
      }
      const fileProject = projectFromFile(filePath, projectsDir);
      await readJsonl(filePath, size, (record) => {
        if (!isCompletedAssistant(record)) return;
        if (typeof record.id !== 'string' || !record.id || seenIds.has(record.id)) return;
        const usage = usageFor(record);
        const timestamp = timestampFor(record);
        if (!usage || !timestamp) return;
        seenIds.add(record.id);
        entries.push({
          source: SOURCE,
          model: modelFor(record),
          project: projectFromRecord(record, fileProject),
          timestamp,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          reasoningOutputTokens: usage.reasoningOutputTokens,
        });
      }, ctx);
    }
  }

  return {
    buckets: aggregateToBuckets(entries),
    sessions: [],
    ...(ctx.skipped ? { skipped: true } : {}),
    ...(ctx.warnings.length > 0 ? { warnings: ctx.warnings } : {}),
  };
}
