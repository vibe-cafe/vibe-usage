import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_API_URL, currentApiUrl, isLegacyApiUrl, isPlaintextRemoteApiUrl, migrateConfigApiUrl, sameApiServer,
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
  assert.equal(sameApiServer('https://vibefriends.com/', 'https://vibecafe.ai'), true);
  assert.equal(sameApiServer('https://VibeFriends.com', DEFAULT_API_URL), true);
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

test('loadConfig migrates in memory only; persistApiUrlMigration patches the URL fields of the current file atomically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-usage-api-url-'));
  try {
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ apiKey: 'vbu_fixture', apiUrl: 'https://vibecafe.ai', hostname: 'h' }), { mode: 0o600 });
    const env = { VIBE_USAGE_CONFIG_DIR: dir, VIBE_USAGE_STATE_DIR: dir, VIBE_USAGE_DEV: '0' };
    // Readers (doctor, status) see the new host but never write.
    const loaded = probe(`import { loadConfig } from './src/config.js'; console.log(JSON.stringify(loadConfig()));`, env);
    assert.equal(JSON.parse(loaded).apiUrl, DEFAULT_API_URL);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).apiUrl, 'https://vibecafe.ai');
    // A desktop app saves a new key after this process read the file: the
    // migration re-reads and keeps it, changing only the URL.
    writeFileSync(file, JSON.stringify({ apiKey: 'vbu_new', apiUrl: 'https://vibecafe.ai', hostname: 'h', extra: 1 }), { mode: 0o600 });
    const wrote = probe(`import { persistApiUrlMigration } from './src/config.js'; console.log(persistApiUrlMigration());`, env);
    assert.equal(wrote.trim(), 'true');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { apiKey: 'vbu_new', apiUrl: DEFAULT_API_URL, hostname: 'h', extra: 1 });
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    // Nothing left to migrate: no write.
    assert.equal(probe(`import { persistApiUrlMigration } from './src/config.js'; console.log(persistApiUrlMigration());`, env).trim(), 'false');
    // A custom server is left alone.
    writeFileSync(file, JSON.stringify({ apiKey: 'vbu_new', apiUrl: 'http://localhost:3000' }), { mode: 0o600 });
    assert.equal(probe(`import { persistApiUrlMigration } from './src/config.js'; console.log(persistApiUrlMigration());`, env).trim(), 'false');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).apiUrl, 'http://localhost:3000');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('state.json identity is renamed in place, keeping every hash (old CLIs compare plain strings)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-usage-api-url-state-rename-'));
  try {
    const out = probe(`
      import { saveState, migrateStateIdentityApiUrl, stateIdentity } from './src/state.js';
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      saveState({ buckets: { a: 'h1' }, sessions: { s: 'h2' } }, stateIdentity({ apiUrl: 'https://vibecafe.ai', apiKey: 'vbu_k' }));
      const first = migrateStateIdentityApiUrl();
      const second = migrateStateIdentityApiUrl();
      const onDisk = JSON.parse(readFileSync(join(process.env.VIBE_USAGE_STATE_DIR, 'state.json'), 'utf8'));
      console.log(JSON.stringify({ first, second, onDisk, expectedFp: stateIdentity({ apiKey: 'vbu_k' }).keyFingerprint }));`,
      { VIBE_USAGE_STATE_DIR: dir, VIBE_USAGE_CONFIG_DIR: dir, VIBE_USAGE_DEV: '0' });
    const r = JSON.parse(out);
    assert.equal(r.first, true);
    assert.equal(r.second, false);
    assert.deepEqual(r.onDisk.buckets, { a: 'h1' });
    assert.deepEqual(r.onDisk.sessions, { s: 'h2' });
    assert.equal(r.onDisk.identity.apiUrl, DEFAULT_API_URL);
    assert.equal(r.onDisk.identity.keyFingerprint, r.expectedFp);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saving the new URL (config set) renames the state identity too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-usage-api-url-save-'));
  try {
    const out = probe(`
      import { saveState, stateIdentity } from './src/state.js';
      import { loadConfig, saveConfig } from './src/config.js';
      import { readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const dir = process.env.VIBE_USAGE_STATE_DIR;
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ apiKey: 'vbu_k', apiUrl: 'https://vibecafe.ai', hostname: 'h' }));
      saveState({ buckets: { a: 'h1' }, sessions: {} }, stateIdentity({ apiUrl: 'https://vibecafe.ai', apiKey: 'vbu_k' }));
      const config = loadConfig();
      config.hostname = 'h2';
      saveConfig(config);
      const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
      const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
      console.log(JSON.stringify({ stateUrl: state.identity.apiUrl, buckets: state.buckets, configUrl: saved.apiUrl }));`,
      { VIBE_USAGE_STATE_DIR: dir, VIBE_USAGE_CONFIG_DIR: dir, VIBE_USAGE_DEV: '0' });
    const r = JSON.parse(out);
    assert.equal(r.configUrl, DEFAULT_API_URL);
    assert.equal(r.stateUrl, DEFAULT_API_URL);
    assert.deepEqual(r.buckets, { a: 'h1' });
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

test('plain http to another machine is flagged; loopback and https are not', () => {
  for (const url of ['http://192.168.1.5:3000', 'http://usage.example.com', 'HTTP://Example.com/vibe', 'http://10.0.0.2']) {
    assert.equal(isPlaintextRemoteApiUrl(url), true, url);
  }
  for (const url of ['http://localhost:3000', 'http://LOCALHOST', 'http://127.0.0.1:3456', 'http://[::1]:3000',
    'https://vibefriends.com', 'https://192.168.1.5:3000', 'not a url', '', undefined]) {
    assert.equal(isPlaintextRemoteApiUrl(url), false, String(url));
  }
});
