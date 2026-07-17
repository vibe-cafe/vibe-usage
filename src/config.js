import { readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// VIBE_USAGE_CONFIG_DIR overrides the dir (test hook).
const CONFIG_DIR = process.env.VIBE_USAGE_CONFIG_DIR?.trim() || join(homedir(), '.vibe-usage');
const isDev = process.env.VIBE_USAGE_DEV === '1';
const CONFIG_FILE = join(CONFIG_DIR, isDev ? 'config.dev.json' : 'config.json');

export function getConfigPath() {
  return CONFIG_FILE;
}

export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
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
