import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateToBuckets, normalizeModelName } from '../src/parsers/index.js';

function entry(overrides = {}) {
  return {
    source: 'claude-code',
    model: 'claude-opus-4.8',
    project: '/repo/x',
    timestamp: new Date('2026-06-29T12:05:00Z'),
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    ...overrides,
  };
}

test('aggregateToBuckets clamps summed token fields to non-negative integers', () => {
  const buckets = aggregateToBuckets([
    entry({ inputTokens: 1.5, outputTokens: 0.02, cachedInputTokens: NaN, reasoningOutputTokens: -3 }),
    entry({ inputTokens: 1.25, outputTokens: 3.35 }),
  ]);

  assert.deepEqual(buckets.map(b => ({
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    cachedInputTokens: b.cachedInputTokens,
    reasoningOutputTokens: b.reasoningOutputTokens,
    totalTokens: b.totalTokens,
  })), [{
    inputTokens: 3,          // 1.5 + 1.25 = 2.75 → 3
    outputTokens: 3,         // 0.02 + 3.35 = 3.37 → 3
    cachedInputTokens: 0,    // NaN → 0
    reasoningOutputTokens: 0, // negative → 0
    totalTokens: 6,
  }]);
});

test('aggregateToBuckets truncates model and project to server varchar limits', () => {
  const buckets = aggregateToBuckets([
    entry({ model: 'm'.repeat(150), project: 'p'.repeat(250), inputTokens: 1 }),
  ]);

  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].model, 'm'.repeat(100));
  assert.equal(buckets[0].project, 'p'.repeat(200));
});

test('aggregateToBuckets preserves a pre-set hostname sentinel and omits it otherwise', () => {
  const buckets = aggregateToBuckets([
    entry({ source: 'cursor', hostname: 'cursor-cloud', inputTokens: 1 }),
    entry({ inputTokens: 1 }),
  ]);

  const cursor = buckets.find(b => b.source === 'cursor');
  const local = buckets.find(b => b.source === 'claude-code');
  assert.equal(cursor.hostname, 'cursor-cloud');
  assert.equal('hostname' in local, false);
});

test('aggregateToBuckets keeps distinct hostnames in distinct buckets', () => {
  const buckets = aggregateToBuckets([
    entry({ source: 'cursor', hostname: 'cursor-cloud', inputTokens: 1 }),
    entry({ source: 'cursor', hostname: 'cursor-cloud', inputTokens: 2 }),
    entry({ source: 'cursor', inputTokens: 4 }),
  ]);

  assert.deepEqual(buckets.map(b => ({ hostname: b.hostname, inputTokens: b.inputTokens })), [
    { hostname: 'cursor-cloud', inputTokens: 3 },
    { hostname: undefined, inputTokens: 4 },
  ]);
});

test('normalizeModelName strips provider prefixes', () => {
  assert.equal(normalizeModelName('moonshot/kimi-k3'), 'kimi-k3');
  assert.equal(normalizeModelName('moonshotai/kimi-k3'), 'kimi-k3');
  assert.equal(normalizeModelName('anthropic/claude-opus-4.8'), 'claude-opus-4.8');
  assert.equal(normalizeModelName('openai/gpt-5.6-sol'), 'gpt-5.6-sol');
});

test('normalizeModelName maps known aliases to canonical names', () => {
  assert.equal(normalizeModelName('k3'), 'kimi-k3');
  assert.equal(normalizeModelName('moonshot/k3'), 'kimi-k3');
});

test('normalizeModelName passes through already-canonical names', () => {
  assert.equal(normalizeModelName('kimi-k3'), 'kimi-k3');
  assert.equal(normalizeModelName('claude-opus-4.8'), 'claude-opus-4.8');
  assert.equal(normalizeModelName('gpt-5.6-sol'), 'gpt-5.6-sol');
});

test('aggregateToBuckets merges alias variants into a single bucket', () => {
  const buckets = aggregateToBuckets([
    entry({ model: 'k3', inputTokens: 100 }),
    entry({ model: 'kimi-k3', inputTokens: 200 }),
    entry({ model: 'moonshot/kimi-k3', inputTokens: 300 }),
    entry({ model: 'moonshotai/kimi-k3', inputTokens: 400 }),
  ]);

  const kimiBuckets = buckets.filter(b => b.model === 'kimi-k3');
  assert.equal(kimiBuckets.length, 1);
  assert.equal(kimiBuckets[0].inputTokens, 1000);
});
