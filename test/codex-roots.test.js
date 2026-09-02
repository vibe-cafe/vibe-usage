import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  codexSessionDirs,
  primaryCodexHome,
  resolveCodexHomes,
  validateExtraCodexHome,
} from '../src/codex-roots.js';
import { findCodexDataDirs } from '../src/tools.js';
import { discoverCodexHomes, validateExtraRoot } from '../src/extra-roots.js';

function withCodexHome(value, fn) {
  const previous = process.env.CODEX_HOME;
  if (value === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
}

test('primaryCodexHome honors CODEX_HOME and defaults to ~/.codex', () => {
  withCodexHome(undefined, () => {
    assert.equal(primaryCodexHome(), join(homedir(), '.codex'));
  });
  withCodexHome('./relative-codex', () => {
    assert.equal(primaryCodexHome(), resolve('./relative-codex'));
  });
});

test('resolveCodexHomes expands, adds, and de-duplicates an extra root', () => {
  const primary = resolve('/tmp/vibe-usage-primary-codex');
  withCodexHome(primary, () => {
    assert.deepEqual(resolveCodexHomes('~/another-codex'), [
      primary,
      join(homedir(), 'another-codex'),
    ]);
    assert.deepEqual(resolveCodexHomes(primary), [primary]);
    assert.deepEqual(resolveCodexHomes(''), [primary]);
  });
});

test('codexSessionDirs includes live and archived session directories', () => {
  assert.deepEqual(codexSessionDirs('/tmp/codex-root'), [
    '/tmp/codex-root/sessions',
    '/tmp/codex-root/archived_sessions',
  ]);
});

test('validateExtraCodexHome requires an existing Codex session directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codex-roots-'));
  const valid = join(root, 'valid');
  const empty = join(root, 'empty');
  mkdirSync(join(valid, 'archived_sessions'), { recursive: true });
  mkdirSync(empty);
  try {
    assert.deepEqual(validateExtraCodexHome(valid), { ok: true, path: resolve(valid) });
    assert.deepEqual(validateExtraCodexHome(empty), { ok: false, path: resolve(empty) });
    assert.equal(validateExtraCodexHome(join(root, 'missing')).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findCodexDataDirs detects sessions present only in the extra root', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codex-detect-'));
  const primary = join(root, 'missing-primary');
  const extra = join(root, 'extra');
  mkdirSync(join(extra, 'sessions'), { recursive: true });
  try {
    withCodexHome(primary, () => {
      assert.deepEqual(findCodexDataDirs(extra), [join(extra, 'sessions')]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex extra root discovers bounded Multica task homes without entering deeper workdirs', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codex-container-'));
  const taskHome = join(root, 'workspace-a', 'task-a', 'codex-home');
  const tooDeep = join(root, 'workspace-b', 'task-b', 'workdir', 'codex-home');
  mkdirSync(join(taskHome, 'sessions'), { recursive: true });
  mkdirSync(join(tooDeep, 'sessions'), { recursive: true });
  try {
    assert.deepEqual(discoverCodexHomes(root).homes, [taskHome]);
    assert.equal(validateExtraRoot('codex', root).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
