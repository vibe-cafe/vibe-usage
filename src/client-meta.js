import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
);

const SURFACES = new Set(['cli', 'daemon', 'mac-app', 'windows-app']);

export const COLLECTOR_VERSION = String(pkg.version);

function cleanEnv(value, maxLength = 50) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().slice(0, maxLength);
  return cleaned || null;
}

export function createSyncClient({ defaultSurface = 'cli', hostname } = {}) {
  const requestedSurface = cleanEnv(process.env.VIBE_USAGE_SURFACE, 30);
  const surface = requestedSurface && SURFACES.has(requestedSurface)
    ? requestedSurface
    : defaultSurface;
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
