import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachCacheScope, loadCachedQuota, saveCachedQuota } from '../src/quotas/cache.js';
import { fetchQuotaProducts } from '../src/quotas/registry.js';
import { quotaResult } from '../src/quotas/schema.js';

const now = new Date('2026-09-15T12:00:00Z');
const dummyKey = 'synthetic-cache-regression-not-a-real-key';
const payload = { code: 200, success: true, data: {
  limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 25 }],
} };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'vbu-quota-cache-regression-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    path: join(root, 'quota-cache.json'),
    environment: { BIGMODEL_API_KEY: dummyKey, VIBE_USAGE_QUOTA_CACHE_DIR: root,
      HOME: root, PATH: root, GROK_HOME: join(root, 'absent-grok'), VIBE_USAGE_EGRESS_CHECK: '0' },
  };
}

function sample(overrides = {}) {
  return attachCacheScope(quotaResult({ id: 'zcode', status: 'ok', fetchedAt: now,
    meters: [{ id: 'five-hour', label: '5h', utilization: 25, windowSeconds: 18000 }],
    ...overrides }), `bigmodel:${dummyKey}`);
}

async function live(f) {
  const result = await fetchQuotaProducts(['zcode', 'grok'], {
    environment: f.environment, home: f.root, now,
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
  });
  assert.deepEqual(result.products.map(({ id, status, source }) => ({ id, status, source })), [
    { id: 'zcode', status: 'ok', source: 'live' },
    { id: 'grok', status: 'no_data', source: 'local' },
  ]);
  assert.equal(result.products[0].meters[0].utilization, 25);
  assert.equal(JSON.stringify(result).includes(dummyKey), false);
  return result;
}

for (const [name, contents] of [
  ['empty mapping', '{"version":1,"products":{}}'],
  ['broken JSON', '{broken'],
  ['null document', 'null'],
  ['array document', '[]'],
  ['missing products', '{"version":1}'],
  ['null products', '{"version":1,"products":null}'],
  ['array products', '{"version":1,"products":[]}'],
  ['numeric products', '{"version":1,"products":7}'],
  ['string products', '{"version":1,"products":"bad"}'],
  ['wrong version', '{"version":2,"products":{}}'],
]) {
  test(`disposable quota cache: ${name} preserves live results and repairs mapping`, async t => {
    const f = fixture(t);
    writeFileSync(f.path, contents);
    await live(f);
    const repaired = JSON.parse(readFileSync(f.path, 'utf8'));
    assert.equal(repaired.version, 1);
    assert.equal(Array.isArray(repaired.products), false);
    assert.equal(repaired.products.zcode.status, 'ok');
    assert.equal(repaired.products.zcode.meters[0].utilization, 25);
    assert.equal(JSON.stringify(repaired).includes(dummyKey), false);
    const cached = loadCachedQuota('zcode', sample().cacheScope, f.environment, now);
    assert.equal(cached?.source, 'cache');
  });
}

for (const mode of ['root-is-file', 'cache-is-directory', 'temporary-is-directory']) {
  test(`quota cache I/O failure (${mode}) cannot discard either product`, async t => {
    const f = fixture(t);
    if (mode === 'root-is-file') {
      const fileRoot = join(f.root, 'not-a-directory');
      writeFileSync(fileRoot, 'fixture');
      f.environment.VIBE_USAGE_QUOTA_CACHE_DIR = fileRoot;
    } else if (mode === 'cache-is-directory') {
      mkdirSync(f.path);
    } else {
      mkdirSync(`${f.path}.${process.pid}.tmp`);
    }
    await live(f);
    assert.equal(loadCachedQuota('zcode', sample().cacheScope, f.environment, now), null);
  });
}

test('quota cache path resolution failure is also disposable', async t => {
  const f = fixture(t);
  // Inject an invalid cache option, without reading/writing any host path.
  f.environment.VIBE_USAGE_QUOTA_CACHE_DIR = 42;
  await live(f);
  assert.equal(loadCachedQuota('zcode', sample().cacheScope, f.environment, now), null);
});

test('valid cache keeps other products and never serializes credential scope inputs', t => {
  const f = fixture(t);
  const first = attachCacheScope(quotaResult({ id: 'kimi-code', status: 'ok', fetchedAt: now,
    meters: [{ id: 'weekly', label: '7d', utilization: 10, windowSeconds: 604800 }] }), 'dummy-kimi-identity');
  saveCachedQuota(first, first.cacheScope, f.environment);
  const second = sample();
  saveCachedQuota(second, second.cacheScope, f.environment);
  assert.equal(loadCachedQuota(first.id, first.cacheScope, f.environment, now)?.meters[0].utilization, 10);
  assert.equal(loadCachedQuota(second.id, second.cacheScope, f.environment, now)?.meters[0].utilization, 25);
  const text = readFileSync(f.path, 'utf8');
  assert.equal(text.includes(dummyKey), false);
  assert.equal(text.includes('dummy-kimi-identity'), false);
});

test('ZCode cache is isolated across region, changed key, and deleted key', async t => {
  const f = fixture(t);
  await live(f);
  const offline = async () => { throw new Error('synthetic offline'); };
  const fetchWith = environment => fetchQuotaProducts(['zcode', 'grok'], {
    environment, home: f.root, now: new Date(now.getTime() + 60000), fetchImpl: offline,
  });
  const same = await fetchWith(f.environment);
  assert.equal(same.products[0].source, 'cache');
  for (const changed of [
    { ...f.environment, BIGMODEL_API_KEY: 'synthetic-other-key' },
    { ...f.environment, BIGMODEL_API_KEY: '', Z_AI_API_KEY: dummyKey },
  ]) {
    const result = await fetchWith(changed);
    assert.equal(result.products[0].status, 'retryable_error');
    assert.equal(result.products[0].source, 'live');
    assert.equal(result.products[1].status, 'no_data');
  }
  const deleted = await fetchWith({ ...f.environment, BIGMODEL_API_KEY: '' });
  assert.equal(deleted.products[0].status, 'missing_credentials');
  assert.equal(deleted.products[0].source, 'live');
});

for (const [name, meters, later] of [
  ['age limit', [{ id: 'unbounded', label: 'Usage', utilization: 25 }], 8 * 86400000],
  ['window boundary', [{ id: 'short', label: '5h', utilization: 25, windowSeconds: 18000 }], 18000000],
  ['reset boundary', [{ id: 'reset', label: 'Usage', utilization: 25,
    resetsAt: new Date(now.getTime() + 60000).toISOString() }], 60000],
]) {
  test(`expired quota cache cannot resurrect a success at ${name}`, async t => {
    const f = fixture(t);
    const result = sample({ meters });
    saveCachedQuota(result, result.cacheScope, f.environment);
    const fetched = await fetchQuotaProducts(['zcode', 'grok'], {
      environment: f.environment, home: f.root, now: new Date(now.getTime() + later),
      fetchImpl: async () => { throw new Error('synthetic offline'); },
    });
    assert.equal(fetched.products[0].status, 'retryable_error');
    assert.equal(fetched.products[0].source, 'live');
    assert.equal(fetched.products[1].status, 'no_data');
  });
}

test('malformed cached meters are misses, not aggregate failures', async t => {
  const f = fixture(t);
  writeFileSync(f.path, JSON.stringify({ version: 1, products: {
    zcode: { ...sample(), scope: sample().cacheScope, meters: [null] },
  } }));
  const result = await fetchQuotaProducts(['zcode', 'grok'], {
    environment: f.environment, home: f.root, now,
    fetchImpl: async () => { throw new Error('synthetic offline'); },
  });
  assert.deepEqual(result.products.map(p => p.status), ['retryable_error', 'no_data']);
});
