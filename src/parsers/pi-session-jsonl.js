import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { projectFromCwd, toCount } from './fs-utils.js';

const MAX_WARNINGS = 20;

function warn(ctx, message) {
  ctx.incomplete = true;
  if (ctx.warnings.length < MAX_WARNINGS) ctx.warnings.push(message);
}

function findJsonlFiles(dir, includeFile, ctx) {
  if (!existsSync(dir)) return [];
  let children;
  try {
    children = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    warn(ctx, `${ctx.source}: cannot read directory ${dir}: ${err.message}`);
    return [];
  }

  const files = [];
  for (const child of children) {
    const filePath = join(dir, child.name);
    if (child.isDirectory()) files.push(...findJsonlFiles(filePath, includeFile, ctx));
    else if (child.name.endsWith('.jsonl') && includeFile(filePath)) files.push(filePath);
  }
  return files;
}

export function projectFromFirstDir(filePath, sessionsDir) {
  const first = relative(sessionsDir, filePath).split(/[\\/]/)[0];
  if (!first) return 'unknown';
  return first.split('-').filter(Boolean).at(-1) || 'unknown';
}

export async function parsePiSessionJsonl({
  source,
  sessionsDirs,
  includeFile = () => true,
  projectFromPath = projectFromFirstDir,
}) {
  const ctx = { source, warnings: [], incomplete: false };
  const entriesById = new Map();
  const anonymousEntries = [];
  const eventsById = new Map();
  const anonymousEvents = [];

  for (const sessionsDir of sessionsDirs) {
    for (const filePath of findJsonlFiles(sessionsDir, includeFile, ctx)) {
      let content;
      try {
        content = readFileSync(filePath, 'utf8');
      } catch (err) {
        warn(ctx, `${source}: cannot read ${filePath}: ${err.message}`);
        continue;
      }

      let sessionId = basename(filePath, '.jsonl');
      let project = projectFromPath(filePath, sessionsDir) || 'unknown';

      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }

        if (obj.type === 'session') {
          if (obj.id) sessionId = String(obj.id);
          if (obj.cwd) project = projectFromCwd(obj.cwd);
          continue;
        }
        if (obj.type !== 'message' || !obj.message) continue;

        const message = obj.message;
        const timestamp = new Date(obj.timestamp || message.timestamp || 0);
        if (Number.isNaN(timestamp.getTime())) continue;
        const recordId = obj.id ? `${sessionId}:${obj.id}` : null;

        if (message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult') {
          const event = {
            sessionId,
            source,
            project,
            timestamp,
            role: message.role === 'user' ? 'user' : 'assistant',
          };
          if (recordId) eventsById.set(recordId, event);
          else anonymousEvents.push(event);
        }

        if (message.role !== 'assistant' || !message.usage) continue;
        const usage = message.usage;
        const inputTokens = toCount(usage.input) + toCount(usage.cacheWrite);
        const reasoningOutputTokens = toCount(usage.reasoningTokens);
        // OMP/Pi usage.output includes reasoning; the shared bucket contract
        // stores non-reasoning output and reasoning separately.
        const outputTokens = Math.max(0, toCount(usage.output) - reasoningOutputTokens);
        const cachedInputTokens = toCount(usage.cacheRead);
        const score = inputTokens + outputTokens + cachedInputTokens + reasoningOutputTokens;
        if (score === 0) continue;

        const entry = {
          source,
          model: message.model || message.modelId || obj.model || obj.modelId || 'unknown',
          project,
          timestamp,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          reasoningOutputTokens,
        };
        if (!recordId) {
          anonymousEntries.push(entry);
        } else {
          const current = entriesById.get(recordId);
          if (!current || score > current.score) entriesById.set(recordId, { score, entry });
        }
      }
    }
  }

  const entries = [
    ...anonymousEntries,
    ...[...entriesById.values()].map(({ entry }) => entry),
  ];
  const events = [...anonymousEvents, ...eventsById.values()];
  return {
    buckets: aggregateToBuckets(entries),
    sessions: extractSessions(events),
    ...(ctx.incomplete ? { skipped: true } : {}),
    ...(ctx.warnings.length > 0 ? { warnings: ctx.warnings } : {}),
  };
}
