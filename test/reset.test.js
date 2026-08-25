import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// reset.js's config/state dependencies resolve their dirs at module load —
// redirect both to a throwaway dir before importing anything.
const dir = mkdtempSync(join(tmpdir(), 'vibe-usage-reset-test-'));
process.env.VIBE_USAGE_STATE_DIR = dir;
process.env.VIBE_USAGE_CONFIG_DIR = dir;

const { saveConfig } = await import('../src/config.js');
const { saveState, loadState, getStatePath } = await import('../src/state.js');
const { runReset } = await import('../src/reset.js');

function seed() {
  saveConfig({ apiKey: 'vbu_test', hostname: 'persisted-host' });
  saveState({
    buckets: { 'codex|m|p|persisted-host|t': 'hash' },
    sessions: { 'codex|s1': 'hash2' },
  });
}

function makeDeps(overrides = {}) {
  const calls = { deleted: [], resynced: 0, stateAtResync: null };
  return {
    calls,
    deps: {
      prompt: async () => 'y',
      deleteAllData: async (apiUrl, apiKey, opts) => {
        calls.deleted.push({ apiUrl, apiKey, opts });
        return { deleted: 3, sessions: 1 };
      },
      runSync: async () => {
        calls.resynced++;
        // The whole point of the fix: by the time the re-sync runs, the old
        // upload state must already be gone, or the diff uploads zero bytes.
        calls.stateAtResync = loadState();
      },
      ...overrides,
    },
  };
}

test('reset clears state.json before re-syncing so data is actually re-uploaded', async () => {
  seed();
  const { calls, deps } = makeDeps();
  await runReset([], deps);

  assert.equal(calls.deleted.length, 1);
  assert.equal(calls.deleted[0].opts, undefined); // full reset: no hostname filter
  assert.equal(calls.resynced, 1);
  assert.deepEqual(calls.stateAtResync, { buckets: {}, sessions: {} });
});

test('reset --local deletes using the persisted hostname, not os.hostname()', async () => {
  seed();
  const { calls, deps } = makeDeps();
  await runReset(['--local'], deps);

  assert.equal(calls.deleted.length, 1);
  assert.deepEqual(calls.deleted[0].opts, { hostname: 'persisted-host' });
  assert.equal(calls.resynced, 1);
});

test('legacy reset --host remains a host-only alias', async () => {
  seed();
  const { calls, deps } = makeDeps();
  await runReset(['--host'], deps);

  assert.equal(calls.deleted.length, 1);
  assert.deepEqual(calls.deleted[0].opts, { hostname: 'persisted-host' });
  assert.equal(calls.resynced, 1);
});

test('reset aborted at the prompt deletes nothing and keeps state intact', async () => {
  seed();
  const { calls, deps } = makeDeps({ prompt: async () => 'n' });
  await runReset([], deps);

  assert.equal(calls.deleted.length, 0);
  assert.equal(calls.resynced, 0);
  assert.equal(Object.keys(loadState().buckets).length, 1);
});

test('getStatePath stays inside the redirected test dir', () => {
  assert.ok(getStatePath().startsWith(dir));
});
