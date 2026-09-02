import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { findGrokDataDirs, getGrokSessionsDir } from '../tools.js';
import { grokSessionsDir, normalizeExtraRoot } from '../extra-roots.js';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { readJsonSafe, projectFromPath } from './fs-utils.js';

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

/** Decode a sessions group dirname; fall back to basename after decode. */
function projectFromGroupDir(groupName, groupPath, strict = false) {
  const cwdFile = join(groupPath, '.cwd');
  if (existsSync(cwdFile)) {
    try {
      const raw = readFileSync(cwdFile, 'utf-8').trim();
      if (raw) return projectFromPath(raw);
    } catch (err) {
      if (strict) throw err;
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

async function forEachJsonlLine(filePath, onLine, strict = false) {
  if (!existsSync(filePath)) return;
  let stream;
  try {
    stream = createReadStream(filePath, { encoding: 'utf-8' });
  } catch (err) {
    if (strict) throw err;
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
  } catch (err) {
    if (strict) throw err;
    // unreadable / truncated mid-write — keep what we have
  } finally {
    rl.close();
    stream.destroy();
  }
}

function listSessionDirs(sessionsDir, strict = false) {
  const results = [];
  if (!existsSync(sessionsDir)) {
    if (strict) throw new Error(`missing sessions directory: ${sessionsDir}`);
    return results;
  }

  let groups;
  try {
    groups = readdirSync(sessionsDir, { withFileTypes: true });
  } catch (err) {
    if (strict) throw err;
    return results;
  }

  for (const group of groups) {
    if (!group.isDirectory()) continue;
    // Skip non-project group dirs (e.g. future index folders).
    const groupPath = join(sessionsDir, group.name);
    let children;
    try {
      children = readdirSync(groupPath, { withFileTypes: true });
    } catch (err) {
      if (strict) throw err;
      continue;
    }

    const projectFallback = projectFromGroupDir(group.name, groupPath, strict);

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
export async function parse({ extraRoots = [] } = {}) {
  if (!process.env.VIBE_USAGE_GROK_SESSIONS?.trim()) {
    for (const root of extraRoots) {
      const sessionsDir = grokSessionsDir(root);
      try {
        if (!statSync(sessionsDir).isDirectory()) throw new Error('not a directory');
      } catch {
        return {
          buckets: [],
          sessions: [],
          skipped: true,
          warnings: [`grok: 额外根目录不可用，已跳过本次 Grok 同步: ${normalizeExtraRoot(root)}`],
        };
      }
    }
  }
  const strictRoots = process.env.VIBE_USAGE_GROK_SESSIONS?.trim()
    ? new Set()
    : new Set(extraRoots.map(grokSessionsDir));
  const sessionRoots = findGrokDataDirs(extraRoots);
  for (const configuredRoot of strictRoots) {
    if (!sessionRoots.includes(configuredRoot)) sessionRoots.push(configuredRoot);
  }
  // findGrokDataDirs returns sessions dirs; also allow empty → try default once
  const roots = sessionRoots.length > 0 ? sessionRoots : [getGrokSessionsDir()].filter(existsSync);
  if (roots.length === 0) return { buckets: [], sessions: [] };

  const entries = [];
  const sessionEvents = [];

  const candidates = [];
  for (const sessionsDir of roots) {
    const strict = strictRoots.has(sessionsDir);
    try {
      for (const session of listSessionDirs(sessionsDir, strict)) {
        candidates.push({ ...session, strict, configuredRoot: sessionsDir });
      }
    } catch {
      return {
        buckets: [], sessions: [], skipped: true,
        warnings: [`grok: 额外根目录读取失败，已保留上次同步数据: ${sessionsDir}`],
      };
    }
  }

  let sessionsToParse = candidates;
  if (roots.length > 1) {
    const selectedSessions = new Map();
    for (const session of candidates) {
      const fileSize = (name) => {
        try {
          return statSync(join(session.sessionPath, name)).size;
        } catch {
          return 0;
        }
      };
      const score = [fileSize('updates.jsonl'), fileSize('events.jsonl'), fileSize('summary.json')];
      const previous = selectedSessions.get(session.sessionId);
      const moreComplete = !previous || score.some((value, index) => (
        value !== previous.score[index] && value > previous.score[index]
        && score.slice(0, index).every((prior, priorIndex) => prior === previous.score[priorIndex])
      ));
      if (moreComplete) selectedSessions.set(session.sessionId, { ...session, score });
    }
    sessionsToParse = [...selectedSessions.values()];
  }

  for (const {
    sessionId,
    sessionPath,
    projectFallback,
    strict,
    configuredRoot,
  } of sessionsToParse) {
    try {
      const summaryPath = join(sessionPath, 'summary.json');
      let summary;
      if (strict && existsSync(summaryPath)) {
        summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
      } else {
        summary = readJsonSafe(summaryPath) || {};
      }
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
      }, strict);

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
        }, strict);
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
    } catch (err) {
      if (!strict) throw err;
      return {
        buckets: [], sessions: [], skipped: true,
        warnings: [`grok: 额外根目录读取失败，已保留上次同步数据: ${configuredRoot}`],
      };
    }
  }

  return {
    buckets: aggregateToBuckets(entries),
    sessions: extractSessions(sessionEvents),
  };
}
