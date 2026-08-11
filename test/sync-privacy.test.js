import assert from 'node:assert/strict';
import test from 'node:test';
import { reaggregateHiddenProjectBuckets } from '../src/sync.js';

test('hidden-project buckets merge before upload-state and server identities collide', () => {
  const buckets = [
    {
      source: 'codex', model: 'gpt-test', project: 'project-a', hostname: 'host-a',
      bucketStart: '2026-08-12T00:00:00.000Z',
      inputTokens: 100, outputTokens: 10, cachedInputTokens: 1_000,
      reasoningOutputTokens: 5, totalTokens: 115,
    },
    {
      source: 'codex', model: 'gpt-test', project: 'project-b', hostname: 'host-a',
      bucketStart: '2026-08-12T00:00:00.000Z',
      inputTokens: 200, outputTokens: 20, cachedInputTokens: 2_000,
      reasoningOutputTokens: 10, totalTokens: 230,
    },
    {
      source: 'codex', model: 'gpt-test', project: 'project-c', hostname: 'host-b',
      bucketStart: '2026-08-12T00:00:00.000Z',
      inputTokens: 300, outputTokens: 30, cachedInputTokens: 3_000,
      reasoningOutputTokens: 15, totalTokens: 345,
    },
  ].map(bucket => ({ ...bucket, project: 'unknown' }));

  const result = reaggregateHiddenProjectBuckets(buckets);

  assert.equal(result.length, 2);
  const hostA = result.find(bucket => bucket.hostname === 'host-a');
  const hostB = result.find(bucket => bucket.hostname === 'host-b');
  assert.deepEqual(hostA, {
    source: 'codex', model: 'gpt-test', project: 'unknown', hostname: 'host-a',
    bucketStart: '2026-08-12T00:00:00.000Z',
    inputTokens: 300, outputTokens: 30, cachedInputTokens: 3_000,
    reasoningOutputTokens: 15, totalTokens: 345,
  });
  assert.deepEqual(hostB, {
    source: 'codex', model: 'gpt-test', project: 'unknown', hostname: 'host-b',
    bucketStart: '2026-08-12T00:00:00.000Z',
    inputTokens: 300, outputTokens: 30, cachedInputTokens: 3_000,
    reasoningOutputTokens: 15, totalTokens: 345,
  });
});
