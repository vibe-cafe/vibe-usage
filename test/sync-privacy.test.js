import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyHostnamePrivacy,
  migrateHiddenHostnameState,
  reaggregateHiddenProjectBuckets,
} from '../src/sync.js';
import { bucketHash, bucketKey } from '../src/state.js';

test('hidden projects merge before upload identities collide', () => {
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

test('hostname privacy replaces local values but preserves cloud sentinels', () => {
  const records = [
    { hostname: 'raw-workstation' },
    {},
    { hostname: 'cursor-cloud' },
  ];

  applyHostnamePrivacy(records, 'device-0011223344556677', false);

  assert.deepEqual(records, [
    { hostname: 'device-0011223344556677' },
    { hostname: 'device-0011223344556677' },
    { hostname: 'cursor-cloud' },
  ]);
});

test('hostname privacy migrates unchanged bucket state without re-uploading history', () => {
  const bucket = {
    source: 'codex',
    model: 'gpt-test',
    project: 'project',
    hostname: 'device-0011223344556677',
    bucketStart: '2026-08-12T00:00:00.000Z',
    inputTokens: 100,
    outputTokens: 10,
    cachedInputTokens: 1_000,
    reasoningOutputTokens: 5,
    totalTokens: 115,
  };
  const previous = { ...bucket, hostname: 'raw-workstation' };
  const state = {
    buckets: { [bucketKey(previous)]: bucketHash(previous) },
    sessions: {},
  };

  assert.equal(
    migrateHiddenHostnameState(
      state,
      [bucket],
      'raw-workstation',
      'device-0011223344556677',
    ),
    true,
  );
  assert.deepEqual(state.buckets, { [bucketKey(bucket)]: bucketHash(bucket) });
});
