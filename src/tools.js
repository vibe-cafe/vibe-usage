import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Find all OpenClaw data roots: ~/.openclaw and ~/.openclaw-<profile> */
function findOpenclawDataDirs() {
  const home = homedir();
  const dirs = [];
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.openclaw' || /^\.openclaw-.+/.test(entry.name)) {
        const agentsDir = join(home, entry.name, 'agents');
        if (existsSync(agentsDir)) dirs.push(agentsDir);
      }
    }
  } catch {
    // ignore read errors
  }
  return dirs;
}

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
    detectDataDirs: findOpenclawDataDirs,
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
  return TOOLS.filter(t => {
    if (t.detectDataDirs) return t.detectDataDirs().length > 0;
    return existsSync(t.dataDir);
  });
}
