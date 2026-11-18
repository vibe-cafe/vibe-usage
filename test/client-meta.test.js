import test from 'node:test';
import assert from 'node:assert/strict';
import { COLLECTOR_VERSION, createSyncClient, forBatch } from '../src/client-meta.js';

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('direct CLI metadata reports the actual package version', () => {
  withEnv({ VIBE_USAGE_SURFACE: null, VIBE_USAGE_SURFACE_VERSION: null }, () => {
    const client = createSyncClient({ hostname: 'workstation' });
    assert.equal(client.collectorVersion, COLLECTOR_VERSION);
    assert.equal(client.surface, 'cli');
    assert.equal(client.surfaceVersion, COLLECTOR_VERSION);
    assert.equal(client.hostname, 'workstation');
    assert.match(client.syncId, /^[0-9a-f-]{36}$/);
  });
});

test('app identity overrides the default CLI surface', () => {
  withEnv({
    VIBE_USAGE_SURFACE: 'mac-app',
    VIBE_USAGE_SURFACE_VERSION: '0.5.5',
  }, () => {
    const client = createSyncClient({ defaultSurface: 'daemon', hostname: 'mac' });
    assert.equal(client.surface, 'mac-app');
    assert.equal(client.surfaceVersion, '0.5.5');
  });
});

test('unknown app identity cannot inject an arbitrary surface', () => {
  withEnv({ VIBE_USAGE_SURFACE: 'anything' }, () => {
    const client = createSyncClient({ defaultSurface: 'daemon', hostname: 'host' });
    assert.equal(client.surface, 'daemon');
  });
});

test('batch metadata keeps one sync id across all requests', () => {
  const client = createSyncClient({ hostname: 'host' });
  const first = forBatch(client, 0, 2);
  const second = forBatch(client, 1, 2);
  assert.equal(first.syncId, second.syncId);
  assert.deepEqual([first.batchIndex, first.batchCount], [0, 2]);
  assert.deepEqual([second.batchIndex, second.batchCount], [1, 2]);
});

test('the Codex Ultrafast cut is declared only when the sync knows it', () => {
  assert.equal('codexUltrafastStartAt' in createSyncClient({ hostname: 'host' }), false);
  assert.equal(createSyncClient({ hostname: 'host', codexUltrafastStartAt: null }).codexUltrafastStartAt, null);
  const declared = createSyncClient({ hostname: 'host', codexUltrafastStartAt: '2026-11-10T10:30:00.000Z' });
  assert.equal(declared.codexUltrafastStartAt, '2026-11-10T10:30:00.000Z');
  assert.equal(forBatch(declared, 1, 3).codexUltrafastStartAt, '2026-11-10T10:30:00.000Z');
});
