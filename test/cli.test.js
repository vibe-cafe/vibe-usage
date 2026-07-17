import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const testDir = dirname(fileURLToPath(import.meta.url));
const bin = join(testDir, '..', 'bin', 'vibe-usage.js');

function run(...args) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf-8' });
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
