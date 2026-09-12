import { realpathSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

const EXTENSION_ID = 'saoudrizwan.claude-dev';
const HOSTS = ['Code', 'Cursor', 'Windsurf', 'VSCodium', 'Code - Insiders', 'Trae', 'Trae CN'];

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

/** Both legacy stores and the shared Cline 3.x CLI/extension SDK store. */
export function findClineStores({ onWarning = () => {} } = {}) {
  function isPath(path, directory = false) {
    try {
      const stat = statSync(path);
      return directory ? stat.isDirectory() : stat.isFile();
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
        onWarning(`cline: 无法读取数据目录 ${path}: ${err.message}`);
      }
      return false;
    }
  }
  function unique(paths) {
    const seen = new Set();
    return paths.filter(path => {
      let key;
      try { key = realpathSync(path); } catch { key = path; }
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  const override = process.env.VIBE_USAGE_CLINE_DIRS?.trim();
  const home = join(homedir(), '.cline');
  const configuredHome = process.env.CLINE_DIR?.trim() || home;
  const dataDir = process.env.CLINE_DATA_DIR?.trim() || join(configuredHome, 'data');
  const roots = override
    ? override.split(delimiter).map(value => value.trim()).filter(Boolean)
    : [home, configuredHome, dataDir,
        ...hostRoots().map(root => join(root, 'User', 'globalStorage', EXTENSION_ID))];
  // Accept either a Cline home or its data directory. Keep the old standalone
  // and editor stores so upgrading the runtime does not discard old history.
  const dataRoots = unique(roots.flatMap(root => [root, join(root, 'data')]));
  const legacyRoots = dataRoots.filter(root => isPath(join(root, 'state', 'taskHistory.json')));
  const sessionDirs = override
    ? dataRoots.map(root => join(root, 'sessions'))
    : [...dataRoots.map(root => join(root, 'sessions')),
        process.env.CLINE_SESSION_DATA_DIR?.trim()].filter(Boolean);
  const sdkSessionDirs = unique(sessionDirs).filter(dir => isPath(dir, true));
  return { legacyRoots: unique(legacyRoots), sdkSessionDirs };
}

export function findClineDataDirs() {
  const { legacyRoots, sdkSessionDirs } = findClineStores();
  return [...legacyRoots, ...sdkSessionDirs];
}
