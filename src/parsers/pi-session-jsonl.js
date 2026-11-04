import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { projectFromCwd, toCount } from './fs-utils.js';
import { readMagpieModels, resolveMagpieModel } from './magpie.js';

const MAX_WARNINGS = 20;

function warn(ctx, message) {
  ctx.incomplete = true;
  if (ctx.warnings.length < MAX_WARNINGS) ctx.warnings.push(message);
}

function findJsonlFiles(dir, includeFile, ctx) {
  let children;
  try {
    children = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') {
      warn(ctx, `${ctx.source}: cannot read directory ${dir}: ${err.message}`);
    }
    return [];
  }

  const files = [];
  for (const child of children) {
    const filePath = join(dir, child.name);
    if (child.isDirectory()) {
      for (const nested of findJsonlFiles(filePath, includeFile, ctx)) files.push(nested);
    } else if (child.name.endsWith('.jsonl') && includeFile(filePath)) {
      files.push(filePath);
    }
  }
  return files;
}

export function projectFromFirstDir(filePath, sessionsDir) {
  const first = relative(sessionsDir, filePath).split(/[\\/]/)[0];
  if (!first) return 'unknown';
  return first.split('-').filter(Boolean).at(-1) || 'unknown';
}

// Configured stores can overlap: an ancestor and its descendant, or two paths
// that resolve to the same place through a symlink. Record-level dedup only
// covers entries carrying an `id`, so the same anonymous record would be
// counted once per path that reaches it. Collapse on the canonical file path
// instead, which also folds symlinked duplicates of a single file.
function canonicalFilePath(filePath) {
  try {
    return realpathSync.native(filePath);
  } catch {
    return filePath;
  }
}

export async function parsePiSessionJsonl({
  source,
  sessionsDirs,
  includeFile = () => true,
  projectFromPath = projectFromFirstDir,
  deduplicateCopiedSessions = false,
  resolveMagpie = false,
}) {
  const ctx = { source, warnings: [], incomplete: false };
  const entriesById = new Map();
  const anonymousEntries = [];
  const eventsById = new Map();
  const anonymousEvents = [];
  const seenFiles = new Set();
  const recordOwners = new Map();
  let magpieModels;
  const magpie = { resolved: 0, unresolved: 0 };

  for (const sessionsDir of sessionsDirs) {
    for (const filePath of findJsonlFiles(sessionsDir, includeFile, ctx)) {
      const canonical = canonicalFilePath(filePath);
      if (seenFiles.has(canonical)) continue;
      seenFiles.add(canonical);

      let content;
      try {
        content = readFileSync(filePath, 'utf8');
      } catch (err) {
        warn(ctx, `${source}: cannot read ${filePath}: ${err.message}`);
        continue;
      }

      let sessionId = basename(filePath, '.jsonl');
      let project = projectFromPath(filePath, sessionsDir) || 'unknown';
      let sessionStartedAt = Infinity;
      let seenHeader = false;

      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (!obj || typeof obj !== 'object') continue;

        if (obj.type === 'session') {
          if (deduplicateCopiedSessions && seenHeader) continue;
          seenHeader = true;
          if (obj.id) sessionId = String(obj.id);
          if (obj.cwd) project = projectFromCwd(obj.cwd);
          const startedAt = new Date(obj.timestamp).getTime();
          sessionStartedAt = Number.isFinite(startedAt) ? startedAt : Infinity;
          continue;
        }
        if (obj.type !== 'message' || !obj.message) continue;

        const message = obj.message;
        const rawTimestamp = obj.timestamp || message.timestamp;
        const timestamp = new Date(rawTimestamp || 0);
        if (Number.isNaN(timestamp.getTime())) continue;
        const model = message.model || message.modelId || obj.model || obj.modelId || 'unknown';
        // Cola copies a transcript with a new session header but unchanged
        // records. Its short message ids are only unique within a session, so
        // cross-session dedup also requires time, parent, role, and model.
        // All existing Pi-family callers retain sessionId:id identities.
        const recordId = !obj.id ? null : deduplicateCopiedSessions && rawTimestamp
          ? JSON.stringify([obj.id, timestamp.getTime(), obj.parentId ?? null, message.role, model])
          : `${sessionId}:${obj.id}`;

        if (deduplicateCopiedSessions && recordId) {
          const owner = recordOwners.get(recordId);
          if (!owner || sessionStartedAt < owner.startedAt
            || (sessionStartedAt === owner.startedAt && sessionId < owner.sessionId)
            || (sessionStartedAt === owner.startedAt && sessionId === owner.sessionId && canonical < owner.filePath)) {
            recordOwners.set(recordId, { sessionId, project, startedAt: sessionStartedAt, filePath: canonical });
          }
        }

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
        // Pi's Usage type names this field `reasoning` (a documented subset of
        // `output`); older/adjacent stores wrote `reasoningTokens`. Reading only
        // the latter left every Pi reasoning token inside outputTokens.
        const reasoningOutputTokens = toCount(usage.reasoning ?? usage.reasoningTokens);
        // OMP/Pi usage.output includes reasoning; the shared bucket contract
        // stores non-reasoning output and reasoning separately.
        const outputTokens = Math.max(0, toCount(usage.output) - reasoningOutputTokens);
        const cachedInputTokens = toCount(usage.cacheRead);
        const score = inputTokens + outputTokens + cachedInputTokens + reasoningOutputTokens;
        if (score === 0) continue;

        let attributedModel = model;
        if (resolveMagpie && message.provider === 'magpie'
          && typeof model === 'string' && model.startsWith('group/')) {
          magpieModels ??= await readMagpieModels(ctx.warnings);
          const resolved = resolveMagpieModel(magpieModels, message, model);
          if (resolved) {
            attributedModel = resolved;
            magpie.resolved++;
          } else {
            magpie.unresolved++;
          }
        }

        const entry = {
          source,
          model: attributedModel,
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
    ...[...entriesById].map(([id, { entry }]) => {
      const owner = recordOwners.get(id);
      return owner ? { ...entry, project: owner.project } : entry;
    }),
  ];
  const events = [
    ...anonymousEvents,
    ...[...eventsById].map(([id, event]) => {
      const owner = recordOwners.get(id);
      return owner ? { ...event, sessionId: owner.sessionId, project: owner.project } : event;
    }),
  ];
  return {
    buckets: aggregateToBuckets(entries),
    sessions: extractSessions(events),
    ...(ctx.incomplete ? { skipped: true } : {}),
    ...(ctx.warnings.length > 0 ? { warnings: ctx.warnings } : {}),
    ...(magpie.resolved + magpie.unresolved > 0 ? { info: { magpie } } : {}),
  };
}
