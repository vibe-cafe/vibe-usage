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
    if (endpoint === 'export-usage-events-csv') {
      const csv = typeof web.csv === 'function' ? web.csv(url.searchParams, init) : web.csv;
      return csv instanceof Response ? csv.clone() : new Response(csv);
    }
    if (endpoint === 'query-billing-items') {
      web.billingRequests.push({ params: url.searchParams, init });
      return web.billing(url.searchParams);
    }
    assert.equal(endpoint, 'get-filtered-usage-events');
    return web.events instanceof Response ? web.events.clone() : Response.json({ usageEventsDisplay: web.events });
  });
  return web;
}

const read = (prev = previousInfo) => parse({ previousInfo: prev, envProxyBlock: null });
const current = item('current', NOW - 2 * 3600_000);
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
  assert.deepEqual(web.calls, ['export-usage-events-csv', ...Array(2 + Math.ceil((RECENT - FLOOR) / (7 * DAY))).fill('query-billing-items')]);
  assert.equal(web.billingRequests[1].params.get('cursor'), cursor);
  assert.equal(web.billingRequests.at(-1).params.get('startTime'), iso(FLOOR));
  for (const { params, init } of web.billingRequests) {
    assert.equal(params.get('scope'), 'user');
    assert.equal(params.get('product'), 'cursor');
    assert.equal(params.get('pageSize'), '500');
    const span = Date.parse(params.get('endTime')) - Date.parse(params.get('startTime'));
    if (params.get('startTime') !== iso(RECENT)) assert.ok(span <= 7 * DAY);
    const headers = new Headers(init.headers);
    assert.equal(headers.get('cookie'), 'WorkosCursorSessionToken=fixture%3A%3A' + token);
    assert.equal(headers.get('x-cursor-dashboard-surface'), 'v2');
    assert.equal(headers.get('accept'), 'application/json');
    assert.equal(headers.get('origin'), 'https://cursor.com');
    assert.match(headers.get('user-agent'), /Mozilla/);
    assert.match(headers.get('referer'), /dashboard/);
  }
  web.calls.length = 0;
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

test('Billing V2 checkpoints complete weekly blocks and retries an incomplete history page', async t => {
  const web = dashboard(t);
  const boundary = RECENT - 7 * DAY;
  const rows = [current, item('edge', boundary), item('before', boundary - 1)];
  let fail = false;
  web.billing = params => {
    const start = Date.parse(params.get('startTime'));
    const end = Date.parse(params.get('endTime'));
    if (start === boundary) web.now += 41_000;
    if (fail && end === boundary) {
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

for (const [label, reply, failure] of [
  ['challenge', () => new Response('<html>challenge</html>'), 'invalid_page'],
  ['missing team', () => Response.json({ availability: 'missing_team_id' }), 'invalid_page'],
  ['invalid page', () => Response.json({ data: [current], pagination: 'unknown' }), 'invalid_page'],
  ['network', () => { throw new Error('private transport detail'); }, 'network'],
  ['HTTP 503', () => new Response(null, { status: 503 }), 'http_503'],
  ['empty page', () => Response.json({ data: [], pagination: {} })],
]) {
  test('unusable Billing V2 falls back to web events: ' + label, async t => {
    const web = dashboard(t);
    web.billing = reply;
    web.events = [eventsRow];
    const result = await read();
    assert.deepEqual(web.calls, ['export-usage-events-csv', 'query-billing-items', 'get-filtered-usage-events']);
    assert.deepEqual(result.buckets.map(b => [b.model, b.outputTokens]), [['default', 3]]);
    assert.equal(result.info.billingFailure, failure);
  });
}

for (const status of [401, 403]) {
  test('a legacy account keeps its CSV or events after an optional Billing V2 HTTP ' + status, async t => {
    const web = dashboard(t);
    web.billing = () => new Response(null, { status });
    const idle = await read({ ...previousInfo, latestTokenAt: iso(NOW - 8 * DAY) });
    assert.deepEqual(web.calls, ['export-usage-events-csv', 'query-billing-items', 'get-filtered-usage-events']);
    assert.equal(idle.info.billingFailure, 'http_' + status);
    assert.equal(idle.info.latestTokenAt, iso(NOW - 8 * DAY));
    assert.deepEqual(idle.warnings, []);
    web.csv += '\n' + iso(NOW - 3 * DAY) + ',csv,2';
    web.events = new Response(null, { status });
    const stale = await read();
    assert.deepEqual(stale.buckets.map(b => b.model), ['csv']);
    assert.equal(stale.info.billingFailure, 'http_' + status);
    assert.deepEqual(stale.warnings, []);
    assert.equal(web.calls.at(-1), 'get-filtered-usage-events');
  });

  test('pinned V2 HTTP ' + status + ' uses a recovered CSV or follows the sign-in path', async t => {
    const web = dashboard(t);
    const pinned = { ...previousInfo, billingAccounts: ['other', previousInfo.account] };
    web.billing = () => new Response(null, { status });
    web.csv = header + '\n' + iso(NOW - DAY / 2) + ',legacy,9';
    const recovered = await read(pinned);
    assert.deepEqual(web.calls, ['query-billing-items', 'export-usage-events-csv']);
    assert.deepEqual(recovered.buckets.map(b => b.model), ['legacy']);
    assert.deepEqual(recovered.info.billingAccounts, ['other']);
    web.calls.length = 0;
    await read(recovered.info);
    assert.deepEqual(web.calls, ['export-usage-events-csv']);
    web.csv = header;
    web.events = new Response(null, { status });
    const idle = await read(pinned);
    assert.deepEqual(idle.info.billingAccounts, pinned.billingAccounts);
    assert.equal(idle.info.billingFailure, 'http_' + status);
    assert.doesNotMatch(idle.warnings.join(' '), /登录已失效/);
    web.csv = new Response(null, { status });
    const ended = await read(pinned);
    assert.equal(ended.info, undefined);
    assert.match(ended.warnings[0], /登录已失效/);
  });
}

test('only an empty CSV and a token at least two hours old select Billing V2', async t => {
  const web = dashboard(t);
  const recent = item('lag', NOW - 2 * 3600_000 + 1);
  const model = 'Claude 4.5 Sonnet (Thinking)';
  web.billing = () => Response.json({ data: [{ ...recent, displayExtras: { model } }], pagination: {} });
  const lag = await read();
  assert.equal(lag.info.billingAccounts, undefined);
  assert.deepEqual(lag.buckets.map(b => b.model), [model]);
  assert.deepEqual(web.calls, ['export-usage-events-csv', 'query-billing-items']);
  web.billing = () => Response.json({ data: [current], pagination: {} });
  for (const csv of ['', 'unrecognized', header + '\n' + iso(NOW - DAY) + ',csv,0']) {
    web.csv = csv;
    assert.equal((await read()).info.billingAccounts, undefined);
  }
  web.csv = header;
  assert.deepEqual((await read()).info.billingAccounts, [previousInfo.account]);
});

test('Billing V2 skips and counts unusable token rows while preserving usable models and counts', async t => {
  const web = dashboard(t);
  const at = NOW - DAY;
  const model = 'Claude 4.5 Sonnet (Thinking)';
  web.billing = params => Response.json({ data: params.get('startTime') === iso(RECENT) ? [
    item('no-model', at, { displayExtras: {} }), item('unknown-tokens', at, { totalTokens: 15, usage: {} }),
    item('ordinary-empty', at, { usage: {} }), item('good', at, { displayExtras: { model } }),
  ] : [], pagination: {} });
  const result = await read();
  assert.deepEqual(result.buckets.map(b => [b.model, b.outputTokens]), [[model, 3]]);
  assert.equal(result.info.billingSkippedRows, 2);
  assert.deepEqual(result.warnings, ['cursor: Billing V2 跳过 2 条缺少模型名或 token 明细的用量记录。']);
  assert.equal(result.info.tokenEvents, 1);
});

test('a pinned account with an empty Billing V2 week keeps its anchor and requests only V2', async t => {
  const web = dashboard(t);
  const result = await read({ ...previousInfo, latestTokenAt: iso(NOW - 8 * DAY), billingAccounts: [previousInfo.account],
    billingCsvChecks: { [previousInfo.account]: { at: iso(NOW), form: 0 } } });
  assert.deepEqual(web.calls, ['query-billing-items']);
  assert.deepEqual(result.buckets, []);
  assert.equal(result.info.latestTokenAt, iso(NOW - 8 * DAY));
});

test('a selected account checks the recent CSV once per day and returns to a recovered export', async t => {
  const web = dashboard(t);
  web.billing = () => Response.json({ data: [current], pagination: {} });
  let info = (await read()).info;
  const ranges = [];
  let recovered = false;
  web.csv = params => {
    ranges.push([Number(params.get('startDate')), Number(params.get('endDate'))]);
    return recovered ? header + '\n' + iso(web.now - 60_000) + ',legacy,11' : header;
  };
  web.now += DAY - 1;
  info = (await read(info)).info;
  assert.deepEqual(ranges, []);
  web.now++;
  const idle = await read(info);
  assert.deepEqual(idle.info.billingAccounts, [previousInfo.account]);
  assert.deepEqual(idle.buckets.map(b => b.model), ['cursor-grok-4.6-medium']);
  assert.deepEqual(ranges, [[RECENT + DAY, NOW + DAY]]);
  recovered = true;
  web.now += DAY - 1;
  info = (await read(idle.info)).info;
  assert.equal(ranges.length, 1);
  web.now++;
  const restored = await read(info);
  assert.deepEqual(ranges[1], [RECENT + 2 * DAY, NOW + 2 * DAY]);
  assert.equal(restored.info.billingAccounts, undefined);
  assert.deepEqual(restored.buckets.map(b => [b.model, b.outputTokens]), [['legacy', 11]]);
  web.calls.length = 0;
  await read(restored.info);
  assert.deepEqual(web.calls, ['export-usage-events-csv']);
});

test('daily CSV checks are independent across account switches and old selections without a timestamp', async t => {
  const web = dashboard(t);
  const other = 'grok|different';
  const otherToken = 'h.' + Buffer.from(JSON.stringify({ sub: other })).toString('base64url') + '.s';
  let info = { ...previousInfo, billingAccounts: [previousInfo.account, other] };
  web.csv = new Response(null, { status: 403 });
  async function syncAs(accessToken) {
    setProvidedCursorLogin(JSON.stringify({ accessToken }));
    web.calls.length = 0;
    // An account switch starts history; crossing the budget keeps this test on recent reads.
    web.billing = () => { web.now += 40_000; return Response.json({ data: [], pagination: {} }); };
    info = (await read(info)).info;
    assert.equal(info.billingAccounts.length, 2);
    return web.calls.filter(c => c === 'export-usage-events-csv').length;
  }
  assert.equal(await syncAs(token), 1);
  web.now = NOW + DAY / 2;
  assert.equal(await syncAs(otherToken), 1);
  assert.equal(await syncAs(token), 0);
  web.now = NOW + DAY;
  assert.equal(await syncAs(token), 1);
  assert.equal(await syncAs(otherToken), 0);
});

test('the daily check reuses the CSV credential form that returned the recognized header', async t => {
  const web = dashboard(t);
  const shortCookie = 'WorkosCursorSessionToken=fixture%3A%3A' + token;
  let csv = header;
  web.csv = (_, init) => init.headers.Cookie === shortCookie ? csv : new Response(null, { status: 401 });
  web.billing = () => Response.json({ data: [current], pagination: {} });
  const first = await read();
  assert.deepEqual(first.info.billingAccounts, [previousInfo.account]);
  web.calls.length = 0;
  web.now += DAY;
  csv += '\n' + iso(NOW - 2 * DAY) + ',legacy,7';
  const recovered = await read(first.info);
  assert.deepEqual(web.calls, ['query-billing-items', 'export-usage-events-csv']);
  assert.deepEqual(recovered.buckets.map(b => b.model), ['legacy', 'cursor-grok-4.6-medium']);
  assert.equal(recovered.info.billingAccounts, undefined);
});

for (const status of [401, 403]) {
  test('recent V2 survives history HTTP ' + status + ' and retries the same week', async t => {
    const web = dashboard(t);
    const backfill = { before: iso(RECENT), until: iso(RECENT - 7 * DAY) };
    let blocked = true;
    web.billing = params => {
      if (params.get('startTime') === iso(RECENT)) return Response.json({ data: [current], pagination: {} });
      return blocked ? new Response(null, { status }) : Response.json({ data: [item('old', RECENT - DAY)], pagination: {} });
    };
    const paused = await read({ ...previousInfo, billingAccounts: [previousInfo.account], backfill });
    assert.deepEqual(paused.buckets.map(b => b.outputTokens), [3]);
    assert.deepEqual(paused.info.backfill, backfill);
    assert.equal(paused.info.billingFailure, 'http_' + status);
    assert.match(paused.warnings.join(' '), /历史补齐本次暂停/);
    assert.doesNotMatch(paused.warnings.join(' '), /登录已失效|sign in again/i);
    blocked = false;
    const resumed = await read(paused.info);
    assert.equal(resumed.info.backfill, undefined);
    assert.equal(resumed.info.tokenEvents, 2);
  });
}

test('first Billing V2 selection retains the pre-October CSV checkpoint across the budget boundary', async t => {
  const web = dashboard(t);
  const before = FLOOR - 10 * DAY, until = before - 2 * DAY;
  const calls = [];
  web.csv = params => {
    calls.push([Number(params.get('startDate')), Number(params.get('endDate'))]);
    return calls.length <= 1 ? header : header + '\n' + iso(until) + ',legacy,41';
  };
  web.billing = params => {
    if (params.get('startTime') === iso(FLOOR)) web.now += 40_000;
    return Response.json({ data: [current, item('cut', FLOOR)], pagination: {} });
  };
  const first = await read({ ...previousInfo, backfill: { before: iso(before), until: iso(until) } });
  assert.deepEqual(first.info.backfill, { before: iso(before), until: iso(until) });
  assert.deepEqual(first.buckets.map(b => b.outputTokens), [3, 3]);
  const next = await read(first.info);
  assert.deepEqual(calls, [[RECENT, NOW], [until, before - 1]]);
  assert.deepEqual(next.buckets.map(b => b.model), ['cursor-grok-4.6-medium', 'legacy']);
  assert.equal(next.info.backfill, undefined);
});

test('weekly history switches to inclusive CSV bounds just before October and resumes both ranges', async t => {
  const web = dashboard(t);
  let delay = true;
  web.billing = params => {
    if (delay && params.get('startTime') === iso(RECENT - 7 * DAY)) web.now += 40_000;
    return Response.json({ data: [current, item('edge', FLOOR)], pagination: {} });
  };
  const until = FLOOR - 2 * DAY;
  const first = await read({ ...previousInfo, backfill: { before: iso(RECENT), until: iso(until) } });
  assert.equal(first.info.backfill.before, iso(RECENT - 7 * DAY));
  delay = false;
  const csvCalls = [];
  web.csv = params => {
    csvCalls.push([Number(params.get('startDate')), Number(params.get('endDate'))]);
    return header + '\n' + iso(FLOOR - 1) + ',legacy,7';
  };
  const next = await read(first.info);
  assert.equal(next.info.backfill, undefined);
  assert.deepEqual(csvCalls, [[until, FLOOR - 1]]);
  assert.deepEqual(next.buckets.map(b => [b.model, b.outputTokens]),
    [['cursor-grok-4.6-medium', 3], ['cursor-grok-4.6-medium', 3], ['legacy', 7]]);
});

test('a stale CSV keeps its last half hour whole and fills only later windows from Billing V2', async t => {
  const web = dashboard(t);
  const stale = NOW - 3 * DAY;
  web.csv += '\n' + iso(stale) + ',csv,9';
  web.billing = () => Response.json({ data: [item('same-window', stale + 1), current], pagination: {} });
  const result = await read();
  assert.deepEqual(web.calls, ['export-usage-events-csv', 'query-billing-items']);
  assert.deepEqual(result.buckets.map(b => [b.model, b.outputTokens]), [['csv', 9], ['cursor-grok-4.6-medium', 3]]);
});
