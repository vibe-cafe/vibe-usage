import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

export function getDefaultWorkbuddyProjectsDir() {
  return join(homedir(), '.workbuddy', 'projects');
}

// Fixture/relocation hook. Entries may name either the WorkBuddy home or its
// projects/ directory; the parser normalizes both forms.
export function findWorkbuddyDataDirs() {
  const override = process.env.VIBE_USAGE_WORKBUDDY_DIRS?.trim();
  if (!override) return [getDefaultWorkbuddyProjectsDir()];
  return [...new Set(
    override
      .split(delimiter)
      .map(entry => entry.trim())
      .filter(Boolean)
  )];
}
