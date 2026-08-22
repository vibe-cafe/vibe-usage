import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, join, posix, resolve, win32 } from 'node:path';
import { homedir } from 'node:os';

function unique(values) {
  return [...new Set(values)];
}

/**
 * Cindy keeps Mainland China and Global installs in separate Electron user-data
 * roots. Scan both because the two editions can be installed side by side.
 */
export function getCindyDataRoots(
  env = process.env,
  platform = process.platform,
  home = homedir(),
) {
  const override = env.VIBE_USAGE_CINDY_DIRS?.trim();
  if (override) {
    return unique(
      override
        .split(delimiter)
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => resolve(value)),
    );
  }

  const pathImpl = platform === 'win32' ? win32 : posix;
  let base;
  if (platform === 'darwin') {
    base = pathImpl.join(home, 'Library', 'Application Support');
  } else if (platform === 'win32') {
    base = env.APPDATA?.trim() || pathImpl.join(home, 'AppData', 'Roaming');
  } else {
    base = env.XDG_CONFIG_HOME?.trim() || pathImpl.join(home, '.config');
  }
  return [pathImpl.join(base, 'CindyGlobal'), pathImpl.join(base, 'Cindy')];
}

function canonicalPath(value) {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

/** Find every active per-owner `cindy-<owner>.db` database. */
export function findCindyDbPaths(options = {}) {
  const roots = getCindyDataRoots(options.env, options.platform, options.home);
  const paths = [];

  for (const root of roots) {
    let stat;
    try {
      stat = statSync(root);
    } catch {
      continue;
    }

    if (stat.isFile()) {
      if (root.endsWith('.db')) paths.push(canonicalPath(root));
      continue;
    }
    if (!stat.isDirectory()) continue;

    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^cindy-.+\.db$/.test(entry.name)) continue;
      paths.push(canonicalPath(join(root, entry.name)));
    }
  }

  return unique(paths).sort();
}

export function findCindyDataDirs(options = {}) {
  return unique(findCindyDbPaths(options).map(dirname)).filter(existsSync);
}
