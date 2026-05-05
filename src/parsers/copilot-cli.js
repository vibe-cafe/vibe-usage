import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './index.js';

const SESSION_STATE_DIR = join(homedir(), '.copilot', 'session-state');

function findEventFiles(baseDir) {
  const results = [];
  if (!existsSync(baseDir)) return results;

  try {
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const eventsFile = join(baseDir, entry.name, 'events.jsonl');
      if (existsSync(eventsFile)) {
        results.push({ filePath: eventsFile, sessionId: entry.name });
      }
    }
  } catch {
    return results;
  }

  return results;
}

function getProjectFromContext(context) {
  const projectPath = context?.gitRoot || context?.cwd;
  if (!projectPath) return 'unknown';

  return basename(projectPath) || 'unknown';
}

/**
 * Parse GitHub Copilot CLI session logs from ~/.copilot/session-state.
 * Returns usage buckets from session shutdown summaries and session metadata
 * from user/assistant message timings.
 */
export async function parse() {
  const eventFiles = findEventFiles(SESSION_STATE_DIR);
  if (eventFiles.length === 0) return { buckets: [], sessions: [] };

  const entries = [];
  const sessionEvents = [];

  for (const { filePath, sessionId } of eventFiles) {
    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    let currentProject = 'unknown';

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;

      try {
        const obj = JSON.parse(line);
        const timestamp = obj.timestamp ? new Date(obj.timestamp) : null;
        const hasTimestamp = timestamp && !isNaN(timestamp.getTime());

        if (obj.type === 'session.start' || obj.type === 'session.resume') {
          currentProject = getProjectFromContext(obj.data?.context);
        }

        if (hasTimestamp && obj.type === 'user.message') {
          sessionEvents.push({
            sessionId,
            source: 'copilot-cli',
            project: currentProject,
            timestamp,
            role: 'user',
          });
        }

        if (hasTimestamp && obj.type === 'assistant.message') {
          sessionEvents.push({
            sessionId,
            source: 'copilot-cli',
            project: currentProject,
            timestamp,
            role: 'assistant',
          });
        }

        if (obj.type !== 'session.shutdown' || !hasTimestamp) continue;

        const modelMetrics = obj.data?.modelMetrics || {};
        for (const [model, metrics] of Object.entries(modelMetrics)) {
          const usage = metrics?.usage;
          if (!usage) continue;

          const totalInput = usage.inputTokens || 0;
          const cachedRead = usage.cacheReadTokens || 0;
          const cacheWrite = usage.cacheWriteTokens || 0;
          const output = usage.outputTokens || 0;

          if (totalInput === 0 && cachedRead === 0 && cacheWrite === 0 && output === 0) {
            continue;
          }

          entries.push({
            source: 'copilot-cli',
            model,
            project: currentProject,
            timestamp,
            inputTokens: Math.max(0, totalInput - cachedRead - cacheWrite),
            outputTokens: output,
            cachedInputTokens: cachedRead,
            cacheCreationInputTokens: cacheWrite,
            reasoningOutputTokens: 0,
          });
        }
      } catch {
        continue;
      }
    }
  }

  return {
    buckets: aggregateToBuckets(entries),
    sessions: extractSessions(sessionEvents),
  };
}
