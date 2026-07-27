import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './index.js';

/**
 * oh-my-pi (omp) parser.
 * Reads JSONL session files from ~/.omp/agent/sessions/ (or $OMP_AGENT_DIR/sessions/).
 *
 * omp is a fork of pi, so the session format is identical:
 *   sessions/<encoded-cwd>/{timestamp}_{sessionId}.jsonl
 *
 * A companion directory sharing the .jsonl basename may sit next to each
 * session file (holding *.bash.log etc.) — it is ignored; only *.jsonl is parsed.
 *
 * Each JSONL line is a session entry:
 *   - type "session": header with id, cwd, version
 *   - type "message": contains message object with role, usage, model, timestamp
 *   - type "model_change", "mode_change", "custom", etc.: metadata (ignored for usage)
 *
 * Assistant messages carry per-message token usage:
 *   message.usage = { input, output, cacheRead, cacheWrite, totalTokens,
 *                       reasoningTokens? }   // reasoningTokens: newer omp builds
 */

function getSessionsDir() {
  const envDir = process.env.OMP_AGENT_DIR;
  if (envDir) return join(envDir, 'sessions');
  return join(homedir(), '.omp', 'agent', 'sessions');
}

function findJsonlFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findJsonlFiles(fullPath));
      } else if (entry.name.endsWith('.jsonl')) {
        results.push(fullPath);
      }
    }
  } catch {
    // ignore unreadable directories
  }
  return results;
}

function extractProjectFromCwd(cwd) {
  if (!cwd) return 'unknown';
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : 'unknown';
}

function extractProjectFromDir(filePath, sessionsDir) {
  const relative = filePath.slice(sessionsDir.length + 1);
  const firstSeg = relative.split('/')[0] || relative.split('\\')[0];
  if (!firstSeg) return 'unknown';
  const parts = firstSeg.split('-').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : 'unknown';
}

export async function parse() {
  const sessionsDir = getSessionsDir();
  const entries = [];
  const sessionEvents = [];
  const seenEntryIds = new Set();

  const sessionFiles = findJsonlFiles(sessionsDir);

  for (const filePath of sessionFiles) {
    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    let sessionId = basename(filePath, '.jsonl');
    let project = extractProjectFromDir(filePath, sessionsDir);

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;

      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (obj.type === 'session') {
        if (obj.id) sessionId = obj.id;
        if (obj.cwd) project = extractProjectFromCwd(obj.cwd);
        continue;
      }

      if (obj.type !== 'message') continue;

      const msg = obj.message;
      if (!msg) continue;

      let ts;
      if (obj.timestamp) {
        ts = new Date(obj.timestamp);
      } else if (msg.timestamp) {
        ts = new Date(msg.timestamp);
      }
      if (!ts || isNaN(ts.getTime())) continue;

      if (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'toolResult') {
        sessionEvents.push({
          sessionId,
          source: 'omp',
          project,
          timestamp: ts,
          role: msg.role === 'user' ? 'user' : 'assistant',
        });
      }

      if (msg.role !== 'assistant') continue;
      if (!msg.usage) continue;

      const usage = msg.usage;
      if (usage.input == null && usage.output == null) continue;

      const entryId = obj.id;
      if (entryId) {
        if (seenEntryIds.has(entryId)) continue;
        seenEntryIds.add(entryId);
      }

      entries.push({
        source: 'omp',
        model: msg.model || 'unknown',
        project,
        timestamp: ts,
        inputTokens: usage.input || 0,
        outputTokens: usage.output || 0,
        cachedInputTokens: usage.cacheRead || 0,
        reasoningOutputTokens: usage.reasoningTokens || 0,
      });
    }
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(sessionEvents) };
}
