import { join } from 'node:path';
import { homedir } from 'node:os';
import { parsePiSessionJsonl } from './pi-session-jsonl.js';

/**
 * CraftAgent parser.
 * Reads assistant usage from CraftAgent's per-session Pi-compatible JSONL logs.
 *
 * Session file layout:
 *   ~/.craft-agent/workspaces/<workspace>/sessions/<session>/.pi-sessions/*.jsonl
 *
 * Assistant messages carry per-message token usage:
 *   message.usage = { input, output, cacheRead, cacheWrite, totalTokens, cost }
 *
 * The current bucket schema tracks tokens only. Cost is intentionally ignored here
 * until the shared ingest model grows a cost field.
 */

function getSessionsRoot() {
  const envDir = process.env.CRAFT_AGENT_DIR || process.env.CRAFTAGENT_DIR;
  if (envDir) return join(envDir, 'workspaces');
  return join(homedir(), '.craft-agent', 'workspaces');
}

function isPiSessionFile(filePath) {
  return filePath.split(/[\\/]/).includes('.pi-sessions');
}

function projectFromCraftPath(filePath) {
  const parts = filePath.replace(/\\/g, '/').split('/');
  const sessionsIndex = parts.lastIndexOf('sessions');
  if (sessionsIndex > 0 && parts[sessionsIndex - 1]) return parts[sessionsIndex - 1];
  return 'unknown';
}

export async function parse() {
  const sessionsDir = getSessionsRoot();
  return parsePiSessionJsonl({
    source: 'craft-agent',
    sessionsDir,
    includeFile: isPiSessionFile,
    projectFromPath: projectFromCraftPath,
  });
}
