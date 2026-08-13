import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { parse } from '../src/parsers/workbuddy.js';
import { parsers } from '../src/parsers/index.js';
import { TOOLS } from '../src/tools.js';
import { findWorkbuddyDataDirs } from '../src/workbuddy-roots.js';

function assistantRecord({ id, model, timestamp, usage, rawUsage, status = 'completed' }) {
  return {
    id,
    timestamp,
    type: 'message',
    role: 'assistant',
    status,
    cwd: '/private/repo/actual-project',
    content: [{ type: 'text', text: 'PRIVATE_WORKBUDDY_RESPONSE' }],
    message: { role: 'assistant', usage },
    providerData: {
      requestModelId: model,
      usage,
      ...(rawUsage ? { rawUsage } : {}),
      conversationRequestId: 'not-the-request-dedup-key',
    },
  };
}

function userRecord() {
  return {
    id: 'user-1',
    timestamp: '2026-08-10T00:50:00.000Z',
    type: 'message',
    role: 'user',
    cwd: '/private/repo/actual-project',
    content: [{ type: 'text', text: 'PRIVATE_WORKBUDDY_PROMPT' }],
    message: { role: 'user' },
  };
}

test('WorkBuddy is registered and honors path-delimited fixture roots', () => {
  const prior = process.env.VIBE_USAGE_WORKBUDDY_DIRS;
  process.env.VIBE_USAGE_WORKBUDDY_DIRS = ['/tmp/workbuddy-a', '/tmp/workbuddy-b'].join(delimiter);
  try {
    assert.equal(typeof parsers.workbuddy, 'function');
    assert.equal(TOOLS.find(tool => tool.id === 'workbuddy')?.name, 'WorkBuddy');
    assert.deepEqual(findWorkbuddyDataDirs(), ['/tmp/workbuddy-a', '/tmp/workbuddy-b']);
  } finally {
    if (prior === undefined) delete process.env.VIBE_USAGE_WORKBUDDY_DIRS;
    else process.env.VIBE_USAGE_WORKBUDDY_DIRS = prior;
  }
});

test('WorkBuddy maps routed models, exclusive usage, deduplicated requests, and sessions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-workbuddy-'));
  const firstProject = join(root, 'projects', 'encoded-project');
  const copiedProject = join(root, 'projects', 'copied-project');
  mkdirSync(firstProject, { recursive: true });
  mkdirSync(copiedProject, { recursive: true });

  const hy3 = assistantRecord({
    id: 'request-hy3',
    model: 'hy3',
    timestamp: '2026-08-10T00:50:10.000Z',
    usage: {
      inputTokens: 34824,
      outputTokens: 31,
      inputTokensDetails: [{ cached_tokens: 7488 }],
      outputTokensDetails: [{ reasoning_tokens: 27 }],
    },
    rawUsage: {
      prompt_tokens: 34824,
      prompt_cache_hit_tokens: 7488,
      prompt_cache_miss_tokens: 27336,
      completion_tokens: 31,
      completion_thinking_tokens: 27,
    },
  });
  const autoRouted = assistantRecord({
    id: 'request-auto-routed',
    model: 'model-routed-by-auto',
    timestamp: '2026-08-10T00:50:20.000Z',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40 },
  });
  const pending = assistantRecord({
    id: 'request-pending',
    model: 'must-not-count',
    timestamp: '2026-08-10T00:50:25.000Z',
    usage: { inputTokens: 100, outputTokens: 20 },
    status: 'pending',
  });

  writeFileSync(join(firstProject, 'session-a.jsonl'), [
    JSON.stringify(userRecord()),
    JSON.stringify(hy3),
    JSON.stringify(autoRouted),
    JSON.stringify(pending),
    '{malformed',
  ].join('\n') + '\n');
  writeFileSync(join(copiedProject, 'session-a.jsonl'), JSON.stringify(hy3) + '\n');

  const prior = process.env.VIBE_USAGE_WORKBUDDY_DIRS;
  process.env.VIBE_USAGE_WORKBUDDY_DIRS = root;
  try {
    const result = await parse();
    assert.equal(result.buckets.length, 2);
    const byModel = Object.fromEntries(result.buckets.map(bucket => [bucket.model, bucket]));
    assert.deepEqual(byModel.hy3, {
      source: 'workbuddy',
      model: 'hy3',
      project: 'actual-project',
      bucketStart: '2026-08-10T00:30:00.000Z',
      inputTokens: 27336,
      outputTokens: 4,
      cachedInputTokens: 7488,
      reasoningOutputTokens: 27,
      totalTokens: 27367,
    });
    assert.deepEqual(byModel['model-routed-by-auto'], {
      source: 'workbuddy',
      model: 'model-routed-by-auto',
      project: 'actual-project',
      bucketStart: '2026-08-10T00:30:00.000Z',
      inputTokens: 60,
      outputTokens: 20,
      cachedInputTokens: 40,
      reasoningOutputTokens: 0,
      totalTokens: 80,
    });
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].project, 'actual-project');
    assert.equal(result.sessions[0].messageCount, 3);
    assert.equal(result.sessions[0].userMessageCount, 1);
    assert.equal(result.sessions[0].activeSeconds, 10);

    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('PRIVATE_WORKBUDDY'), false);
    assert.equal(serialized.includes('/private/repo'), false);
  } finally {
    if (prior === undefined) delete process.env.VIBE_USAGE_WORKBUDDY_DIRS;
    else process.env.VIBE_USAGE_WORKBUDDY_DIRS = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
