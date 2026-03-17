import { createHash } from 'node:crypto';
import { parse as parseClaudeCode } from './claude-code.js';
import { parse as parseCodex } from './codex.js';
import { parse as parseCopilotCli } from './copilot-cli.js';
import { parse as parseGeminiCli } from './gemini-cli.js';
import { parse as parseOpencode } from './opencode.js';
import { parse as parseOpenclaw } from './openclaw.js';
import { parse as parseQwenCode } from './qwen-code.js';
import { parse as parseKimiCode } from './kimi-code.js';

export const parsers = {
  'claude-code': parseClaudeCode,
  'codex': parseCodex,
  'copilot-cli': parseCopilotCli,
  'gemini-cli': parseGeminiCli,
  'opencode': parseOpencode,
  'openclaw': parseOpenclaw,
  'qwen-code': parseQwenCode,
  'kimi-code': parseKimiCode,
};


export function roundToHalfHour(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() < 30 ? 0 : 30, 0, 0);
  return d;
}

export function aggregateToBuckets(entries) {
  const map = new Map();

  for (const e of entries) {
    const bucketStart = roundToHalfHour(e.timestamp).toISOString();
    const key = `${e.source}|${e.model}|${e.project}|${bucketStart}`;

    if (!map.has(key)) {
      map.set(key, {
        source: e.source,
        model: e.model,
        project: e.project,
        bucketStart,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      });
    }

    const b = map.get(key);
    b.inputTokens += e.inputTokens || 0;
    b.outputTokens += e.outputTokens || 0;
    b.cachedInputTokens += e.cachedInputTokens || 0;
    b.reasoningOutputTokens += e.reasoningOutputTokens || 0;
    b.totalTokens += (e.inputTokens || 0) + (e.outputTokens || 0) + (e.reasoningOutputTokens || 0);
  }

  return Array.from(map.values());
}

/**
 * Extract session metadata from timing events.
 * Each event: { sessionId, source, project, timestamp: Date, role: 'user'|'assistant' }
 *
 * Turn = first AI response → last AI response before next user prompt.
 * activeSeconds = sum(generation durations), excluding queue/TTFT wait.
 * durationSeconds = wall clock from first to last message.
 */
export function extractSessions(events) {
  const groups = new Map();
  for (const e of events) {
    if (!groups.has(e.sessionId)) groups.set(e.sessionId, []);
    groups.get(e.sessionId).push(e);
  }

  const sessions = [];
  for (const [sessionId, sessionEvents] of groups) {
    sessionEvents.sort((a, b) => a.timestamp - b.timestamp);

    const first = sessionEvents[0];
    const last = sessionEvents[sessionEvents.length - 1];
    const durationSeconds = Math.round((last.timestamp - first.timestamp) / 1000);

    let activeSeconds = 0;
    let turnStart = null;
    let turnEnd = null;
    let waitingForFirstResponse = false;

    for (const event of sessionEvents) {
      if (event.role === 'user') {
        if (turnStart !== null && turnEnd !== null && turnEnd > turnStart) {
          activeSeconds += Math.round((turnEnd - turnStart) / 1000);
        }
        turnStart = null;
        turnEnd = null;
        waitingForFirstResponse = true;
      } else if (waitingForFirstResponse) {
        turnStart = event.timestamp;
        turnEnd = event.timestamp;
        waitingForFirstResponse = false;
      } else if (turnStart !== null) {
        turnEnd = event.timestamp;
      }
    }
    if (turnStart !== null && turnEnd !== null && turnEnd > turnStart) {
      activeSeconds += Math.round((turnEnd - turnStart) / 1000);
    }

    const userPromptHours = new Array(24).fill(0);
    let userMessageCount = 0;
    for (const event of sessionEvents) {
      if (event.role === 'user') {
        userMessageCount++;
        userPromptHours[event.timestamp.getUTCHours()]++;
      }
    }

    const sessionHash = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);

    sessions.push({
      source: first.source,
      project: first.project || 'unknown',
      sessionHash,
      firstMessageAt: first.timestamp.toISOString(),
      lastMessageAt: last.timestamp.toISOString(),
      durationSeconds,
      activeSeconds,
      messageCount: sessionEvents.length,
      userMessageCount,
      userPromptHours,
    });
  }

  return sessions;
}
