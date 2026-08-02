import { existsSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

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

export function getPiSessionDirs() {
  const override = process.env.VIBE_USAGE_PI_SESSION_DIRS?.trim();
  if (override) return uniqueExistingDirs(override.split(delimiter));

  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (agentDir) {
    const expanded = expandHome(agentDir);
    // OMP inherits PI_CODING_AGENT_DIR from Pi. Do not parse an identifiable
    // OMP store again as source=pi-coding-agent.
    return looksLikeOmpAgentDir(expanded) ? [] : uniqueExistingDirs([join(expanded, 'sessions')]);
  }
  return uniqueExistingDirs([join(homedir(), '.pi', 'agent', 'sessions')]);
}

export function getOmpSessionDirs() {
  const override = process.env.VIBE_USAGE_OMP_SESSION_DIRS?.trim();
  if (override) return uniqueExistingDirs(override.split(delimiter));

  const dirs = [];
  const configName = process.env.PI_CONFIG_DIR?.trim() || '.omp';
  const configRoot = join(homedir(), configName);
  dirs.push(join(configRoot, 'agent', 'sessions'));
  dirs.push(...profileSessionDirs(join(configRoot, 'profiles'), true));

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
      dirs.push(...profileSessionDirs(join(xdgRoot, 'profiles'), false));
    }
  }

  return uniqueExistingDirs(dirs);
}

export const findPiDataDirs = getPiSessionDirs;
export const findOmpDataDirs = getOmpSessionDirs;
