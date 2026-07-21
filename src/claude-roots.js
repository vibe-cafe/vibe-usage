import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

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

/**
 * Return every Claude Code state root visible from this process.
 *
 * In addition to the default and CLAUDE_CONFIG_DIR, discover the documented
 * multi-profile convention (~/.claude-work, ~/.claude-personal, ...). This is
 * important for launchd/systemd and GUI processes, which commonly do not
 * inherit the shell environment used to launch Claude Code.
 *
 * VIBE_USAGE_CLAUDE_DIRS is a test/diagnostic override. It replaces discovery
 * with a path.delimiter-separated root list.
 */
export function getClaudeRoots() {
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
