import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parsers/cursor.js';
import { roundToHalfHour } from '../src/parsers/aggregate.js';
import { resetProvidedCursorLoginForTests, setProvidedCursorLogin } from '../src/cursor-login.js';

const DAY = 86400_000;
const NOW = Date.parse('2026-11-28T15:05:00Z');
const RECENT = roundToHalfHour(new Date(NOW - 7 * DAY)).getTime();
const FLOOR = Date.parse('2026-10-01T00:00:00Z');
const header = 'Date,Model,Output Tokens';
const token = 'header.' + Buffer.from(JSON.stringify({ sub: 'grok|fixture' })).toString('base64url') + '.sig';
const iso = ms => new Date(ms).toISOString();
const previousInfo = { account: 'grok|fixture', syncedAt: iso(NOW - DAY) };

function item(id, at, overrides) {
  return {
    billingItemId: id, eventTime: iso(at), displayExtras: { model: 'cursor-grok-4.6-medium' },
    product: 'cursor', chargeCategory: 'usage', pricing: { contracted: 0 },
    usage: { 'prompt-text-tokens': 12, 'completion-text-tokens': 3, 'cached-prompt-text-tokens': 420, 'cache-write-text-tokens': '2' },
    ...overrides,
  };
}

function dashboard(t) {
  assert.ok(setProvidedCursorLogin(JSON.stringify({ accessToken: token })));
  t.after(resetProvidedCursorLoginForTests);
  const web = { now: NOW, calls: [], billingRequests: [], csv: header, billing: () => Response.json({ data: [], pagination: {} }), events: [] };
  t.mock.method(Date, 'now', () => web.now);
  t.mock.method(globalThis, 'fetch', async (raw, init) => {
    const url = new URL(raw);
    const endpoint = url.pathname.split('/').pop();
    web.calls.push(endpoint);
    if (endpoint === 'export-usage-events-csv') return new Response(web.csv);
    if (endpoint === 'query-billing-items') {
      web.billingRequests.push({ params: url.searchParams, init });
      return web.billing(url.searchParams);
    }
    assert.equal(endpoint, 'get-filtered-usage-events');
    return Response.json({ usageEventsDisplay: web.events });
  });
  return web;
}

const read = (prev = previousInfo) => parse({ previousInfo: prev, envProxyBlock: null });
const current = item('current', NOW - 60_000);
const eventsRow = { timestamp: NOW - 60_000, model: 'default', tokenUsage: { outputTokens: 3 } };

test('Billing V2 pages, deduplicates ids, and resumes completed CSV history to the subscription floor', async t => {
  const web = dashboard(t);
  const old = item('october', FLOOR);
  const cursor = 'another+/=';
  web.billing = params => {
    const start = Date.parse(params.get('startTime'));
    const end = Date.parse(params.get('endTime'));
    if (start === RECENT && !params.has('cursor')) {
      return Response.json({ data: [current], pagination: { nextCursor: cursor } });
    }
    const rows = [old, current, item('other', NOW - 60_000, { product: 'other' }),
      item('subscription', NOW - 60_000, { chargeCategory: 'subscription' }), item('empty', NOW - 60_000, { usage: {} })];
    return Response.json({ data: rows.filter(r => Date.parse(r.eventTime) >= start && Date.parse(r.eventTime) <= end), pagination: {} });
  };
  const first = await read();
  assert.deepEqual(first.buckets.map(b => [b.model, b.inputTokens, b.outputTokens, b.cachedInputTokens]),
    Array(2).fill(['cursor-grok-4.6-medium', 14, 3, 420]));
  assert.equal(first.info.tokenEvents, 2);
  assert.equal(first.info.backfill, undefined);
  assert.deepEqual(web.calls, ['export-usage-events-csv', ...Array(4).fill('query-billing-items')]);
  assert.equal(web.billingRequests[1].params.get('cursor'), cursor);
  assert.equal(web.billingRequests.at(-1).params.get('startTime'), iso(FLOOR));
  for (const { params, init } of web.billingRequests) {
    assert.equal(params.get('scope'), 'user');
    assert.equal(params.get('product'), 'cursor');
    assert.equal(params.get('pageSize'), '500');
    assert.ok(Date.parse(params.get('endTime')) - Date.parse(params.get('startTime')) <= 31 * DAY);
    const headers = new Headers(init.headers);
    assert.equal(headers.get('cookie'), 'WorkosCursorSessionToken=fixture%3A%3A' + token);
    assert.equal(headers.get('x-cursor-dashboard-surface'), 'v2');
    assert.equal(headers.get('accept'), 'application/json');
    assert.equal(headers.get('origin'), 'https://cursor.com');
    assert.match(headers.get('user-agent'), /Mozilla/);
    assert.match(headers.get('referer'), /dashboard/);
  }
  web.calls.length = 0;
  web.csv += '\n' + iso(NOW - 60_000) + ',csv-alias,3';
  const next = await read(first.info);
  assert.deepEqual(web.calls, ['query-billing-items', 'query-billing-items']);
  assert.equal(next.buckets[0].model, 'cursor-grok-4.6-medium');
  web.calls.length = 0;
  const other = 'h.' + Buffer.from(JSON.stringify({ sub: 'grok|different' })).toString('base64url') + '.s';
  setProvidedCursorLogin(JSON.stringify({ accessToken: other }));
  const otherAccount = await read(next.info);
  assert.equal(web.calls[0], 'export-usage-events-csv');
  web.calls.length = 0;
  setProvidedCursorLogin(JSON.stringify({ accessToken: token }));
  await read(otherAccount.info);
  assert.equal(web.calls[0], 'query-billing-items');
});

test('a fresh legacy export requests only CSV and keeps the serialized upload bucket', async t => {
  const web = dashboard(t);
  web.csv += '\n' + iso(NOW - 60_000) + ',auto,19';
  const result = await read();
  assert.deepEqual(web.calls, ['export-usage-events-csv']);
  assert.equal(JSON.stringify(result.buckets), JSON.stringify([{
    source: 'cursor', model: 'auto', project: 'unknown', hostname: 'cursor-cloud',
    bucketStart: roundToHalfHour(new Date(NOW - 60_000)).toISOString(),
    inputTokens: 0, outputTokens: 19, cachedInputTokens: 0, reasoningOutputTokens: 0,
    cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, totalTokens: 19,
  }]));
});

test('Billing V2 checkpoints complete 31-day blocks and retries an incomplete history page', async t => {
  const web = dashboard(t);
  const boundary = RECENT - 31 * DAY;
  const rows = [current, item('edge', boundary), item('before', boundary - 1)];
  let fail = false;
  web.billing = params => {
    const start = Date.parse(params.get('startTime'));
    const end = Date.parse(params.get('endTime'));
    if (start === boundary) web.now += 41_000;
    if (fail && start === FLOOR) {
      if (params.has('cursor')) return new Response(null, { status: 503 });
      return Response.json({ data: [item('incomplete', boundary - 1)], pagination: { nextCursor: 'next' } });
    }
    return Response.json({ data: rows.filter(r => Date.parse(r.eventTime) >= start && Date.parse(r.eventTime) <= end), pagination: {} });
  };
  const first = await read();
  assert.deepEqual(first.info.backfill, { before: iso(boundary), until: iso(FLOOR) });
  assert.equal(first.info.tokenEvents, 2);
  fail = true;
  const paused = await read(first.info);
  assert.deepEqual(paused.info.backfill, first.info.backfill);
  assert.equal(paused.buckets.length, 1);
  assert.equal(web.calls.at(-1), 'get-filtered-usage-events');
  assert.match(paused.warnings.join(' '), /历史补齐本次暂停/);
  fail = false;
  const resumed = await read(paused.info);
  assert.equal(resumed.info.backfill, undefined);
  assert.equal(resumed.info.tokenEvents, 2);
  assert.equal(resumed.buckets.at(-1).inputTokens, 14, 'the shared endpoint only belongs to the newer block');
});

for (const [label, reply] of [
  ['challenge', () => new Response('<html>challenge</html>')],
  ['missing team', () => Response.json({ availability: 'missing_team_id' })],
  ['invalid page', () => Response.json({ data: [current], pagination: 'unknown' })],
  ['HTTP 503', () => new Response(null, { status: 503 })],
  ['empty page', () => Response.json({ data: [], pagination: {} })],
]) {
  test('unusable Billing V2 falls back to web events: ' + label, async t => {
    const web = dashboard(t);
    web.billing = reply;
    web.events = [eventsRow];
    const result = await read();
    assert.deepEqual(web.calls, ['export-usage-events-csv', 'query-billing-items', 'get-filtered-usage-events']);
    assert.deepEqual(result.buckets.map(b => [b.model, b.outputTokens]), [['default', 3]]);
  });
}

for (const status of [401, 403]) {
  test('Billing V2 HTTP ' + status + ' follows the existing sign-in path, including a stale CSV probe', async t => {
    const web = dashboard(t);
    web.billing = () => new Response(null, { status });
    for (const csv of [header, header + '\n' + iso(NOW - 3 * DAY) + ',csv,2']) {
      web.calls.length = 0;
      web.csv = csv;
      const result = await read();
      assert.deepEqual(web.calls, ['export-usage-events-csv', 'query-billing-items']);
      assert.equal(result.info, undefined);
      assert.match(result.warnings[0], /登录已失效/);
    }
  });
}

test('a stale CSV keeps its last half hour whole and fills only later windows from Billing V2', async t => {
  const web = dashboard(t);
  const stale = NOW - 3 * DAY;
  web.csv += '\n' + iso(stale) + ',csv,9';
  web.billing = () => Response.json({ data: [item('same-window', stale + 1), current], pagination: {} });
  const result = await read();
  assert.deepEqual(web.calls, ['export-usage-events-csv', 'query-billing-items']);
  assert.deepEqual(result.buckets.map(b => [b.model, b.outputTokens]), [['csv', 9], ['cursor-grok-4.6-medium', 3]]);
});
