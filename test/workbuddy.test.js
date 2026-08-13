import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from '../src/parsers/workbuddy.js';
import { findWorkbuddyDataDirs } from '../src/workbuddy-roots.js';

function assistantRecord({
  id,
  modelId,
  modelName,
  status = 'completed',
  timestamp = '2026-08-11T10:05:00.000Z',
  usage,
  rawUsage,
  prompt,
  cwd,
}) {
  return {
    type: 'message',
    id,
    status,
    timestamp,
    cwd,
    prompt,
    message: { role: 'assistant', usage },
    providerData: {
      requestModelId: modelId,
      requestModelName: modelName,
      usage,
      rawUsage,
    },
  };
}

async function withRoots(roots, fn) {
  const previous = process.env.VIBE_USAGE_WORKBUDDY_DIRS;
  process.env.VIBE_USAGE_WORKBUDDY_DIRS = roots.join(delimiter);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.VIBE_USAGE_WORKBUDDY_DIRS;
    else process.env.VIBE_USAGE_WORKBUDDY_DIRS = previous;
  }
}

function writeFixture(root, lines, project = 'demo-project') {
  const projects = join(root, 'projects', project);
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, 'conversation.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}

function userRecord({ id, sessionId, timestamp, cwd, prompt }) {
  return {
    type: 'message',
    id,
    sessionId,
    timestamp,
    cwd,
    prompt,
    message: { role: 'user' },
  };
}

const sampleUsage = {
  inputTokens: 34824,
  outputTokens: 31,
  totalTokens: 34855,
  input_details: { cached_tokens: 7488 },
  output_details: { reasoning_tokens: 27 },
};

const sampleRawUsage = {
  prompt_cache_miss_tokens: 27336,
  completion_thinking_tokens: 27,
};

test('maps WorkBuddy 5.3.11 provider usage into exclusive token fields', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-workbuddy-mapping-'));
  try {
    writeFixture(root, [JSON.stringify(assistantRecord({
      id: 'request-1', modelId: 'minimax-m2', usage: sampleUsage, rawUsage: sampleRawUsage,
    }))]);
    const result = await withRoots([root], () => parse());
    assert.deepEqual(result.buckets[0], {
      source: 'workbuddy', model: 'minimax-m2', project: 'demo-project',
      bucketStart: '2026-08-11T10:00:00.000Z', inputTokens: 27336,
      outputTokens: 4, cachedInputTokens: 7488, reasoningOutputTokens: 27,
      totalTokens: 27367,
    });
    assert.deepEqual(result.sessions, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('splits Auto sessions by request model id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-workbuddy-models-'));
  try {
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    writeFixture(root, [
      JSON.stringify(assistantRecord({ id: 'a', modelId: 'model-a', modelName: 'Auto', usage })),
      JSON.stringify(assistantRecord({ id: 'b', modelId: 'model-b', modelName: 'Auto', usage, timestamp: '2026-08-11T10:06:00.000Z' })),
    ]);
    const result = await withRoots([root], () => parse());
    assert.deepEqual(result.buckets.map(({ model, inputTokens, outputTokens }) => ({ model, inputTokens, outputTokens })), [
      { model: 'model-a', inputTokens: 10, outputTokens: 2 },
      { model: 'model-b', inputTokens: 10, outputTokens: 2 },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deduplicates repeated top-level record ids', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-workbuddy-dedup-'));
  try {
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    const record = JSON.stringify(assistantRecord({ id: 'same', modelId: 'model-a', usage }));
    writeFixture(root, [record, record]);
    const result = await withRoots([root], () => parse());
    assert.equal(result.buckets[0].inputTokens, 10);
    assert.equal(result.buckets[0].outputTokens, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('counts completed assistant messages, skips malformed lines, and preserves privacy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-workbuddy-status-'));
  try {
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    const pending = assistantRecord({ id: 'pending', modelId: 'model-a', usage, status: 'pending' });
    const complete = assistantRecord({
      id: 'complete', modelId: 'model-a', usage,
      prompt: 'super secret prompt', cwd: '/Users/private/secret-project',
    });
    writeFixture(root, [JSON.stringify(pending), '{malformed', JSON.stringify(complete)]);
    const result = await withRoots([root], () => parse());
    assert.equal(result.buckets[0].inputTokens, 10);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('super secret prompt'), false);
    assert.equal(serialized.includes('/Users/private/secret-project'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('records only de-identified WorkBuddy session metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-workbuddy-sessions-'));
  try {
    const cwd = '/Users/private/absolute-workspace';
    const sessionId = 'private-workbuddy-session-id';
    const usage = { inputTokens: 10, outputTokens: 2 };
    writeFixture(root, [
      JSON.stringify(userRecord({
        id: 'prompt', sessionId, cwd, prompt: 'confidential prompt', timestamp: '2026-08-11T10:00:00.000Z',
      })),
      JSON.stringify({
        ...assistantRecord({
          id: 'reply', modelId: 'model-a', usage, cwd, timestamp: '2026-08-11T10:00:05.000Z',
        }),
        sessionId,
      }),
    ]);
    const result = await withRoots([root], () => parse());
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].project, 'absolute-workspace');
    assert.equal(result.sessions[0].messageCount, 2);
    assert.equal(result.sessions[0].userMessageCount, 1);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(cwd), false);
    assert.equal(serialized.includes(sessionId), false);
    assert.equal(serialized.includes('confidential prompt'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deduplicates timing records by stable record id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-workbuddy-event-dedup-'));
  try {
    const sessionId = 'session-with-copied-records';
    const cwd = '/private/workspace';
    const usage = { inputTokens: 10, outputTokens: 2 };
    const prompt = userRecord({
      id: 'copied-user', sessionId, cwd, timestamp: '2026-08-11T10:00:00.000Z',
    });
    const reply = {
      ...assistantRecord({
        id: 'copied-assistant', modelId: 'model-a', usage, cwd, timestamp: '2026-08-11T10:00:05.000Z',
      }),
      sessionId,
    };
    writeFixture(root, [JSON.stringify(prompt), JSON.stringify(reply), JSON.stringify(prompt), JSON.stringify(reply)]);
    const result = await withRoots([root], () => parse());
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].messageCount, 2);
    assert.equal(result.sessions[0].userMessageCount, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('honors path.delimiter-separated roots override', () => {
  const previous = process.env.VIBE_USAGE_WORKBUDDY_DIRS;
  process.env.VIBE_USAGE_WORKBUDDY_DIRS = ['/tmp/workbuddy-a', '/tmp/workbuddy-b'].join(delimiter);
  try { assert.deepEqual(findWorkbuddyDataDirs(), ['/tmp/workbuddy-a', '/tmp/workbuddy-b']); }
  finally {
    if (previous === undefined) delete process.env.VIBE_USAGE_WORKBUDDY_DIRS;
    else process.env.VIBE_USAGE_WORKBUDDY_DIRS = previous;
  }
});
