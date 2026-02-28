import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const TOOLS = [
  {
    name: 'Claude Code',
    id: 'claude-code',
    dataDir: join(homedir(), '.claude', 'projects'),
  },
  {
    name: 'Codex CLI',
    id: 'codex',
    dataDir: join(homedir(), '.codex', 'sessions'),
  },
  {
    name: 'Gemini CLI',
    id: 'gemini-cli',
    dataDir: join(homedir(), '.gemini', 'tmp'),
  },
  {
    name: 'OpenCode',
    id: 'opencode',
    dataDir: join(homedir(), '.local', 'share', 'opencode'),
  },
  {
    name: 'OpenClaw',
    id: 'openclaw',
    dataDir: join(homedir(), '.openclaw', 'agents'),
  },
];

export function detectInstalledTools() {
  return TOOLS.filter(t => existsSync(t.dataDir));
}
