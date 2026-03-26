import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const TOOLS = [
  {
    name: 'Antigravity',
    id: 'antigravity',
    dataDir: join(homedir(), '.gemini', 'antigravity'),
  },
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
    name: 'GitHub Copilot CLI',
    id: 'copilot-cli',
    dataDir: join(homedir(), '.copilot', 'session-state'),
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
  {
    name: 'pi',
    id: 'pi-coding-agent',
    dataDir: join(homedir(), '.pi', 'agent', 'sessions'),
  },
  {
    name: 'Qwen Code',
    id: 'qwen-code',
    dataDir: join(homedir(), '.qwen', 'tmp'),
  },
  {
    name: 'Kimi Code',
    id: 'kimi-code',
    dataDir: join(homedir(), '.kimi', 'sessions'),
  },
  {
    name: 'Amp',
    id: 'amp',
    dataDir: join(homedir(), '.local', 'share', 'amp', 'threads'),
  },
  {
    name: 'Droid',
    id: 'droid',
    dataDir: join(homedir(), '.factory', 'sessions'),
  },
];

export function detectInstalledTools() {
  return TOOLS.filter(t => existsSync(t.dataDir));
}
