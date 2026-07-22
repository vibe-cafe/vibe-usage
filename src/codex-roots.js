import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function normalizeHomePath(value) {
  const trimmed = value.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

export function primaryCodexHome() {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? normalizeHomePath(configured) : join(homedir(), '.codex');
}

export function resolveCodexHomes(extraCodexHome) {
  const roots = [primaryCodexHome()];
  if (extraCodexHome?.trim()) roots.push(normalizeHomePath(extraCodexHome));
  return [...new Set(roots)];
}

export function codexSessionDirs(codexHome) {
  return [
    join(codexHome, 'sessions'),
    join(codexHome, 'archived_sessions'),
  ];
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function validateExtraCodexHome(value) {
  const path = normalizeHomePath(value);
  return {
    ok: isDirectory(path) && codexSessionDirs(path).some(isDirectory),
    path,
  };
}
