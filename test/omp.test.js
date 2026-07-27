import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from '../src/parsers/omp.js';

function writeSessionFixture(sessionsDir) {
  const group = '--home-AI-gf--';
  const sessionId = '019fa3bb-6ca5-7000-a966-e44970259739';
  const fileName = `2026-07-27T13-19-57-093Z_${sessionId}.jsonl`;
  const groupDir = join(sessionsDir, group);
  mkdirSync(groupDir, { recursive: true });

  // Companion directory with the same basename holding *.bash.log — must be ignored.
  mkdirSync(join(groupDir, fileName.replace(/\.jsonl$/, '')), { recursive: true });
  writeFileSync(join(groupDir, fileName.replace(/\.jsonl$/, ''), 'cmd.bash.log'), 'echo hi\n');

  const msg = (id, parentId, ts, role, extra = {}) =>
    JSON.stringify({
      type: 'message',
      id,
      parentId,
      timestamp: ts,
      message: { role, content: [], timestamp: new Date(ts).getTime(), ...extra },
    });

  const usage = (input, output, cacheRead, reasoningTokens = 0) => ({
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: input + output + cacheRead,
    reasoningTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });

  const duplicate = JSON.parse(
    msg('dup01', 'a1', '2026-07-27T13:20:00.000Z', 'assistant', {
      provider: 'kimi-code',
      model: 'k3-256k',
      usage: usage(500, 100, 2000),
    }),
  );

  writeFileSync(join(groupDir, fileName), [
    JSON.stringify({ type: 'title', v: 1, title: '', updatedAt: '2026-07-27T13:19:57.093Z' }),
    JSON.stringify({
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: '2026-07-27T13:19:57.093Z',
      cwd: '/home/AI-gf',
    }),
    JSON.stringify({ type: 'model_change', id: 'mc01', parentId: null, timestamp: '2026-07-27T13:19:57.710Z', model: 'k3-256k' }),
    msg('u1', null, '2026-07-27T13:20:00.000Z', 'user'),
    msg('a1', 'u1', '2026-07-27T13:20:10.000Z', 'assistant', {
      provider: 'kimi-code',
      model: 'k3-256k',
      usage: usage(1000, 200, 5000, 123),
    }),
    msg('t1', 'a1', '2026-07-27T13:20:12.000Z', 'toolResult'),
    JSON.stringify(duplicate),
    // Same entry id replayed (compaction/rewrite) — must be deduplicated.
    JSON.stringify(duplicate),
    // Second half-hour bucket, no cache read.
    msg('u2', 't1', '2026-07-27T13:45:00.000Z', 'user'),
    msg('a2', 'u2', '2026-07-27T13:45:05.000Z', 'assistant', {
      provider: 'kimi-code',
      model: 'k3-256k',
      usage: usage(300, 50, 0),
    }),
    'not json at all',
  ].join('\n') + '\n');
}

test('parse reads omp assistant usage, dedups entries, and extracts sessions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-omp-test-'));
  const agentDir = join(root, 'agent');
  const sessionsDir = join(agentDir, 'sessions');
  writeSessionFixture(sessionsDir);

  const prev = process.env.OMP_AGENT_DIR;
  process.env.OMP_AGENT_DIR = agentDir;

  try {
    const result = await parse();

    const buckets = result.buckets.filter((b) => b.source === 'omp');
    assert.equal(buckets.length, 2);
    for (const b of buckets) {
      assert.equal(b.model, 'k3-256k');
      assert.equal(b.project, 'AI-gf');
    }

    const byStart = new Map(buckets.map((b) => [b.bucketStart, b]));
    const first = byStart.get('2026-07-27T13:00:00.000Z');
    assert.ok(first, 'expected 13:00 bucket');
    assert.equal(first.inputTokens, 1000 + 500);
    assert.equal(first.outputTokens, 200 + 100);
    assert.equal(first.cachedInputTokens, 5000 + 2000);
    // reasoningTokens (newer omp builds) maps to reasoningOutputTokens; the
    // duplicate entry must not double-count it.
    assert.equal(first.reasoningOutputTokens, 123);

    const second = byStart.get('2026-07-27T13:30:00.000Z');
    assert.ok(second, 'expected 13:30 bucket');
    assert.equal(second.inputTokens, 300);
    assert.equal(second.outputTokens, 50);
    assert.equal(second.cachedInputTokens, 0);

    const sum = (key) => buckets.reduce((a, b) => a + (b[key] || 0), 0);
    assert.equal(sum('inputTokens'), 1800);
    assert.equal(sum('outputTokens'), 350);
    assert.equal(sum('cachedInputTokens'), 7000);

    assert.equal(result.sessions.length, 1);
    const session = result.sessions[0];
    assert.equal(session.source, 'omp');
    assert.equal(session.project, 'AI-gf');
    assert.equal(session.userMessageCount, 2);
    assert.ok(session.messageCount >= 6);
    assert.equal(session.firstMessageAt, '2026-07-27T13:20:00.000Z');
    assert.equal(session.lastMessageAt, '2026-07-27T13:45:05.000Z');
    assert.ok(session.sessionHash);
  } finally {
    if (prev !== undefined) {
      process.env.OMP_AGENT_DIR = prev;
    } else {
      delete process.env.OMP_AGENT_DIR;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('parse returns empty result when omp agent dir is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-omp-empty-'));
  const prev = process.env.OMP_AGENT_DIR;
  process.env.OMP_AGENT_DIR = join(root, 'does-not-exist');

  try {
    const result = await parse();
    assert.deepEqual(result, { buckets: [], sessions: [] });
  } finally {
    if (prev !== undefined) {
      process.env.OMP_AGENT_DIR = prev;
    } else {
      delete process.env.OMP_AGENT_DIR;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
