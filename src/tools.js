import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function getCursorStateDbPath() {
  const rel = join('User', 'globalStorage', 'state.vscdb');
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Cursor', rel);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Cursor', rel);
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(xdgConfigHome, 'Cursor', rel);
}

function getKiroAgentPath() {
  const rel = join('User', 'globalStorage', 'kiro.kiroagent');
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Kiro', rel);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Kiro', rel);
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(xdgConfigHome, 'Kiro', rel);
}

// VSCode-fork host directories where extensions like Cline / Roo Code live.
const VSCODE_HOSTS = ['Code', 'Cursor', 'Windsurf', 'VSCodium', 'Code - Insiders', 'Trae', 'Trae CN'];

function getVscodeHostRoots() {
  const out = [];
  if (process.platform === 'darwin') {
    const base = join(homedir(), 'Library', 'Application Support');
    for (const h of VSCODE_HOSTS) out.push(join(base, h));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
    for (const h of VSCODE_HOSTS) out.push(join(appData, h));
  } else {
    const xdg = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
    for (const h of VSCODE_HOSTS) out.push(join(xdg, h));
  }
  return out;
}

function findExtensionDirs(extensionId) {
  const dirs = [];
  for (const root of getVscodeHostRoots()) {
    const ext = join(root, 'User', 'globalStorage', extensionId);
    try {
      if (statSync(ext).isDirectory()) dirs.push(ext);
    } catch {
      // not present in this host
    }
  }
  return dirs;
}

const findClineDataDirs = () => findExtensionDirs('saoudrizwan.claude-dev');
const findRooCodeDataDirs = () => findExtensionDirs('rooveterinaryinc.roo-cline');

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

// Claude Code lives in ~/.claude/projects, but $CLAUDE_CONFIG_DIR relocates its
// whole tree. Detect either so a user who only set CLAUDE_CONFIG_DIR is still
// recognized (the parser scans both roots; see parsers/claude-code.js).
function findClaudeCodeDataDirs() {
  const dirs = [join(homedir(), '.claude', 'projects')];
  const cfg = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (cfg) {
    let custom = cfg.startsWith('~') ? join(homedir(), cfg.slice(1)) : cfg;
    custom = custom.replace(/[/\\]+$/, '') || custom;
    dirs.push(join(custom, 'projects'));
  }
  return dirs.filter(existsSync);
}

// Codex keeps live sessions in ~/.codex/sessions and moves completed ones to
// ~/.codex/archived_sessions. Detect Codex if either dir exists, so a user
// whose sessions have all been archived is still recognized.
function findCodexDataDirs() {
  return [
    join(homedir(), '.codex', 'sessions'),
    join(homedir(), '.codex', 'archived_sessions'),
  ].filter(existsSync);
}

// TRAE IDE (VS Code fork by ByteDance) stores AI chat sessions under
// workspaceStorage/<ws>/chatSessions/*.jsonl and globalStorage/emptyWindowChatSessions/*.jsonl
function findTraeChatSessionDirs() {
  const hosts = ['Trae CN', 'Trae', 'TRAE SOLO CN'];
  const dirs = [];
  if (process.platform === 'darwin') {
    const base = join(homedir(), 'Library', 'Application Support');
    for (const h of hosts) {
      const wsDir = join(base, h, 'User', 'workspaceStorage');
      if (existsSync(wsDir)) dirs.push(wsDir);
      const ewDir = join(base, h, 'User', 'globalStorage', 'emptyWindowChatSessions');
      if (existsSync(ewDir)) dirs.push(ewDir);
    }
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
    for (const h of hosts) {
      const wsDir = join(appData, h, 'User', 'workspaceStorage');
      if (existsSync(wsDir)) dirs.push(wsDir);
      const ewDir = join(appData, h, 'User', 'globalStorage', 'emptyWindowChatSessions');
      if (existsSync(ewDir)) dirs.push(ewDir);
    }
  } else {
    const xdg = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
    for (const h of hosts) {
      const wsDir = join(xdg, h, 'User', 'workspaceStorage');
      if (existsSync(wsDir)) dirs.push(wsDir);
      const ewDir = join(xdg, h, 'User', 'globalStorage', 'emptyWindowChatSessions');
      if (existsSync(ewDir)) dirs.push(ewDir);
    }
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
    detectDataDirs: findClaudeCodeDataDirs,
  },
  {
    name: 'Cline',
    id: 'cline',
    dataDir: join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev'),
    detectDataDirs: findClineDataDirs,
  },
  {
    name: 'Codex CLI',
    id: 'codex',
    dataDir: join(homedir(), '.codex', 'sessions'),
    detectDataDirs: findCodexDataDirs,
  },
  {
    name: 'GitHub Copilot CLI',
    id: 'copilot-cli',
    dataDir: join(homedir(), '.copilot', 'session-state'),
  },
  {
    name: 'Cursor',
    id: 'cursor',
    dataDir: getCursorStateDbPath(),
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
  {
    name: 'Hermes',
    id: 'hermes',
    dataDir: join(homedir(), '.hermes', 'state.db'),
  },
  {
    name: 'Kiro',
    id: 'kiro',
    dataDir: getKiroAgentPath(),
  },
  {
    name: 'Roo Code',
    id: 'roo-code',
    dataDir: join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline'),
    detectDataDirs: findRooCodeDataDirs,
  },
  {
    name: 'ZCode',
    id: 'zcode',
    dataDir: join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite'),
  },
  {
    name: 'TRAE',
    id: 'trae',
    dataDir: join(homedir(), 'Library', 'Application Support', 'Trae CN', 'User', 'workspaceStorage'),
    detectDataDirs: findTraeChatSessionDirs,
  },
];

export function detectInstalledTools() {
  return TOOLS.filter(t => {
    if (t.detectDataDirs) return t.detectDataDirs().length > 0;
    return existsSync(t.dataDir);
  });
}
