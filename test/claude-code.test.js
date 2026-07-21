import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from '../src/parsers/claude-code.js';

function record({
  type = 'assistant',
  timestamp = '2026-07-21T10:05:00.000Z',
  cwd = '/Users/dev/my-hyphen-project',
  uuid,
  model = 'claude-opus-4-8',
  usage,
}) {
  const value = { type, timestamp, cwd };
  if (uuid) value.uuid = uuid;
  if (type === 'assistant') value.message = { model, usage };
  return value;
}

function writeSession(root, projectDir, sessionId, records) {
  const dir = join(root, 'projects', projectDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    records.map(JSON.stringify).join('\n') + '\n',
  );
}

async function withClaudeRoots(roots, fn) {
  const previous = process.env.VIBE_USAGE_CLAUDE_DIRS;
  process.env.VIBE_USAGE_CLAUDE_DIRS = roots.join(delimiter);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.VIBE_USAGE_CLAUDE_DIRS;
    else process.env.VIBE_USAGE_CLAUDE_DIRS = previous;
  }
}

test('Claude parser counts cache creation, keeps the initial cwd project, and drops zero usage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-claude-test-'));
  try {
    writeSession(root, '-Users-dev-my-hyphen-project', 'session-a', [
      record({
        type: 'user',
        timestamp: '2026-07-21T10:00:00.000Z',
      }),
      record({
        uuid: 'usage-a',
        cwd: '/Users/dev/my-hyphen-project/packages/api',
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          cache_read_input_tokens: 13,
          cache_creation_input_tokens: 17,
          cache_creation: {
            ephemeral_5m_input_tokens: 5,
            ephemeral_1h_input_tokens: 12,
          },
        },
      }),
      record({
        uuid: 'synthetic-zero',
        timestamp: '2026-07-21T10:35:00.000Z',
        model: '<synthetic>',
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    ]);

    const result = await withClaudeRoots([root], () => parse());

    assert.equal(result.skipped, undefined);
    assert.equal(result.buckets.length, 1);
    assert.deepEqual(result.buckets[0], {
      source: 'claude-code',
      model: 'claude-opus-4-8',
      project: 'my-hyphen-project',
      bucketStart: '2026-07-21T10:00:00.000Z',
      inputTokens: 28,
      outputTokens: 7,
      cachedInputTokens: 13,
      reasoningOutputTokens: 0,
      totalTokens: 35,
    });
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].project, 'my-hyphen-project');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude parser keeps the most complete duplicate UUID and preserves unknown Claude models', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-claude-test-'));
  try {
    writeSession(root, '-Users-dev-proj', 'session-low', [
      record({
        uuid: 'duplicate-uuid',
        cwd: '/Users/dev/proj',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ]);
    writeSession(root, '-Users-dev-proj', 'session-high', [
      record({
        uuid: 'duplicate-uuid',
        cwd: '/Users/dev/proj',
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    ]);
    writeSession(root, '-Users-dev-proj', 'session-unknown', [
      record({
        uuid: 'missing-model',
        timestamp: '2026-07-21T10:35:00.000Z',
        cwd: '/Users/dev/proj',
        model: '',
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
    ]);

    const { buckets } = await withClaudeRoots([root], () => parse());
    assert.equal(buckets.length, 2);
    assert.deepEqual(
      buckets.map((bucket) => ({
        model: bucket.model,
        input: bucket.inputTokens,
        output: bucket.outputTokens,
      })).sort((a, b) => a.model.localeCompare(b.model)),
      [
        { model: 'claude-opus-4-8', input: 100, output: 10 },
        { model: 'claude-unknown', input: 3, output: 2 },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude parser selects the more complete copy of a session across config roots', async () => {
  const base = mkdtempSync(join(tmpdir(), 'vibe-usage-claude-roots-test-'));
  const staleRoot = join(base, 'stale');
  const activeRoot = join(base, 'active');
  try {
    writeSession(staleRoot, '-Users-dev-proj', 'same-session', [
      record({
        uuid: 'shared-entry',
        cwd: '/Users/dev/proj',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ]);
    writeSession(activeRoot, '-Users-dev-proj', 'same-session', [
      record({
        uuid: 'shared-entry',
        cwd: '/Users/dev/proj',
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
      record({
        uuid: 'new-entry',
        timestamp: '2026-07-21T10:06:00.000Z',
        cwd: '/Users/dev/proj',
        usage: { input_tokens: 50, output_tokens: 5 },
      }),
    ]);

    const { buckets, sessions } = await withClaudeRoots(
      [staleRoot, activeRoot],
      () => parse(),
    );

    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].inputTokens, 150);
    assert.equal(buckets[0].outputTokens, 15);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].messageCount, 2);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('Claude parser reports unreadable roots as incomplete instead of pruning upload state', async () => {
  const base = mkdtempSync(join(tmpdir(), 'vibe-usage-claude-warning-test-'));
  const notADirectory = join(base, 'not-a-directory');
  writeFileSync(notADirectory, 'fixture');
  try {
    const result = await withClaudeRoots([notADirectory], () => parse());
    assert.equal(result.skipped, true);
    assert.equal(result.buckets.length, 0);
    assert.ok(result.warnings.some((warning) => warning.includes('cannot read directory')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
