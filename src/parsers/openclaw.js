import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './index.js';

// OpenClaw stores data at ~/.openclaw/agents/<agentId>/sessions/*.jsonl
// Profile deployments use ~/.openclaw-<profile>/agents/...
// Legacy paths: ~/.clawdbot, ~/.moltbot, ~/.moldbot
function getPossibleRoots() {
  const home = homedir();
  const roots = [
    join(home, '.clawdbot'),
    join(home, '.moltbot'),
    join(home, '.moldbot'),
  ];
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.openclaw' || /^\.openclaw-.+/.test(entry.name)) {
        roots.push(join(home, entry.name));
      }
    }
  } catch {
    // ignore read errors
  }
  return roots;
}

/** Normalize usage fields — OpenClaw supports multiple naming conventions */
function getTokens(usage, ...keys) {
  for (const key of keys) {
    if (usage[key] != null && usage[key] > 0) return usage[key];
  }
  return 0;
}

export async function parse() {
  const entries = [];
  const sessionEvents = [];

  for (const root of getPossibleRoots()) {
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) continue;

    let agentDirs;
    try {
      agentDirs = readdirSync(agentsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());
    } catch {
      continue;
    }

    for (const agentDir of agentDirs) {
      const project = agentDir.name;
      const sessionsDir = join(agentsDir, agentDir.name, 'sessions');
      if (!existsSync(sessionsDir)) continue;

      let files;
      try {
        files = readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = join(sessionsDir, file);

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

            if (obj.type !== 'message') continue;
            const msg = obj.message;
            if (!msg) continue;

            const timestamp = obj.timestamp || msg.timestamp;
            if (!timestamp) continue;
            const ts = new Date(typeof timestamp === 'number' ? timestamp : timestamp);
            if (isNaN(ts.getTime())) continue;

            sessionEvents.push({
              sessionId: filePath,
              source: 'openclaw',
              project,
              timestamp: ts,
              role: msg.role === 'user' ? 'user' : 'assistant',
            });

            if (msg.role !== 'assistant') continue;
            const usage = msg.usage;
            if (!usage) continue;

            entries.push({
              source: 'openclaw',
              model: msg.model || obj.model || 'unknown',
              project,
              timestamp: ts,
              inputTokens: getTokens(usage, 'input', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens'),
              outputTokens: getTokens(usage, 'output', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens'),
              cachedInputTokens: getTokens(usage, 'cacheRead', 'cache_read', 'cache_read_input_tokens'),
              reasoningOutputTokens: 0,
            });
          } catch {
            continue;
          }
        }
      }
    }
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(sessionEvents) };
}
