import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_API_URL, currentApiUrl, isLegacyApiUrl, migrateConfigApiUrl, sameApiServer,
} from '../src/api-url.js';

function probe(source, env) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('the old production name maps to the new host; custom servers stay as written', () => {
  assert.equal(DEFAULT_API_URL, 'https://vibefriends.com');
  for (const legacy of ['https://vibecafe.ai', 'https://vibecafe.ai/', ' https://VibeCafe.ai ', 'https://www.vibecafe.ai']) {
    assert.equal(isLegacyApiUrl(legacy), true, legacy);
    assert.equal(currentApiUrl(legacy), DEFAULT_API_URL, legacy);
  }
  assert.equal(currentApiUrl(undefined), DEFAULT_API_URL);
  assert.equal(currentApiUrl(''), DEFAULT_API_URL);
  for (const custom of ['http://localhost:3000', 'https://staging.vibecafe.ai', 'https://vibecafe.ai.example.com']) {
    assert.equal(isLegacyApiUrl(custom), false, custom);
    assert.equal(currentApiUrl(custom), custom, custom);
  }
  assert.equal(sameApiServer('https://vibecafe.ai', 'https://vibefriends.com'), true);
  assert.equal(sameApiServer('https://vibecafe.ai/', DEFAULT_API_URL), true);
  assert.equal(sameApiServer('http://localhost:3000', DEFAULT_API_URL), false);
});

test('config migration rewrites only the old production URL and fills it in for configured installs', () => {
  const legacy = { apiKey: 'vbu_x', apiUrl: 'https://vibecafe.ai', lastUploadProjectApiUrl: 'https://vibecafe.ai', lastUploadProject: true };
  assert.equal(migrateConfigApiUrl(legacy), true);
  assert.deepEqual(legacy, { apiKey: 'vbu_x', apiUrl: DEFAULT_API_URL, lastUploadProjectApiUrl: DEFAULT_API_URL, lastUploadProject: true });

  const missing = { apiKey: 'vbu_x' };
  assert.equal(migrateConfigApiUrl(missing), true);
  assert.equal(missing.apiUrl, DEFAULT_API_URL);

  const custom = { apiKey: 'vbu_x', apiUrl: 'http://localhost:3000', lastUploadProjectApiUrl: 'http://localhost:3000' };
  assert.equal(migrateConfigApiUrl(custom), false);
  assert.equal(custom.apiUrl, 'http://localhost:3000');

  const unconfigured = { extraRoots: {} };
  assert.equal(migrateConfigApiUrl(unconfigured), false);
  assert.equal('apiUrl' in unconfigured, false);
  assert.equal(migrateConfigApiUrl(null), false);
});

test('loadConfig persists the migration and keeps the key file owner-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-usage-api-url-'));
  try {
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ apiKey: 'vbu_fixture', apiUrl: 'https://vibecafe.ai', hostname: 'h' }), { mode: 0o600 });
    const out = probe(`import { loadConfig } from './src/config.js'; console.log(JSON.stringify(loadConfig()));`,
      { VIBE_USAGE_CONFIG_DIR: dir, VIBE_USAGE_DEV: '0' });
    assert.equal(JSON.parse(out).apiUrl, DEFAULT_API_URL);
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(onDisk, { apiKey: 'vbu_fixture', apiUrl: DEFAULT_API_URL, hostname: 'h' });
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('upload state recorded against the old name survives the switch (no full re-upload)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-usage-api-url-state-'));
  try {
    const out = probe(`
      import { saveState, loadState, inspectStateIdentity, stateIdentity } from './src/state.js';
      const old = stateIdentity({ apiUrl: 'https://vibecafe.ai', apiKey: 'vbu_k' });
      saveState({ buckets: { a: 'h1' }, sessions: { s: 'h2' } }, old);
      const next = stateIdentity({ apiUrl: 'https://vibefriends.com', apiKey: 'vbu_k' });
      const otherKey = stateIdentity({ apiUrl: 'https://vibefriends.com', apiKey: 'vbu_other' });
      const loaded = loadState(next);
      console.log(JSON.stringify({
        buckets: loaded.buckets, identityChanged: !!loaded.identityChanged,
        match: inspectStateIdentity(next), otherKey: inspectStateIdentity(otherKey),
      }));`, { VIBE_USAGE_STATE_DIR: dir, VIBE_USAGE_CONFIG_DIR: dir, VIBE_USAGE_DEV: '0' });
    const result = JSON.parse(out);
    assert.deepEqual(result.buckets, { a: 'h1' });
    assert.equal(result.identityChanged, false);
    assert.equal(result.match, 'match');
    assert.equal(result.otherKey, 'mismatch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
