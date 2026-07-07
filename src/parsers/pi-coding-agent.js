import { join } from 'node:path';
import { homedir } from 'node:os';
import { extractProjectFromFirstDir, parsePiSessionJsonl } from './pi-session-jsonl.js';

/**
 * pi-coding-agent parser.
 * Reads JSONL session files from ~/.pi/agent/sessions/ (or $PI_CODING_AGENT_DIR/sessions/).
 *
 * Session file layout:
 *   sessions/<encoded-cwd>/{timestamp}_{sessionId}.jsonl
 *
 * Assistant messages carry per-message token usage:
 *   message.usage = { input, output, cacheRead, cacheWrite, totalTokens }
 */

function getSessionsDir() {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) return join(envDir, 'sessions');
  return join(homedir(), '.pi', 'agent', 'sessions');
}

export async function parse() {
  const sessionsDir = getSessionsDir();
  return parsePiSessionJsonl({
    source: 'pi-coding-agent',
    sessionsDir,
    projectFromPath: extractProjectFromFirstDir,
  });
}
