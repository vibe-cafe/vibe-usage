import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, resolve, win32 } from 'node:path';
import { homedir } from 'node:os';
import { findClaudeCodeDataDirs } from './claude-roots.js';
import { codexSessionDirs, resolveCodexHomes } from './codex-roots.js';
import { findClineDataDirs } from './cline-roots.js';
import { findCraftDataDirs } from './craft-roots.js';
import { findOmpDataDirs, findPiDataDirs } from './pi-roots.js';
import { findWorkbuddyDataDirs } from './workbuddy-roots.js';

export function getAlmaDbPath(env = process.env, platform = process.platform, home = homedir()) {
  const pathImpl = platform === 'win32' ? win32 : posix;
  const override = env.VIBE_USAGE_ALMA_DB?.trim();
  if (override) {
    return platform === process.platform ? resolve(override) : pathImpl.resolve(override);
  }
  if (platform === 'darwin') {
    return pathImpl.join(home, 'Library', 'Application Support', 'alma', 'chat_threads.db');
  }
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim() || pathImpl.join(home, 'AppData', 'Roaming');
    return pathImpl.join(appData, 'alma', 'chat_threads.db');
  }
  const configHome = env.XDG_CONFIG_HOME?.trim() || pathImpl.join(home, '.config');
  return pathImpl.join(configHome, 'alma', 'chat_threads.db');
}

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

// Codex keeps live sessions in ~/.codex/sessions and moves completed ones to
// ~/.codex/archived_sessions. Detect Codex if either dir exists, so a user
// whose sessions have all been archived is still recognized.
export function findCodexDataDirs(codexExtraHome) {
  return resolveCodexHomes(codexExtraHome)
    .flatMap(codexSessionDirs)
    .filter(existsSync);
}

// Kimi Code moved its store from ~/.kimi to ~/.kimi-code; recognize either so
// users on either version are detected. The parser prefers ~/.kimi-code.
function findKimiCodeDataDirs() {
  return [
    join(homedir(), '.kimi-code', 'sessions'),
    join(homedir(), '.kimi', 'sessions'),
  ].filter(existsSync);
}

/** DeepSeek Harness home: DSH_HOME env (same as the dsh CLI) or ~/.dsh. */
export function getDshHome(env = process.env) {
  const explicit = env.DSH_HOME?.trim();
  if (explicit) {
    if (explicit === '~') return homedir();
    const backslash = String.fromCharCode(92);
    if (explicit.startsWith('~/') || explicit.startsWith('~' + backslash)) {
      return join(homedir(), explicit.slice(2));
    }
    return explicit;
  }
  return join(homedir(), '.dsh');
}

export function getDshSessionsDir() {
  const testDir = process.env.VIBE_USAGE_DSH_SESSIONS?.trim();
  if (testDir) return testDir;
  return join(getDshHome(), 'sessions');
}

// Detect DeepSeek Harness when its sessions tree exists (or the test override).
export function findDshDataDirs() {
  return [getDshSessionsDir()].filter(existsSync);
}

export function getMimocodeDbPath(env = process.env) {
  if (env.MIMOCODE_HOME && !isAbsolute(env.MIMOCODE_HOME)) {
    throw new Error(`MIMOCODE_HOME must be an absolute path, got: ${JSON.stringify(env.MIMOCODE_HOME)}`);
  }
  const dataDir = env.MIMOCODE_HOME
    ? join(env.MIMOCODE_HOME, 'data')
    : join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'mimocode');
  if (!env.MIMOCODE_DB) return join(dataDir, 'mimocode.db');
  return isAbsolute(env.MIMOCODE_DB) ? env.MIMOCODE_DB : join(dataDir, env.MIMOCODE_DB);
}

function findAntigravityDataDirs() {
  return [
    join(homedir(), '.gemini', 'antigravity'),
    join(homedir(), '.gemini', 'antigravity-cli'),
  ].filter(existsSync);
}

export function findTraeCliDataDirs() {
  const envDir = process.env.VIBE_USAGE_TRAE_CLI_SESSIONS?.trim();
  if (envDir) {
    return [envDir].filter(existsSync);
  }
  if (process.platform === 'darwin') {
    return [join(homedir(), 'Library', 'Caches', 'trae-cli', 'sessions')].filter(existsSync);
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local');
    return [join(localAppData, 'trae-cli', 'cache', 'sessions')].filter(existsSync);
  }
  const xdgCacheHome = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache');
  return [join(xdgCacheHome, 'trae-cli', 'sessions')].filter(existsSync);
}

/** Grok home: GROK_HOME env (same as the Grok CLI) or ~/.grok. */
export function getGrokHome() {
  const envHome = process.env.GROK_HOME?.trim();
  if (envHome) {
    return envHome.startsWith('~') ? join(homedir(), envHome.slice(1)) : envHome;
  }
  return join(homedir(), '.grok');
}

export function getGrokSessionsDir() {
  const testDir = process.env.VIBE_USAGE_GROK_SESSIONS?.trim();
  if (testDir) return testDir;
  return join(getGrokHome(), 'sessions');
}

// Detect Grok when sessions/ exists under GROK_HOME (or the test override).
export function findGrokDataDirs() {
  const testDir = process.env.VIBE_USAGE_GROK_SESSIONS?.trim();
  if (testDir) return [testDir].filter(existsSync);
  return [join(getGrokHome(), 'sessions')].filter(existsSync);
}

export function getDimAgentDbPath() {
  const override = process.env.VIBE_USAGE_DIMAGENT_DB?.trim();
  if (override) return resolve(override);

  const explicitHome = process.env.DIMCODE_HOME?.trim();
  if (explicitHome) return join(resolve(explicitHome), 'dimcode.sqlite');

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  const home = xdgConfigHome
    ? resolve(xdgConfigHome, '.dimcode', 'v2')
    : join(homedir(), '.dimcode', 'v2');
  return join(home, 'dimcode.sqlite');
}

export function findDimAgentDataDirs() {
  return [getDimAgentDbPath()].filter(existsSync);
}

export const TOOLS = [
  {
    name: 'Alma',
    id: 'alma',
    dataDir: getAlmaDbPath(),
    detectDataDirs: () => [getAlmaDbPath()].filter(existsSync),
  },
  {
    name: 'Claude Code',
    id: 'claude-code',
    dataDir: join(homedir(), '.claude', 'projects'),
    detectDataDirs: findClaudeCodeDataDirs,
  },
  {
    name: 'Codex CLI',
    id: 'codex',
    dataDir: join(homedir(), '.codex', 'sessions'),
    detectDataDirs: ({ codexExtraHome } = {}) => findCodexDataDirs(codexExtraHome),
  },
  {
    name: 'Grok',
    id: 'grok',
    dataDir: join(homedir(), '.grok', 'sessions'),
    detectDataDirs: findGrokDataDirs,
  },
  {
    name: 'GitHub Copilot CLI',
    id: 'copilot-cli',
    dataDir: join(homedir(), '.copilot', 'session-state'),
  },
  {
    name: 'CraftAgent',
    id: 'craft-agent',
    dataDir: join(homedir(), '.craft-agent', 'workspaces'),
    detectDataDirs: findCraftDataDirs,
  },
  {
    name: 'Cursor',
    id: 'cursor',
    dataDir: getCursorStateDbPath(),
  },
  {
    name: 'DimAgent',
    id: 'dimagent',
    dataDir: getDimAgentDbPath(),
    detectDataDirs: findDimAgentDataDirs,
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
    name: 'Oh My Pi',
    id: 'omp',
    dataDir: join(homedir(), '.omp', 'agent', 'sessions'),
    detectDataDirs: findOmpDataDirs,
  },
  {
    name: 'pi',
    id: 'pi-coding-agent',
    dataDir: join(homedir(), '.pi', 'agent', 'sessions'),
    detectDataDirs: findPiDataDirs,
  },
  {
    name: 'Qwen Code',
    id: 'qwen-code',
    dataDir: join(homedir(), '.qwen', 'tmp'),
  },
  {
    name: 'Kimi Code',
    id: 'kimi-code',
    // Current layout is ~/.kimi-code/sessions; ~/.kimi/sessions is the legacy
    // path. The parser reads whichever exists (preferring ~/.kimi-code).
    dataDir: join(homedir(), '.kimi-code', 'sessions'),
    detectDataDirs: findKimiCodeDataDirs,
  },
  {
    name: 'MiMoCode',
    id: 'mimocode',
    dataDir: join(homedir(), '.local', 'share', 'mimocode', 'mimocode.db'),
    detectDataDirs: () => [getMimocodeDbPath()].filter(existsSync),
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
    name: 'DeepSeek Harness',
    id: 'dsh',
    dataDir: join(homedir(), '.dsh', 'sessions'),
    detectDataDirs: findDshDataDirs,
  },
  {
    name: 'Antigravity',
    id: 'antigravity',
    dataDir: join(homedir(), '.gemini', 'antigravity'),
    detectDataDirs: findAntigravityDataDirs,
  },
  {
    name: 'Trae CLI',
    id: 'trae-cli',
    dataDir: join(homedir(), 'Library', 'Caches', 'trae-cli', 'sessions'),
    detectDataDirs: findTraeCliDataDirs,
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
    name: 'Cline',
    id: 'cline',
    dataDir: join(homedir(), '.cline'),
    detectDataDirs: findClineDataDirs,
  },
  {
    name: 'Roo Code',
    id: 'roo-code',
    dataDir: join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline'),
    detectDataDirs: findRooCodeDataDirs,
  },
  {
    name: 'WorkBuddy',
    id: 'workbuddy',
    dataDir: join(homedir(), '.workbuddy-ai', 'projects'),
    detectDataDirs: () => findWorkbuddyDataDirs().filter(existsSync),
  },
  {
    name: 'ZCode',
    id: 'zcode',
    dataDir: join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite'),
  },
];

export function detectInstalledTools(options = {}) {
  return TOOLS.filter(t => {
    if (t.detectDataDirs) return t.detectDataDirs(options).length > 0;
    return existsSync(t.dataDir);
  });
}
