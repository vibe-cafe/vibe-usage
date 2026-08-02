import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function getCraftWorkspacesDir() {
  const root = process.env.CRAFT_AGENT_DIR?.trim()
    || process.env.CRAFTAGENT_DIR?.trim()
    || join(homedir(), '.craft-agent');
  return join(root, 'workspaces');
}

export function findCraftDataDirs() {
  const workspaces = getCraftWorkspacesDir();
  return existsSync(workspaces) ? [workspaces] : [];
}
