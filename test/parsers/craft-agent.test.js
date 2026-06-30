import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parse as parseCraftAgent } from '../../src/parsers/craft-agent.js';

test('craft-agent parser reads pi-compatible JSONL usage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-craft-agent-'));
  const oldEnv = process.env.CRAFT_AGENT_DIR;

  try {
    process.env.CRAFT_AGENT_DIR = root;

    const sessionDir = join(root, 'workspaces', 'code-space', 'sessions', 'fresh-branch', '.pi-sessions');
    mkdirSync(sessionDir, { recursive: true });

    writeFileSync(join(sessionDir, 'session.jsonl'), [
      JSON.stringify({ type: 'session', id: 'session-1', timestamp: '2026-06-30T15:00:00.000Z', cwd: '/repo/project-alpha' }),
      JSON.stringify({ type: 'message', id: 'u1', timestamp: '2026-06-30T15:01:00.000Z', message: { role: 'user', content: [] } }),
      '{not-json',
      JSON.stringify({ type: 'message', id: 'a0', timestamp: '2026-06-30T15:01:10.000Z', message: { role: 'assistant', model: 'gpt-test', content: [] } }),
      JSON.stringify({
        type: 'message',
        id: 'a1',
        timestamp: '2026-06-30T15:01:20.000Z',
        message: {
          role: 'assistant',
          model: 'gpt-test',
          content: [],
          usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, totalTokens: 150, cost: { total: 0.01 } },
        },
      }),
      JSON.stringify({ type: 'message', id: 't1', timestamp: '2026-06-30T15:01:25.000Z', message: { role: 'toolResult', content: [] } }),
      '',
    ].join('\n'));

    const result = await parseCraftAgent();

    assert.equal(result.buckets.length, 1);
    assert.deepEqual(result.buckets[0], {
      source: 'craft-agent',
      model: 'gpt-test',
      project: 'project-alpha',
      bucketStart: '2026-06-30T15:00:00.000Z',
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 30,
      reasoningOutputTokens: 0,
      totalTokens: 120,
    });

    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].source, 'craft-agent');
    assert.equal(result.sessions[0].project, 'project-alpha');
    assert.equal(result.sessions[0].messageCount, 4);
    assert.equal(result.sessions[0].userMessageCount, 1);
  } finally {
    if (oldEnv == null) delete process.env.CRAFT_AGENT_DIR;
    else process.env.CRAFT_AGENT_DIR = oldEnv;
    rmSync(root, { recursive: true, force: true });
  }
});
