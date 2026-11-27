import test from 'node:test';
import assert from 'node:assert/strict';
import { COLLECTOR_VERSION, createSyncClient, desktopAppOlderThan, forBatch } from '../src/client-meta.js';

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

test('upload batches carry only the current, recognized Mac interface style', () => {
  for (const style of ['modern', 'classic']) {
    withEnv({ VIBE_USAGE_SURFACE: 'mac-app', VIBE_USAGE_INTERFACE_STYLE: style }, () => {
      assert.equal(forBatch(createSyncClient(), 1, 2).interfaceStyle, style);
    });
  }
  for (const [surface, style] of [['mac-app', 'other'], ['mac-app', null], ['cli', 'modern']]) {
    withEnv({ VIBE_USAGE_SURFACE: surface, VIBE_USAGE_INTERFACE_STYLE: style }, () => {
      assert.equal(Object.hasOwn(forBatch(createSyncClient(), 1, 2), 'interfaceStyle'), false);
    });
  }
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

test('desktopAppOlderThan compares an app surface version against its minimum', () => {
  const minimums = { 'mac-app': '0.8.1', 'windows-app': '0.7.10' };
  const older = (surface, version) => desktopAppOlderThan(minimums, {
    ...(surface && { VIBE_USAGE_SURFACE: surface }),
    ...(version !== undefined && { VIBE_USAGE_SURFACE_VERSION: version }),
  });
  assert.equal(older('mac-app', '0.8.0'), true);
  assert.equal(older('mac-app', '0.7.9'), true);
  assert.equal(older('windows-app', '0.7.9'), true);
  assert.equal(older('windows-app', '0.5.12'), true);
  assert.equal(older('mac-app', '0.8.1'), false);
  assert.equal(older('mac-app', ' 0.9.0 '), false);
  assert.equal(older('windows-app', '0.7.10'), false);
  assert.equal(older('windows-app', '0.8.0'), false);
  assert.equal(older('windows-app', '1.0.0-beta.1'), false);
  // An app whose version cannot be read is treated as older.
  assert.equal(older('mac-app', undefined), true);
  assert.equal(older('windows-app', 'dev'), true);
  // Terminal, daemon and unknown surfaces are not apps with a minimum.
  assert.equal(older(undefined, undefined), false);
  assert.equal(older('cli', '0.0.1'), false);
  assert.equal(older('daemon', '0.0.1'), false);
  assert.equal(older('toString', '0.0.1'), false);
});
