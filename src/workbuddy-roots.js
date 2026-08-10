import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * WorkBuddy (~/.workbuddy) is a local-only AI coding tool. It stores per-project
 * session history as line-delimited JSON files under
 *   $WORKBUDDY_HOME/projects/<project>/<session>.jsonl
 * where $WORKBUDDY_HOME defaults to ~/.workbuddy.
 *
 * Test/relocation hook: set VIBE_USAGE_WORKBUDDY_DIRS to a path.delimiter-separated
 * list of roots. When unset, only the default ~/.workbuddy is scanned — the
 * user's actual machine state must never be silently absorbed from extra
 * locations.
 */

export function getWorkbuddyHome() {
  return join(homedir(), '.workbuddy');
}

export function getDefaultWorkbuddyProjectsDir() {
  return join(getWorkbuddyHome(), 'projects');
}

/**
 * Return every WorkBuddy data root visible to this process. Each entry is a
 * `projects` directory (or the configured root itself when the override names
 * the projects directory directly). Empty / non-existent roots are filtered
 * out so callers can iterate without extra checks.
 */
export function findWorkbuddyDataDirs() {
  const override = process.env.VIBE_USAGE_WORKBUDDY_DIRS?.trim();
  if (override) {
    return override
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  const fallback = getDefaultWorkbuddyProjectsDir();
  return [fallback];
}
