import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const testDir = dirname(fileURLToPath(import.meta.url));
const bin = join(testDir, '..', 'bin', 'vibe-usage.js');

function run(...args) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf-8' });
}

function runWithEnv(args, env) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

test('unknown top-level command fails instead of falling through to init or sync', () => {
  const result = run('definitely-not-a-command');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: definitely-not-a-command/);
});

test('unknown daemon subcommand fails instead of starting the foreground loop', () => {
  const result = run('daemon', 'stauts');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /daemon.*stauts/);
});

test('legacy --daemon alias uses the same safe subcommand validation', () => {
  const result = run('--daemon', 'stauts');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /daemon.*stauts/);
});

test('legacy --key and canonical --manual-key remain accepted global options', () => {
  for (const flag of ['--key', '--manual-key']) {
    const result = run(flag, 'vbu_compat_test', '--help');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /vibe-usage - Vibe Usage Tracker/);
  }
});

test('--extra-codex-home validates a directory without persisting it', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-cli-extra-codex-'));
  const configDir = join(root, 'config');
  const extraHome = join(root, 'nested', '..', 'extra-codex');
  mkdirSync(join(resolve(extraHome), 'sessions'), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ hostname: 'existing-host' }));
  try {
    const result = runWithEnv(
      ['--extra-codex-home', extraHome, '--help'],
      { VIBE_USAGE_CONFIG_DIR: configDir }
    );
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
    assert.deepEqual(config, { hostname: 'existing-host' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--extra-codex-home rejects an invalid directory without replacing config', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-cli-invalid-codex-'));
  const configDir = join(root, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ codexExtraHome: '/previous/home' }));
  try {
    const result = runWithEnv(
      ['--extra-codex-home', join(root, 'missing'), '--help'],
      { VIBE_USAGE_CONFIG_DIR: configDir }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /额外 Codex Home/);
    const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
    assert.equal(config.codexExtraHome, '/previous/home');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config set accepts codexExtraHome and can clear it', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-cli-config-codex-'));
  const env = { VIBE_USAGE_CONFIG_DIR: root };
  const extraHome = join(root, 'nested', '..', 'extra-codex');
  mkdirSync(join(resolve(extraHome), 'archived_sessions'), { recursive: true });
  try {
    const set = runWithEnv(['config', 'set', 'codexExtraHome', extraHome], env);
    assert.equal(set.status, 0, set.stderr);
    let config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
    assert.equal(config.codexExtraHome, resolve(extraHome));
    const clear = runWithEnv(['config', 'set', 'codexExtraHome', ''], env);
    assert.equal(clear.status, 0, clear.stderr);
    config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
    assert.equal(config.codexExtraHome, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config set rejects an invalid non-empty codexExtraHome', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-cli-config-invalid-codex-'));
  try {
    const result = runWithEnv(
      ['config', 'set', 'codexExtraHome', join(root, 'missing')],
      { VIBE_USAGE_CONFIG_DIR: root }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /额外 Codex Home/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config set stores privacy controls as booleans and rejects ambiguous values', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-cli-config-privacy-'));
  const env = { VIBE_USAGE_CONFIG_DIR: root };
  try {
    for (const [key, value] of [
      ['uploadProject', 'false'],
      ['uploadHostname', 'true'],
    ]) {
      const result = runWithEnv(['config', 'set', key, value], env);
      assert.equal(result.status, 0, result.stderr);
    }
    const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
    assert.equal(config.uploadProject, false);
    assert.equal(config.uploadHostname, true);

    const invalid = runWithEnv(['config', 'set', 'uploadHostname', 'no'], env);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /must be true or false/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('daemon service commands require manual persistence instead of ignoring a temporary home', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-cli-daemon-codex-'));
  const extraHome = join(root, 'extra-codex');
  mkdirSync(join(extraHome, 'sessions'), { recursive: true });
  try {
    const result = runWithEnv(
      ['daemon', 'status', '--extra-codex-home', extraHome],
      { VIBE_USAGE_CONFIG_DIR: join(root, 'config') }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /config set codexExtraHome/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('help documents the extra Codex home option', () => {
  const result = run('--help');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--extra-codex-home <path>/);
});

test('status displays the persisted extra Codex home and detects Codex there', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-cli-status-codex-'));
  const configDir = join(root, 'config');
  const primary = join(root, 'missing-primary');
  const extra = join(root, 'extra');
  mkdirSync(join(extra, 'sessions'), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    apiKey: 'vbu_test',
    codexExtraHome: extra,
  }));
  try {
    const result = runWithEnv(['status'], {
      HOME: root,
      CODEX_HOME: primary,
      VIBE_USAGE_CONFIG_DIR: configDir,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Extra Codex Home: ${extra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(result.stdout, /Detected tools:[\s\S]*Codex CLI/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
