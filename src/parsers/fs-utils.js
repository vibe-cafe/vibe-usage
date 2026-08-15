import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

// Small shared filesystem/parsing helpers used across parsers. Keeping them in
// one place removes the same ~10-line functions copied into every parser.

/** Read and parse a JSON file, returning null on any failure. */
export function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/** Last path component (project name), or 'unknown'. */
export function projectFromPath(absPath) {
  if (!absPath || typeof absPath !== 'string') return 'unknown';
  const trimmed = absPath.replace(/[\\/]+$/, '');
  const name = basename(trimmed);
  return name || 'unknown';
}

/** Last path component of a cwd value (works for both Unix and Windows paths). */
export function projectFromCwd(cwd, fallback = 'unknown') {
  if (typeof cwd !== 'string') return fallback;
  const trimmed = cwd.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return fallback;
  return trimmed.split(/[\\/]/).filter(Boolean).at(-1) || fallback;
}

/** Coerce a token count to a finite positive number, else 0. */
export function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
