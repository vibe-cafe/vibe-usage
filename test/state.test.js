import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// state.js and config.js resolve their directories at module load, so point
// both at a throwaway dir BEFORE importing them (each test file runs in its
// own process under node --test).
const dir = mkdtempSync(join(tmpdir(), 'vibe-usage-state-test-'));
process.env.VIBE_USAGE_STATE_DIR = dir;
process.env.VIBE_USAGE_CONFIG_DIR = dir;

const { loadState, saveState, clearState, pruneState, getStatePath } = await import('../src/state.js');
const { saveConfig, getConfigPath } = await import('../src/config.js');

test('saveState/loadState round-trips buckets and sessions', () => {
  const state = { buckets: { 'codex|m|p|h|t': 'hash1' }, sessions: { 'kiro|abc': 'hash2' } };
  saveState(state);
  assert.deepEqual(loadState(), state);
});

test('loadState treats a corrupt state file as empty (full re-upload)', () => {
  writeFileSync(getStatePath(), 'not json{', 'utf-8');
  assert.deepEqual(loadState(), { buckets: {}, sessions: {} });
});

test('clearState deletes the state file so the next sync re-uploads everything', () => {
  saveState({ buckets: { a: '1' }, sessions: {} });
  assert.equal(existsSync(getStatePath()), true);
  clearState();
  assert.equal(existsSync(getStatePath()), false);
  assert.deepEqual(loadState(), { buckets: {}, sessions: {} });
  // Idempotent: clearing again must not throw.
  clearState();
});

test('pruneState drops keys the parsers no longer emit', () => {
  const state = {
    buckets: { 'codex|m|p|h|t': 'x', 'kiro|m|p|h|t': 'y' },
    sessions: { 'codex|s1': 'z' },
  };
  pruneState(state, new Set(['codex|m|p|h|t']), new Set());
  assert.deepEqual(state, { buckets: { 'codex|m|p|h|t': 'x' }, sessions: {} });
});

test('pruneState keeps keys of sources whose parser failed this run', () => {
  const state = {
    buckets: { 'codex|m|p|h|t': 'x', 'kiro|m|p|h|t': 'y' },
    sessions: { 'cursor|s1': 'z' },
  };
  // kiro's parser threw this sync (not in okSources) and emitted nothing
  // (not in live sets): its state must survive, or the next sync would
  // re-upload kiro's entire history. cursor succeeded and emitted nothing —
  // its stale key is correctly pruned.
  pruneState(state, new Set(), new Set(), new Set(['codex', 'cursor']));
  assert.deepEqual(state, { buckets: { 'kiro|m|p|h|t': 'y' }, sessions: {} });
});

test('saveConfig writes the API key file readable only by the owner', { skip: process.platform === 'win32' }, () => {
  saveConfig({ apiKey: 'vbu_secret' });
  const mode = statSync(getConfigPath()).mode & 0o777;
  assert.equal(mode, 0o600);
});
