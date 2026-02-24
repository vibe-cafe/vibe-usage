import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const SYNC_CMD = 'npx @vibe-cafe/vibe-usage sync 2>/dev/null &';

function hasVibeUsageHook(hooks) {
  if (!Array.isArray(hooks)) return false;
  return hooks.some(h => h.command && h.command.includes('vibe-usage'));
}

export function injectClaudeCode() {
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch { settings = {}; }
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true });
  }

  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.SessionEnd) settings.hooks.SessionEnd = [];

  if (hasVibeUsageHook(settings.hooks.SessionEnd)) {
    return { injected: false, reason: 'already installed' };
  }

  settings.hooks.SessionEnd.push({ type: 'command', command: SYNC_CMD });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  return { injected: true };
}

export function injectCodex() {
  const configPath = join(homedir(), '.codex', 'config.toml');
  let content = '';
  if (existsSync(configPath)) {
    content = readFileSync(configPath, 'utf-8');
  } else {
    mkdirSync(dirname(configPath), { recursive: true });
  }

  if (content.includes('vibe-usage')) {
    return { injected: false, reason: 'already installed' };
  }

  const notifySection = `\n[notify]\ncommand = "${SYNC_CMD}"\n`;
  const notifyIdx = content.indexOf('[notify]');
  if (notifyIdx !== -1) {
    const nextSection = content.indexOf('\n[', notifyIdx + 1);
    const sectionEnd = nextSection === -1 ? content.length : nextSection;
    content = content.slice(0, notifyIdx) + `[notify]\ncommand = "${SYNC_CMD}"` + content.slice(sectionEnd);
  } else {
    content += notifySection;
  }

  writeFileSync(configPath, content, 'utf-8');
  return { injected: true };
}

export function injectGeminiCli() {
  const settingsPath = join(homedir(), '.gemini', 'settings.json');
  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch { settings = {}; }
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true });
  }

  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.SessionEnd) settings.hooks.SessionEnd = [];

  if (hasVibeUsageHook(settings.hooks.SessionEnd)) {
    return { injected: false, reason: 'already installed' };
  }

  settings.hooks.SessionEnd.push({ type: 'command', command: SYNC_CMD });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  return { injected: true };
}

export const TOOLS = [
  {
    name: 'Claude Code',
    id: 'claude-code',
    dataDir: join(homedir(), '.claude', 'projects'),
    inject: injectClaudeCode,
  },
  {
    name: 'Codex CLI',
    id: 'codex',
    dataDir: join(homedir(), '.codex', 'sessions'),
    inject: injectCodex,
  },
  {
    name: 'Gemini CLI',
    id: 'gemini-cli',
    dataDir: join(homedir(), '.gemini', 'tmp'),
    inject: injectGeminiCli,
  },
  {
    name: 'OpenCode',
    id: 'opencode',
    dataDir: join(homedir(), '.local', 'share', 'opencode'),
    inject: null,
  },
  {
    name: 'OpenClaw',
    id: 'openclaw',
    dataDir: join(homedir(), '.openclaw', 'agents'),
    inject: null,
  },
];

export function detectInstalledTools() {
  return TOOLS.filter(t => existsSync(t.dataDir));
}
