import { closeSync, lstatSync, openSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export const KILO_DB_NAME = 'kilo.db';
const pathsFor = platform => platform === 'win32' ? win32 : posix;

function normalizeRoot(value, home, platform) {
  const paths = pathsFor(platform);
  if (value === '~') return home;
  if (/^~[\\/]/.test(value)) return paths.join(home, value.slice(2));
  return paths.resolve(value);
}

export function isAbsoluteKiloPath(value, platform = process.platform) {
  return typeof value === 'string' && pathsFor(platform).isAbsolute(value);
}

// Kilo CLI and Desktop's embedded server use the same XDG data directory on
// every platform. Like xdg-basedir, ignore a relative XDG_DATA_HOME.
export function resolveKiloDataRoot(env = process.env, home = homedir(), platform = process.platform) {
  const paths = pathsFor(platform);
  const xdg = env.XDG_DATA_HOME?.replace(/[\r\n]+/g, '');
  return paths.join(xdg && paths.isAbsolute(xdg) ? xdg : paths.join(home, '.local', 'share'), 'kilo');
}

export function resolveKiloDbPath(env = process.env, home = homedir(), platform = process.platform) {
  const paths = pathsFor(platform);
  const configured = env.KILO_DB?.trim();
  if (configured === ':memory:') return null;
  if (configured && paths.isAbsolute(configured)) return configured;
  return paths.join(resolveKiloDataRoot(env, home, platform), configured || KILO_DB_NAME);
}

// Fixture/relocation overrides replace discovery, so tests never open a real
// user's store. Each entry is a database file or its containing directory.
export function resolveKiloStoreCandidates(env = process.env, home = homedir(), platform = process.platform) {
  const override = env.VIBE_USAGE_KILO_DIRS?.trim();
  if (override) {
    return {
      explicit: true,
      directoryRoots: true,
      unsupported: null,
      candidates: override.split(pathsFor(platform).delimiter).map(p => p.trim()).filter(Boolean)
        .map(p => normalizeRoot(p, home, platform)),
    };
  }
  const path = resolveKiloDbPath(env, home, platform);
  return {
    explicit: Boolean(env.KILO_DB?.trim()),
    directoryRoots: false,
    unsupported: path === null ? ':memory:' : null,
    candidates: path === null ? [] : [path],
  };
}

export function findKiloDbs({ env = process.env, home = homedir(), platform = process.platform, onWarning = () => {} } = {}) {
  const { candidates, explicit, directoryRoots, unsupported } = resolveKiloStoreCandidates(env, home, platform);
  if (unsupported) {
    onWarning('Kilo: KILO_DB=:memory: 无法从另一进程读取，已跳过');
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    try {
      const stat = statSync(candidate);
      if (stat.isDirectory() && !directoryRoots) throw new Error('数据库路径是目录而不是文件');
      const path = stat.isDirectory() ? pathsFor(platform).join(candidate, KILO_DB_NAME) : candidate;
      if (!statSync(path).isFile()) throw new Error('数据库路径不是文件');
      // Windows accessSync(R_OK) does not enforce NTFS ReadData ACLs. A
      // read-only open checks actual permission without reading any payload.
      closeSync(openSync(path, 'r'));
      const canonical = realpathSync(path);
      if (!seen.has(canonical)) {
        seen.add(canonical);
        result.push(canonical);
      }
    } catch (err) {
      if (!explicit && err.code === 'ENOENT') {
        // A dangling database symlink is a broken discovered store. Only a
        // genuinely absent default means that Kilo has not written data yet.
        try { lstatSync(candidate); } catch (probe) {
          if (probe.code === 'ENOENT') continue;
        }
      }
      onWarning(`Kilo: 无法读取数据库 ${candidate}: ${err.message}`);
    }
  }
  return result;
}
