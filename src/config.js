import { readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { moveDirectoryOutOfFilePath } from './path-repair.js';
import { migrateConfigApiUrl } from './api-url.js';

// VIBE_USAGE_CONFIG_DIR overrides the dir (test hook).
const CONFIG_DIR = process.env.VIBE_USAGE_CONFIG_DIR?.trim() || join(homedir(), '.vibe-usage');
const isDev = process.env.VIBE_USAGE_DEV === '1';
const CONFIG_FILE = join(CONFIG_DIR, isDev ? 'config.dev.json' : 'config.json');

export function getConfigPath() {
  return CONFIG_FILE;
}

export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return null;
  let config;
  try {
    config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return null;
  }
  // 2026-11-24 domain move (see api-url.js): every command talks to the new
  // host. Only in memory here — `doctor` and the other readers must not write;
  // `sync` persists it through persistApiUrlMigration().
  if (!isDev) migrateConfigApiUrl(config);
  return config;
}

/**
 * Write the domain move to config.json so the desktop apps, which read the
 * file for their dashboard, follow without an app update. Re-reads the file
 * right before writing and patches only the URL fields, so a key or setting a
 * desktop app saved a moment ago is kept; the replace is atomic, so a crash
 * cannot leave a half-written key file.
 */
export function persistApiUrlMigration() {
  if (isDev || !existsSync(CONFIG_FILE)) return false;
  let current;
  try {
    current = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return false;
  }
  if (!migrateConfigApiUrl(current)) return false;
  const tempPath = `${CONFIG_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(current, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    renameSync(tempPath, CONFIG_FILE);
  } catch (err) {
    try { rmSync(tempPath, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  try { chmodSync(CONFIG_FILE, 0o600); } catch { /* rename kept the temp file's 0600 */ }
  return true;
}

export function saveConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  // A directory sitting where the config file belongs would make this write
  // throw EISDIR forever; move it aside so the run can save.
  moveDirectoryOutOfFilePath(CONFIG_FILE);
  // The file holds the vbu_ API key — never leave it group/world-readable.
  // mode only applies at file creation, so chmod explicitly for pre-existing
  // files written before this hardening.
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  try {
    chmodSync(CONFIG_FILE, 0o600);
  } catch (err) {
    // Windows permission models vary; on POSIX, do not silently leave an API
    // key file broader than owner-only if hardening a pre-existing file fails.
    if (process.platform !== 'win32') throw err;
  }
}
