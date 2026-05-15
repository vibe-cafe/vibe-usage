import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { parse } from '../src/parsers/codex.js';

function writeJsonl(filePath, rows) {
  writeFileSync(filePath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

test('codex parser skips fork replay token counts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codex-'));
  try {
    const sessionsDir = join(root, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const forkedSession = join(sessionsDir, 'rollout-forked.jsonl');

    writeJsonl(forkedSession, [
      {
        type: 'session_meta',
        timestamp: '2026-05-15T13:49:28.000Z',
        payload: {
          id: 'forked',
          forked_from_id: 'original',
          cwd: '/tmp/project',
        },
      },
      {
        type: 'turn_context',
        timestamp: '2026-05-15T13:49:28.100Z',
        payload: { model: 'gpt-5.5' },
      },
      {
        type: 'event_msg',
        timestamp: '2026-05-15T13:49:28.200Z',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 1_000_000,
              cached_input_tokens: 900_000,
              output_tokens: 10_000,
              reasoning_output_tokens: 2_000,
            },
          },
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-05-15T13:49:35.000Z',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 1_000,
              cached_input_tokens: 100,
              output_tokens: 200,
              reasoning_output_tokens: 50,
            },
          },
        },
      },
    ]);

    const { buckets } = await parse({ sessionsDir });

    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].inputTokens, 900);
    assert.equal(buckets[0].cachedInputTokens, 100);
    assert.equal(buckets[0].outputTokens, 150);
    assert.equal(buckets[0].reasoningOutputTokens, 50);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

