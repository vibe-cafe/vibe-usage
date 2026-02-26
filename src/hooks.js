import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const SYNC_CMD = 'npx @vibe-cafe/vibe-usage sync 2>/dev/null &';

/**
 * Check if a SessionEnd hook array (new or old format) already contains a vibe-usage hook.
 */
function hasVibeUsageHook(hooks) {
  if (!Array.isArray(hooks)) return false;
  return hooks.some(entry => {
    // New format: { matcher?: "...", hooks: [{ type, command }] }
    if (Array.isArray(entry.hooks)) {
      return entry.hooks.some(h => h.command && h.command.includes('vibe-usage'));
    }
    // Old format: { type, command } directly
    if (entry.command && entry.command.includes('vibe-usage')) return true;
    return false;
  });
}

/**
 * Migrate old-format hook entries to the new matcher format.
 * Old: [{ type: "command", command: "..." }]
 * New: [{ hooks: [{ type: "command", command: "..." }] }]
 */
function migrateOldFormatHooks(hooks) {
  if (!Array.isArray(hooks)) return hooks;
  return hooks.map(entry => {
    // Already new format (has "hooks" array)
    if (Array.isArray(entry.hooks)) return entry;
    // Old format: bare handler → wrap in matcher group
    if (entry.type && entry.command) {
      return { hooks: [entry] };
    }
    return entry;
  });
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

  // Migrate any old-format hooks first
  settings.hooks.SessionEnd = migrateOldFormatHooks(settings.hooks.SessionEnd);

  if (hasVibeUsageHook(settings.hooks.SessionEnd)) {
    // Update the command in existing hook to use latest
    for (const group of settings.hooks.SessionEnd) {
      if (Array.isArray(group.hooks)) {
        for (const h of group.hooks) {
          if (h.command && h.command.includes('vibe-usage')) {
            h.command = SYNC_CMD;
          }
        }
      }
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    return { injected: false, reason: 'already installed (updated)' };
  }

  // New format: matcher group with hooks array
  settings.hooks.SessionEnd.push({
    hooks: [{ type: 'command', command: SYNC_CMD }],
  });
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
    // Fix broken [notify] → [[notify]] from previous versions
    content = content.replace(/^\[notify\]$/gm, '[[notify]]');
    // Update existing command to use latest
    content = content.replace(
      /npx @vibe-cafe\/vibe-usage(?:@[\d.]+)? sync[^"']*/g,
      SYNC_CMD,
    );
    writeFileSync(configPath, content, 'utf-8');
    return { injected: false, reason: 'already installed (updated)' };
  }

  const notifySection = `\n[[notify]]\ncommand = "${SYNC_CMD}"\n`;
  const notifyIdx = content.indexOf('[[notify]]');
  if (notifyIdx !== -1) {
    const nextSection = content.indexOf('\n[', notifyIdx + 1);
    const sectionEnd = nextSection === -1 ? content.length : nextSection;
    content = content.slice(0, notifyIdx) + `[[notify]]\ncommand = "${SYNC_CMD}"` + content.slice(sectionEnd);
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

  // Gemini CLI still uses the flat format (no matcher groups)
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
