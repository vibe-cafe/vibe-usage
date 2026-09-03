import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { piSessionsDir } from './extra-roots.js';

function expandHome(value) {
  const trimmed = value.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function uniqueExistingDirs(paths) {
  return [...new Set(paths.map(expandHome))].filter(existsSync);
}

function profileSessionDirs(profilesRoot, includesAgentDir) {
  const dirs = [];
  let profiles;
  try {
    profiles = readdirSync(profilesRoot, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const profile of profiles) {
    if (!profile.isDirectory()) continue;
    dirs.push(join(
      profilesRoot,
      profile.name,
      ...(includesAgentDir ? ['agent', 'sessions'] : ['sessions']),
    ));
  }
  return dirs;
}

export function looksLikeOmpAgentDir(agentDir) {
  const normalized = agentDir.replace(/\\/g, '/');
  return normalized.includes('/.omp/')
    || existsSync(join(agentDir, 'config.yml'))
    || existsSync(join(agentDir, 'agent.db'));
}

// Pi resolves a session directory from `--session-dir`, then
// PI_CODING_AGENT_SESSION_DIR, then `sessionDir` in settings.json. Only the
// last two are discoverable after the fact, and both name the sessions
// directory itself (no `sessions` segment is appended).
function settingsSessionDir(agentDir) {
  try {
    const raw = readFileSync(join(agentDir, 'settings.json'), 'utf-8');
    const value = JSON.parse(raw)?.sessionDir;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    // Pi also accepts project-relative values. Those resolve against a cwd we
    // do not have here, so only absolute and ~-anchored paths are scanned.
    if (!trimmed || !(isAbsolute(trimmed) || trimmed.startsWith('~'))) return null;
    return expandHome(trimmed);
  } catch {
    return null;
  }
}

export function getPiSessionDirs(extraRoots = []) {
  // Explicitly configured roots are user intent, not a fixture: they are always
  // scanned, and they never replace the default store. A root whose shape no
  // longer resolves drops out here; the parser reports that as skipped.
  const extraDirs = extraRoots.map(piSessionsDir).filter(dir => dir !== null);

  const override = process.env.VIBE_USAGE_PI_SESSION_DIRS?.trim();
  if (override) return uniqueExistingDirs([...override.split(delimiter), ...extraDirs]);

  const envAgentDir = process.env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = envAgentDir ? expandHome(envAgentDir) : join(homedir(), '.pi', 'agent');
  // OMP inherits PI_CODING_AGENT_DIR from Pi. Do not parse an identifiable
  // OMP store again as source=pi-coding-agent.
  const isOmpStore = Boolean(envAgentDir) && looksLikeOmpAgentDir(agentDir);

  const dirs = [];
  if (!isOmpStore) {
    dirs.push(join(agentDir, 'sessions'));
    const envSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
    if (envSessionDir) dirs.push(expandHome(envSessionDir));
    const configured = settingsSessionDir(agentDir);
    if (configured) dirs.push(configured);
  }
  return uniqueExistingDirs([...dirs, ...extraDirs]);
}

export function getOmpSessionDirs() {
  const override = process.env.VIBE_USAGE_OMP_SESSION_DIRS?.trim();
  if (override) return uniqueExistingDirs(override.split(delimiter));

  const dirs = [];
  const configName = process.env.PI_CONFIG_DIR?.trim() || '.omp';
  const configRoot = join(homedir(), configName);
  dirs.push(join(configRoot, 'agent', 'sessions'));
  for (const dir of profileSessionDirs(join(configRoot, 'profiles'), true)) {
    dirs.push(dir);
  }

  const agentOverride = process.env.PI_CODING_AGENT_DIR?.trim();
  if (agentOverride) {
    const expanded = expandHome(agentOverride);
    if (looksLikeOmpAgentDir(expanded)) dirs.push(join(expanded, 'sessions'));
  }

  // OMP's XDG migration flattens the agent/ segment:
  // ~/.omp/agent/sessions -> $XDG_DATA_HOME/omp/sessions.
  if (process.platform === 'linux' || process.platform === 'darwin') {
    const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
    if (xdgDataHome) {
      const xdgRoot = join(expandHome(xdgDataHome), 'omp');
      dirs.push(join(xdgRoot, 'sessions'));
      for (const dir of profileSessionDirs(join(xdgRoot, 'profiles'), false)) {
        dirs.push(dir);
      }
    }
  }

  return uniqueExistingDirs(dirs);
}

export const findPiDataDirs = getPiSessionDirs;
export const findOmpDataDirs = getOmpSessionDirs;
