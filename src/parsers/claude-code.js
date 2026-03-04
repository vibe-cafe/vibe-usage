import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename, sep } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets } from './index.js';

/**
 * Stateless Claude Code parser.
 * Reads ALL *.jsonl files under ~/.claude/projects/ and extracts per-message
 * token usage from assistant messages. No state file needed — every sync
 * computes the full bucket totals from raw data, making server-side
 * ON CONFLICT ... DO UPDATE SET idempotent.
 */

const CLAUDE_DIR = join(homedir(), '.claude', 'projects');

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
  // Get relative path from the projects dir
  const projectsPrefix = CLAUDE_DIR + sep;
  if (!filePath.startsWith(projectsPrefix)) return 'unknown';
  const relative = filePath.slice(projectsPrefix.length);
  // First segment is the encoded project path
  const firstSeg = relative.split(sep)[0];
  if (!firstSeg) return 'unknown';
  // The encoded path uses dashes: -Users-kalasoo-Projects-myproject
  // Take the last segment after splitting by dash
  const parts = firstSeg.split('-').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : 'unknown';
}

export async function parse() {
  if (!existsSync(CLAUDE_DIR)) return [];

  const files = findJsonlFiles(CLAUDE_DIR);
  if (files.length === 0) return [];

  const entries = [];
  const seenUuids = new Set();

  for (const filePath of files) {
    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const project = extractProject(filePath);

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);

        // Only process assistant messages with usage data
        if (obj.type !== 'assistant') continue;
        const msg = obj.message;
        if (!msg || !msg.usage) continue;

        const usage = msg.usage;
        if (usage.input_tokens == null && usage.output_tokens == null) continue;

        // Deduplicate by UUID across all files
        const uuid = obj.uuid;
        if (uuid) {
          if (seenUuids.has(uuid)) continue;
          seenUuids.add(uuid);
        }

        const timestamp = obj.timestamp;
        if (!timestamp) continue;
        const ts = new Date(timestamp);
        if (isNaN(ts.getTime())) continue;

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

  return aggregateToBuckets(entries);
}
