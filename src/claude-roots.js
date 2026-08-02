import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

const MAX_DESKTOP_DISCOVERY_DEPTH = 8;
const DESKTOP_NON_SESSION_DIRS = new Set(['rpm', 'skills']);

function expandHome(value) {
  const trimmed = value.trim().replace(/[/\\]+$/, '');
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function hasClaudeData(root) {
  return existsSync(join(root, 'projects')) || existsSync(join(root, 'transcripts'));
}

function defaultClaudeDesktopDataDir() {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim();
    return appData
      ? join(expandHome(appData), 'Claude')
      : join(homedir(), 'AppData', 'Roaming', 'Claude');
  }
  const configHome = process.env.XDG_CONFIG_HOME?.trim();
  return join(configHome ? expandHome(configHome) : join(homedir(), '.config'), 'Claude');
}

function getClaudeDesktopDataDirs() {
  const override = process.env.VIBE_USAGE_CLAUDE_DESKTOP_DIRS?.trim();
  return override
    ? override.split(delimiter).map(expandHome).filter(Boolean)
    : [defaultClaudeDesktopDataDir()];
}

function discoverDesktopRoots(dir, depth, roots, onWarning) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      onWarning(`Claude Desktop: cannot read directory ${dir}: ${err.message}`);
    }
    return;
  }

  // Once a session root is found, do not descend into the user's Cowork files.
  // Those directories can be large and are unrelated to Claude's transcript.
  const claudeEntry = entries.find(
    (entry) => entry.name === '.claude' && entry.isDirectory(),
  );
  if (claudeEntry) {
    roots.push(join(dir, claudeEntry.name));
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (DESKTOP_NON_SESSION_DIRS.has(entry.name)) continue;
    const candidate = join(dir, entry.name);
    if (depth < MAX_DESKTOP_DISCOVERY_DEPTH) {
      discoverDesktopRoots(candidate, depth + 1, roots, onWarning);
    }
  }
}

/**
 * Find the private Claude Code state roots created for Claude Desktop Cowork.
 * Desktop Code itself uses the normal ~/.claude root, while Cowork isolates
 * each local-agent session below the Electron user-data directory.
 */
export function findClaudeDesktopRoots(
  desktopDataDirs = getClaudeDesktopDataDirs(),
  onWarning = () => {},
) {
  const roots = [];
  for (const dataDir of desktopDataDirs) {
    discoverDesktopRoots(
      join(dataDir, 'local-agent-mode-sessions'),
      0,
      roots,
      onWarning,
    );
  }
  return roots;
}

/**
 * Return every Claude Code-compatible state root visible from this process.
 *
 * In addition to the default and CLAUDE_CONFIG_DIR, discover the documented
 * multi-profile convention (~/.claude-work, ~/.claude-personal, ...). This is
 * important for launchd/systemd and GUI processes, which commonly do not
 * inherit the shell environment used to launch Claude Code.
 *
 * Claude Desktop Code uses the default Claude Code root. Cowork creates a
 * private .claude root per local-agent session, so those roots are discovered
 * recursively under the app's user-data directory.
 *
 * VIBE_USAGE_CLAUDE_DIRS is a test/diagnostic override. It replaces all normal
 * and Desktop discovery with a path.delimiter-separated root list.
 */
export function getClaudeRoots({ onWarning = () => {} } = {}) {
  const override = process.env.VIBE_USAGE_CLAUDE_DIRS?.trim();
  const roots = override
    ? override.split(delimiter).map(expandHome).filter(Boolean)
    : [join(homedir(), '.claude')];

  if (!override) {
    const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
    if (configured) roots.push(expandHome(configured));

    try {
      for (const entry of readdirSync(homedir(), { withFileTypes: true })) {
        // Profiles are sometimes symlinked, so let hasClaudeData() follow the
        // entry instead of requiring Dirent.isDirectory() here.
        if (!/^\.claude-.+/.test(entry.name)) continue;
        const candidate = join(homedir(), entry.name);
        if (hasClaudeData(candidate)) roots.push(candidate);
      }
    } catch {
      // The default/configured roots remain usable if home discovery fails.
    }

    roots.push(...findClaudeDesktopRoots(getClaudeDesktopDataDirs(), onWarning));
  }

  const seen = new Set();
  const unique = [];
  for (const root of roots) {
    let canonical = root;
    try {
      canonical = realpathSync(root);
    } catch {
      // Keep a missing explicit/default root so callers can report it normally.
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    unique.push(root);
  }
  return unique;
}

export function findClaudeCodeDataDirs() {
  const dirs = [];
  for (const root of getClaudeRoots()) {
    for (const name of ['projects', 'transcripts']) {
      const candidate = join(root, name);
      try {
        if (statSync(candidate).isDirectory()) dirs.push(candidate);
      } catch {
        // Missing or unreadable roots are handled by the parser.
      }
    }
  }
  return dirs;
}
