import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import { findGrokDataDirs, getGrokSessionsDir } from '../tools.js';
import { aggregateToBuckets, extractSessions } from './index.js';

const SOURCE = 'grok';

/**
 * Grok (Grok Build TUI / CLI) parser.
 *
 * Layout (see ~/.grok/docs/user-guide/17-sessions.md):
 *   $GROK_HOME/sessions/<url-encoded-cwd>/<session-id>/
 *     summary.json     — cwd, model, timestamps
 *     updates.jsonl    — ACP session updates; turn_completed carries exact usage
 *     events.jsonl     — turn_started / turn_ended timing
 *
 * GROK_HOME defaults to ~/.grok. Override with GROK_HOME or
 * VIBE_USAGE_GROK_SESSIONS (tests / relocated session trees).
 *
 * Token usage comes from updates.jsonl `turn_completed.usage` (and per-model
 * `modelUsage` when present). inputTokens is non-cached prompt (total − cache
 * reads), matching Codex/Copilot so totalTokens does not double-count cache.
 */

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function projectFromPath(absPath) {
  if (!absPath || typeof absPath !== 'string') return 'unknown';
  const trimmed = absPath.replace(/[\\/]+$/, '');
  const name = basename(trimmed);
  return name || 'unknown';
}

/** Decode a sessions group dirname; fall back to basename after decode. */
function projectFromGroupDir(groupName, groupPath) {
  const cwdFile = join(groupPath, '.cwd');
  if (existsSync(cwdFile)) {
    try {
      const raw = readFileSync(cwdFile, 'utf-8').trim();
      if (raw) return projectFromPath(raw);
    } catch {
      // ignore
    }
  }
  try {
    const decoded = decodeURIComponent(groupName);
    if (decoded.includes('/') || decoded.includes('\\')) {
      return projectFromPath(decoded);
    }
  } catch {
    // not URI-encoded
  }
  return groupName || 'unknown';
}

function toDate(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Unix seconds (Grok updates.jsonl) vs milliseconds
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function pushUsageEntry(entries, { model, project, timestamp, usage }) {
  if (!usage || typeof usage !== 'object') return;
  if (!timestamp) return;

  const totalInput = Math.max(0, Number(usage.inputTokens) || 0);
  const cached = Math.max(0, Number(usage.cachedReadTokens) || 0);
  const output = Math.max(0, Number(usage.outputTokens) || 0);
  const reasoning = Math.max(0, Number(usage.reasoningTokens) || 0);

  // Prefer exclusive fields when both are present (Codex-style).
  const inputTokens = Math.max(0, totalInput - cached);
  const outputTokens = Math.max(0, output - reasoning);

  if (inputTokens + outputTokens + cached + reasoning === 0) return;

  entries.push({
    source: SOURCE,
    model: model || 'unknown',
    project,
    timestamp,
    inputTokens,
    outputTokens,
    cachedInputTokens: cached,
    reasoningOutputTokens: reasoning,
  });
}

function emitTurnUsage(entries, { usage, project, timestamp, fallbackModel }) {
  if (!usage || typeof usage !== 'object') return;

  const modelUsage = usage.modelUsage;
  if (modelUsage && typeof modelUsage === 'object' && Object.keys(modelUsage).length > 0) {
    for (const [model, mUsage] of Object.entries(modelUsage)) {
      pushUsageEntry(entries, {
        model,
        project,
        timestamp,
        usage: mUsage && typeof mUsage === 'object' ? mUsage : usage,
      });
    }
    return;
  }

  pushUsageEntry(entries, {
    model: fallbackModel,
    project,
    timestamp,
    usage,
  });
}

async function forEachJsonlLine(filePath, onLine) {
  if (!existsSync(filePath)) return;
  let stream;
  try {
    stream = createReadStream(filePath, { encoding: 'utf-8' });
  } catch {
    return;
  }

  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      onLine(obj);
    }
  } catch {
    // unreadable / truncated mid-write — keep what we have
  } finally {
    rl.close();
    stream.destroy();
  }
}

function listSessionDirs(sessionsDir) {
  const results = [];
  if (!existsSync(sessionsDir)) return results;

  let groups;
  try {
    groups = readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const group of groups) {
    if (!group.isDirectory()) continue;
    // Skip non-project group dirs (e.g. future index folders).
    const groupPath = join(sessionsDir, group.name);
    let children;
    try {
      children = readdirSync(groupPath, { withFileTypes: true });
    } catch {
      continue;
    }

    const projectFallback = projectFromGroupDir(group.name, groupPath);

    for (const child of children) {
      if (!child.isDirectory()) continue;
      const sessionPath = join(groupPath, child.name);
      // A real session always has summary.json (or at least updates/chat history).
      if (
        !existsSync(join(sessionPath, 'summary.json')) &&
        !existsSync(join(sessionPath, 'updates.jsonl'))
      ) {
        continue;
      }
      results.push({
        sessionId: child.name,
        sessionPath,
        projectFallback,
      });
    }
  }

  return results;
}

/**
 * Parse all Grok sessions under the configured sessions root(s).
 * @returns {Promise<{ buckets: object[], sessions: object[] }>}
 */
export async function parse() {
  const sessionRoots = findGrokDataDirs();
  // findGrokDataDirs returns sessions dirs; also allow empty → try default once
  const roots = sessionRoots.length > 0 ? sessionRoots : [getGrokSessionsDir()].filter(existsSync);
  if (roots.length === 0) return { buckets: [], sessions: [] };

  const entries = [];
  const sessionEvents = [];

  for (const sessionsDir of roots) {
    for (const { sessionId, sessionPath, projectFallback } of listSessionDirs(sessionsDir)) {
      const summary = readJsonSafe(join(sessionPath, 'summary.json')) || {};
      const cwd = summary.info?.cwd || summary.git_root_dir || null;
      const project = cwd ? projectFromPath(cwd) : projectFallback;
      const fallbackModel = summary.current_model_id || 'unknown';

      // Prefer updates.jsonl turn_completed for exact usage + message timings.
      let sawUserOrAssistant = false;
      await forEachJsonlLine(join(sessionPath, 'updates.jsonl'), (obj) => {
        const update = obj?.params?.update;
        if (!update || typeof update !== 'object') return;

        const kind = update.sessionUpdate;
        const timestamp = toDate(obj.timestamp);

        if (kind === 'turn_completed' && timestamp) {
          emitTurnUsage(entries, {
            usage: update.usage,
            project,
            timestamp,
            fallbackModel,
          });
        }

        if (!timestamp) return;

        if (kind === 'user_message_chunk') {
          sawUserOrAssistant = true;
          sessionEvents.push({
            sessionId,
            source: SOURCE,
            project,
            timestamp,
            role: 'user',
          });
        } else if (kind === 'agent_message_chunk' || kind === 'turn_completed') {
          sawUserOrAssistant = true;
          sessionEvents.push({
            sessionId,
            source: SOURCE,
            project,
            timestamp,
            role: 'assistant',
          });
        }
      });

      // Fallback timing from events.jsonl when updates lack message chunks
      // (short/aborted sessions, older builds).
      if (!sawUserOrAssistant) {
        await forEachJsonlLine(join(sessionPath, 'events.jsonl'), (obj) => {
          const timestamp = toDate(obj.ts || obj.timestamp);
          if (!timestamp) return;
          if (obj.type === 'turn_started') {
            sessionEvents.push({
              sessionId,
              source: SOURCE,
              project,
              timestamp,
              role: 'user',
            });
          } else if (obj.type === 'turn_ended' || obj.type === 'first_token') {
            sessionEvents.push({
              sessionId,
              source: SOURCE,
              project,
              timestamp,
              role: 'assistant',
            });
          }
        });
      }

      // Last-resort session envelope from summary timestamps so a session with
      // no parseable turns still appears once usage lands later.
      if (sessionEvents.every((e) => e.sessionId !== sessionId)) {
        const created = toDate(summary.created_at || summary.info?.created_at);
        const updated = toDate(summary.updated_at || summary.last_active_at);
        if (created) {
          sessionEvents.push({
            sessionId,
            source: SOURCE,
            project,
            timestamp: created,
            role: 'user',
          });
        }
        if (updated && (!created || updated.getTime() !== created.getTime())) {
          sessionEvents.push({
            sessionId,
            source: SOURCE,
            project,
            timestamp: updated,
            role: 'assistant',
          });
        }
      }
    }
  }

  return {
    buckets: aggregateToBuckets(entries),
    sessions: extractSessions(sessionEvents),
  };
}
