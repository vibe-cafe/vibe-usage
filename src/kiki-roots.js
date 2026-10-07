import { existsSync, realpathSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { homedir } from 'node:os';
import { resolveKimiCodeRoots } from './kimi-roots.js';

// Kiki is a separate tool, even when it uses a Kimi model/provider.
export const KIKI_SOURCE_ID = 'kiki';

export function resolveKikiRoots(env = process.env, platform = process.platform, home = homedir()) {
  const pathImpl = platform === 'win32' ? win32 : posix;
  return [env.VIBE_USAGE_KIKI_DIR?.trim() || env.KIKI_HOME?.trim() || pathImpl.join(home, '.kiki')];
}

// Never collect the same physical home under both tool identities.
export function independentKikiRoots(excludeRoots = [], roots = resolveKikiRoots()) {
  const identity = path => {
    try { return realpathSync(path); } catch { return path; }
  };
  const seen = new Set(excludeRoots.map(identity));
  return roots.filter(root => {
    const key = identity(root);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function findKikiDataDirs() {
  return independentKikiRoots(resolveKimiCodeRoots()).map(root => join(root, 'sessions')).filter(existsSync);
}
