import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename, sep } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './index.js';

/**
 * Stateless Claude Code parser.
 * Reads ALL *.jsonl files under ~/.claude/projects/ and extracts per-message
 * token usage from assistant messages. No state file needed — every sync
 * computes the full bucket totals from raw data, making server-side
 * ON CONFLICT ... DO UPDATE SET idempotent.
 */

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const CLAUDE_TRANSCRIPTS_DIR = join(homedir(), '.claude', 'transcripts');

/**
 * Recursively find all .jsonl files under a directory.
 * Claude Code stores sessions in two layouts:
 *   2-layer: projects/{projectPath}/{sessionId}.jsonl
 *   3-layer: projects/{projectPath}/{sessionId}/subagents/agent-*.jsonl
 */
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

/**
 * Extract project name from file path.
 * Path format: ~/.claude/projects/{encodedProjectPath}/{sessionId}.jsonl
 * The encodedProjectPath uses dashes for separators (e.g. -Users-foo-myproject).
 * We extract the last path segment as the project name.
 */
function extractProject(filePath) {
  const projectsPrefix = CLAUDE_PROJECTS_DIR + sep;
  if (!filePath.startsWith(projectsPrefix)) return 'unknown';
  const relative = filePath.slice(projectsPrefix.length);
  const firstSeg = relative.split(sep)[0];
  if (!firstSeg) return 'unknown';
  const parts = firstSeg.split('-').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : 'unknown';
}

function extractSessionId(filePath) {
  return basename(filePath, '.jsonl');
}

export async function parse() {
  const entries = [];
  const sessionEvents = [];
  const seenUuids = new Set();
  const seenSessionIds = new Set();

  // --- projects/ directory: extract BOTH token buckets AND session events ---
  const projectFiles = findJsonlFiles(CLAUDE_PROJECTS_DIR);

  for (const filePath of projectFiles) {
    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const project = extractProject(filePath);
    const sessionId = extractSessionId(filePath);
    seenSessionIds.add(sessionId);

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);

        const timestamp = obj.timestamp;
        if (!timestamp) continue;
        const ts = new Date(timestamp);
        if (isNaN(ts.getTime())) continue;

        if (obj.type === 'user' || obj.type === 'assistant' || obj.type === 'tool_use' || obj.type === 'tool_result') {
          sessionEvents.push({
            sessionId,
            source: 'claude-code',
            project,
            timestamp: ts,
            role: obj.type === 'user' ? 'user' : 'assistant',
          });
        }

        if (obj.type !== 'assistant') continue;
        const msg = obj.message;
        if (!msg || !msg.usage) continue;

        const usage = msg.usage;
        if (usage.input_tokens == null && usage.output_tokens == null) continue;

        const uuid = obj.uuid;
        if (uuid) {
          if (seenUuids.has(uuid)) continue;
          seenUuids.add(uuid);
        }

        entries.push({
          source: 'claude-code',
          model: msg.model || 'unknown',
          project,
          timestamp: ts,
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cachedInputTokens: usage.cache_read_input_tokens || 0,
          reasoningOutputTokens: 0,
        });
      } catch {
        continue;
      }
    }
  }

  // --- transcripts/ directory: extract session events ONLY (no token data) ---
  const transcriptFiles = findJsonlFiles(CLAUDE_TRANSCRIPTS_DIR);

  for (const filePath of transcriptFiles) {
    const sessionId = extractSessionId(filePath);
    if (seenSessionIds.has(sessionId)) continue;

    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);

        const timestamp = obj.timestamp;
        if (!timestamp) continue;
        const ts = new Date(timestamp);
        if (isNaN(ts.getTime())) continue;

        if (obj.type === 'user' || obj.type === 'assistant' || obj.type === 'tool_use' || obj.type === 'tool_result') {
          sessionEvents.push({
            sessionId,
            source: 'claude-code',
            project: 'unknown',
            timestamp: ts,
            role: obj.type === 'user' ? 'user' : 'assistant',
          });
        }
      } catch {
        continue;
      }
    }
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(sessionEvents) };
}
