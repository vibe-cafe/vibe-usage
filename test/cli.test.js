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

test('config add-root, roots, and remove-root manage tool-specific roots without touching legacy config', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-cli-roots-'));
  const configDir = join(root, 'config');
  const grokHome = join(root, 'grok-home');
  mkdirSync(join(grokHome, 'sessions'), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ codexExtraHome: '/legacy/codex' }));
  const env = { VIBE_USAGE_CONFIG_DIR: configDir };
  try {
    const add = runWithEnv(['config', 'add-root', 'grok', grokHome], env);
    assert.equal(add.status, 0, add.stderr);
    const duplicate = runWithEnv(['config', 'add-root', 'grok', grokHome], env);
    assert.equal(duplicate.status, 0, duplicate.stderr);
    const listed = runWithEnv(['config', 'roots'], env);
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout), { grok: [grokHome] });
    let config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
    assert.equal(config.codexExtraHome, '/legacy/codex');

    const remove = runWithEnv(['config', 'remove-root', 'grok', grokHome], env);
    assert.equal(remove.status, 0, remove.stderr);
    config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
    assert.equal(config.extraRoots, undefined);
    assert.equal(config.codexExtraHome, '/legacy/codex');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config add-root accepts a Pi session store and reports it in status', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-cli-pi-root-'));
  const configDir = join(root, 'config');
  const piStore = join(root, 'harness-sessions');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(piStore, { recursive: true });
  writeFileSync(join(piStore, 'session-1.jsonl'), `${JSON.stringify({
    type: 'session',
    id: 'session-1',
    timestamp: '2026-09-01T00:00:00.000Z',
    cwd: '/work/harness',
  })}\n`);
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ apiKey: 'vbu_test' }));
  const env = { VIBE_USAGE_CONFIG_DIR: configDir, HOME: root };
  try {
    const add = runWithEnv(['config', 'add-root', 'pi-coding-agent', piStore], env);
    assert.equal(add.status, 0, add.stderr);
    const listed = runWithEnv(['config', 'roots'], env);
    assert.deepEqual(JSON.parse(listed.stdout), { 'pi-coding-agent': [piStore] });

    // An added root also makes the tool detected, not just scanned.
    const status = runWithEnv(['status'], env);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Extra pi-coding-agent Root: /);
    assert.match(status.stdout, /Detected tools:[\s\S]*pi/);

    const empty = runWithEnv(['config', 'add-root', 'pi-coding-agent', configDir], env);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /需要是直接包含 Pi 会话 \.jsonl 的目录/);

    // A same-extension log that is not a Pi session must be rejected too:
    // accepting it would persist a root the parser then silently ignores.
    const notPi = join(root, 'unrelated-logs');
    mkdirSync(notPi, { recursive: true });
    writeFileSync(join(notPi, 'events.jsonl'), '{"kind":"not-a-pi-session"}\n');
    const wrong = runWithEnv(['config', 'add-root', 'pi-coding-agent', notPi], env);
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /需要是直接包含 Pi 会话 \.jsonl 的目录/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config add-root rejects unsupported tools and invalid layouts', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-cli-invalid-root-'));
  try {
    const unsupported = runWithEnv(
      ['config', 'add-root', 'cursor', root],
      { VIBE_USAGE_CONFIG_DIR: join(root, 'config') },
    );
    assert.equal(unsupported.status, 1);
    assert.match(unsupported.stderr, /不支持的工具/);

    const invalid = runWithEnv(
      ['config', 'add-root', 'grok', root],
      { VIBE_USAGE_CONFIG_DIR: join(root, 'config') },
    );
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /需要包含 sessions/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
