import { readdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, basename, sep } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './index.js';

/**
 * Stateless Claude Code parser.
 * Reads ALL *.jsonl files under <root>/projects/ and extracts per-message
 * token usage from assistant messages. No state file needed — every sync
 * computes the full bucket totals from raw data, making server-side
 * ON CONFLICT ... DO UPDATE SET idempotent.
 *
 * Roots: always ~/.claude, plus $CLAUDE_CONFIG_DIR when set to a different
 * path. Claude Code itself relocates its whole tree (incl. projects/) to
 * $CLAUDE_CONFIG_DIR and uses only that dir — but a GUI launched from the
 * Dock may not inherit the shell's env, so usage can be split across both
 * roots. We scan both and dedup so neither source is missed or double-counted.
 */

/**
 * Resolve the set of Claude config roots to scan.
 * Always includes ~/.claude; adds $CLAUDE_CONFIG_DIR when set and it resolves
 * to a different real path. Deduped by canonical path.
 */
function getClaudeRoots() {
  const roots = [join(homedir(), '.claude')];

  const cfg = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (cfg) {
    let custom = cfg;
    if (custom.startsWith('~')) custom = join(homedir(), custom.slice(1));
    custom = custom.replace(/[/\\]+$/, '') || custom;
    roots.push(custom);
  }

  // Dedup by canonical path (realpath when the dir exists, else the raw string).
  const seen = new Set();
  const unique = [];
  for (const r of roots) {
    let key = r;
    try {
      key = realpathSync(r);
    } catch {
      // dir may not exist yet — fall back to the literal path
    }
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }
  return unique;
}

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
 * Path of a project file relative to its root's projects/ dir, e.g.
 * "<root>/projects/-Users-foo-app/abc.jsonl" → "-Users-foo-app/abc.jsonl".
 * Used both for project-name extraction and cross-root dedup.
 */
function projectRelativePath(filePath, projectsDir) {
  const prefix = projectsDir + sep;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : null;
}

/**
 * Extract project name from a projects-relative path.
 * The first segment is the dash-encoded project path (e.g. -Users-foo-myproject);
 * we take its last component as the project name.
 */
function extractProject(relative) {
  if (!relative) return 'unknown';
  const firstSeg = relative.split(sep)[0];
  if (!firstSeg) return 'unknown';
  const parts = firstSeg.split('-').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : 'unknown';
}

function extractSessionId(filePath) {
  return basename(filePath, '.jsonl');
}

/**
 * Scan one root's projects/ dir → token entries + session events (mutates ctx).
 */
function scanProjectsRoot(root, ctx) {
  const projectsDir = join(root, 'projects');

  for (const filePath of findJsonlFiles(projectsDir)) {
    const relative = projectRelativePath(filePath, projectsDir);
    // Same session present under two roots (e.g. data copied between them):
    // process it once so session message counts aren't inflated.
    if (relative !== null) {
      if (ctx.seenProjectFiles.has(relative)) continue;
      ctx.seenProjectFiles.add(relative);
    }

    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const project = extractProject(relative);
    const sessionId = extractSessionId(filePath);
    ctx.seenSessionIds.add(sessionId);

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);

        const timestamp = obj.timestamp;
        if (!timestamp) continue;
        const ts = new Date(timestamp);
        if (isNaN(ts.getTime())) continue;

        if (obj.type === 'user' || obj.type === 'assistant' || obj.type === 'tool_use' || obj.type === 'tool_result') {
          ctx.sessionEvents.push({
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
          if (ctx.seenUuids.has(uuid)) continue;
          ctx.seenUuids.add(uuid);
        }

        ctx.entries.push({
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
}

/**
 * Scan one root's transcripts/ dir → session events only (no token data).
 * Skips sessions already covered by a projects/ or transcripts/ scan.
 */
function scanTranscriptsRoot(root, ctx) {
  for (const filePath of findJsonlFiles(join(root, 'transcripts'))) {
    const sessionId = extractSessionId(filePath);
    if (ctx.seenSessionIds.has(sessionId)) continue;
    ctx.seenSessionIds.add(sessionId);

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
          ctx.sessionEvents.push({
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
}

export async function parse() {
  const ctx = {
    entries: [],
    sessionEvents: [],
    seenUuids: new Set(),
    seenSessionIds: new Set(),
    seenProjectFiles: new Set(), // projects-relative path → dedup same session across roots
  };

  const roots = getClaudeRoots();

  // projects/ yields BOTH token buckets and session events.
  for (const root of roots) scanProjectsRoot(root, ctx);
  // transcripts/ yields session events only, for sessions not already covered.
  for (const root of roots) scanTranscriptsRoot(root, ctx);

  return {
    buckets: aggregateToBuckets(ctx.entries),
    sessions: extractSessions(ctx.sessionEvents),
  };
}
