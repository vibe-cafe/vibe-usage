import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

const EXTENSION_ID = 'saoudrizwan.claude-dev';
const HOSTS = ['Code', 'Cursor', 'Windsurf', 'VSCodium', 'Code - Insiders', 'Trae', 'Trae CN'];

function hasTaskHistory(root) {
  try {
    return statSync(join(root, 'state', 'taskHistory.json')).isFile();
  } catch {
    return false;
  }
}

function hostRoots() {
  const out = [];
  if (process.platform === 'darwin') {
    const base = join(homedir(), 'Library', 'Application Support');
    for (const host of HOSTS) out.push(join(base, host));
  } else if (process.platform === 'win32') {
    const base = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
    for (const host of HOSTS) out.push(join(base, host));
  } else {
    const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
    for (const host of HOSTS) out.push(join(base, host));
  }
  return out;
}

export function findClineDataDirs() {
  const override = process.env.VIBE_USAGE_CLINE_DIRS?.trim();
  const candidates = override
    ? override.split(delimiter).map((value) => value.trim()).filter(Boolean)
    : [
        join(homedir(), '.cline'),
        ...hostRoots().map((root) => join(root, 'User', 'globalStorage', EXTENSION_ID)),
      ];
  return [...new Set(candidates)].filter(hasTaskHistory);
}
