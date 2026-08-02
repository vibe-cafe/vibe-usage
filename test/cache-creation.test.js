import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseAmp } from '../src/parsers/amp.js';
import { parse as parseOpenClaw } from '../src/parsers/openclaw.js';

function restoreEnv(name, value) {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

test('Amp includes cache creation tokens in input for ledger and legacy records', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-amp-cache-'));
  const previous = process.env.AMP_DATA_DIR;
  try {
    process.env.AMP_DATA_DIR = root;
    writeFileSync(join(root, 'T-ledger.json'), JSON.stringify({
      id: 'ledger',
      created: '2026-07-01T10:00:00.000Z',
      messages: [{ role: 'assistant', usage: { cacheReadInputTokens: 7, cacheCreationInputTokens: 5 } }],
      usageLedger: {
        events: [{
          timestamp: '2026-07-01T10:05:00.000Z',
          toMessageId: 0,
          model: 'amp-model',
          tokens: { input: 10, output: 2 },
        }],
      },
    }));
    writeFileSync(join(root, 'T-legacy.json'), JSON.stringify({
      id: 'legacy',
      created: '2026-07-01T10:00:00.000Z',
      messages: [{
        role: 'assistant',
        timestamp: '2026-07-01T10:06:00.000Z',
        usage: {
          model: 'amp-model',
          inputTokens: 20,
          outputTokens: 3,
          cacheReadInputTokens: 6,
          cacheCreationInputTokens: 4,
        },
      }],
    }));

    const result = await parseAmp();
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0].inputTokens, 39);
    assert.equal(result.buckets[0].outputTokens, 5);
    assert.equal(result.buckets[0].cachedInputTokens, 13);
  } finally {
    restoreEnv('AMP_DATA_DIR', previous);
    rmSync(root, { recursive: true, force: true });
  }
});

test('OpenClaw normalizes cache-write aliases and numeric strings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-openclaw-cache-'));
  const previous = process.env.VIBE_USAGE_OPENCLAW_DIRS;
  try {
    const sessions = join(root, 'agents', 'main', 'sessions');
    mkdirSync(sessions, { recursive: true });
    process.env.VIBE_USAGE_OPENCLAW_DIRS = root;
    const message = (timestamp, usage) => JSON.stringify({
      type: 'message',
      timestamp,
      message: { role: 'assistant', model: 'claw-model', usage },
    });
    writeFileSync(join(sessions, 'session.jsonl'), [
      message('2026-07-01T10:05:00.000Z', {
        input: '10', output: '2', cacheRead: '3', cacheCreation: '5',
      }),
      message('2026-07-01T10:06:00.000Z', {
        input_tokens: 1, output_tokens: 1, cache_write_input_tokens: 7,
      }),
    ].join('\n') + '\n');

    const result = await parseOpenClaw();
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0].inputTokens, 23);
    assert.equal(result.buckets[0].outputTokens, 3);
    assert.equal(result.buckets[0].cachedInputTokens, 3);
  } finally {
    restoreEnv('VIBE_USAGE_OPENCLAW_DIRS', previous);
    rmSync(root, { recursive: true, force: true });
  }
});
