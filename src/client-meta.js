import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
);

export const SURFACES = new Set(['cli', 'daemon', 'mac-app', 'windows-app']);

export const COLLECTOR_VERSION = String(pkg.version);

function cleanEnv(value, maxLength = 50) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().slice(0, maxLength);
  return cleaned || null;
}

/** Who started this run: a desktop app's VIBE_USAGE_SURFACE wins over the caller's default. */
export function resolveSurface(defaultSurface = 'cli') {
  const requestedSurface = cleanEnv(process.env.VIBE_USAGE_SURFACE, 30);
  return requestedSurface && SURFACES.has(requestedSurface)
    ? requestedSurface
    : defaultSurface;
}

export function createSyncClient({ defaultSurface = 'cli', hostname } = {}) {
  const surface = resolveSurface(defaultSurface);
  const runtime = process.versions.bun ? 'bun' : 'node';
  const runtimeVersion = process.versions.bun || process.versions.node;

  return {
    collectorVersion: COLLECTOR_VERSION,
    surface,
    surfaceVersion: cleanEnv(process.env.VIBE_USAGE_SURFACE_VERSION) || COLLECTOR_VERSION,
    runtime,
    runtimeVersion,
    platform: process.platform,
    hostname: cleanEnv(hostname, 200) || 'unknown',
    syncId: randomUUID(),
  };
}

export function forBatch(client, batchIndex, batchCount) {
  return {
    ...client,
    batchIndex,
    batchCount,
  };
}
