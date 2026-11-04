import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cursor from '../src/parsers/cursor.js';
import { roundToHalfHour } from '../src/parsers/aggregate.js';

const TOKEN = `header.${Buffer.from(JSON.stringify({ sub: 'auth0|cursor-test-user' })).toString('base64url')}.test-signature`;
const TS = Date.parse('2026-09-07T01:02:00Z');
const CSV = [
  'Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens',
  '2026-09-07T01:02:00Z,test-model,10,20,30,40',
].join('\n');
const CSV_HEADER = 'Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens';

async function withCursorDb(t, { value = TOKEN } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-cursor-test-'));
  const dbPath = join(root, 'state.vscdb');
  const previous = process.env.CURSOR_STATE_DB_PATH;
  t.after(() => {
    if (previous === undefined) delete process.env.CURSOR_STATE_DB_PATH;
    else process.env.CURSOR_STATE_DB_PATH = previous;
    rmSync(root, { recursive: true, force: true });
  });

  const isBlob = value instanceof Uint8Array;
  const sqlValue = isBlob
    ? `x'${Buffer.from(value).toString('hex')}'`
    : `'${String(value).replace(/'/g, "''")}'`;
  const sql = `CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', ${sqlValue});`;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    // Exercise the same Node 20 fallback as the other SQLite parser fixtures.
  }
  if (DatabaseSync) {
    const db = new DatabaseSync(dbPath);
    try { db.exec(sql); } finally { db.close(); }
  } else {
    execFileSync('sqlite3', [dbPath, sql]);
  }
  process.env.CURSOR_STATE_DB_PATH = dbPath;
}

function event(overrides = {}) {
  return {
    timestamp: String(TS),
    model: 'test-model',
    tokenUsage: {
      inputTokens: 20,
      cacheWriteTokens: 10,
      cacheReadTokens: 30,
      outputTokens: 40,
    },
    ...overrides,
  };
}

function eventsPage(events, total = events.length) {
  return new Response(JSON.stringify({ totalUsageEventsCount: total, usageEventsDisplay: events }));
}

function networkError(code) {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('network failure'), { code }),
  });
}

/** Route the CSV endpoint and the events endpoint independently. */
function mockFetch(t, { csv, events } = {}) {
  return t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).includes('/api/dashboard/export-usage-events-csv')) {
      return typeof csv === 'function' ? csv(init, String(url)) : csv;
    }
    if (String(url).includes('/api/dashboard/get-filtered-usage-events')) {
      return typeof events === 'function' ? events(init, String(url)) : events;
    }
    throw new Error(`unexpected URL ${url}`);
  });
}

test('Cursor fetch timeout accepts positive integers and defaults invalid values', () => {
  assert.equal(typeof cursor.resolveCursorFetchTimeout, 'function');

  const cases = [
    [undefined, 120_000],
    ['', 120_000],
    ['0', 120_000],
    ['-1', 120_000],
    ['1.5', 120_000],
    ['Infinity', 120_000],
    ['2147483648', 120_000],
    ['45000', 45_000],
    ['300000', 300_000],
  ];

  for (const [value, expected] of cases) {
    assert.equal(cursor.resolveCursorFetchTimeout(value), expected);
  }
});

test('Cursor decodes TEXT, UTF-16LE BLOB, and sqlite3-CLI BLOB tokens', () => {
  assert.equal(cursor.decodeTokenValue(TOKEN), TOKEN);
  assert.equal(cursor.decodeTokenValue(Buffer.from(TOKEN, 'utf16le')), TOKEN);
  // `sqlite3 -json` turns a UTF-16LE BLOB into a JS string with interleaved NULs.
  const cliString = Buffer.from(TOKEN, 'utf16le').toString('latin1');
  assert.equal(cursor.decodeTokenValue(cliString), TOKEN);
  assert.equal(cursor.decodeTokenValue({ type: 'Buffer', data: [...Buffer.from(TOKEN, 'utf16le')] }), TOKEN);
  assert.equal(cursor.decodeTokenValue(''), null);
  assert.equal(cursor.decodeTokenValue(null), null);
});

test('Cursor reads the CSV export and keeps its model attribution', async (t) => {
  await withCursorDb(t);
  const fetchMock = mockFetch(t, { csv: new Response(CSV) });

  const result = await cursor.parse();
  assert.equal(fetchMock.mock.callCount(), 1);
  const [url, init] = fetchMock.mock.calls[0].arguments;
  assert.match(url, /\/api\/dashboard\/export-usage-events-csv\?strategy=tokens$/);
  assert.equal(init.headers.Cookie, `WorkosCursorSessionToken=auth0|cursor-test-user%3A%3A${TOKEN}`);

  assert.deepEqual(result.sessions, []);
  assert.deepEqual(result.buckets, [{
    source: 'cursor', model: 'test-model', project: 'unknown', hostname: 'cursor-cloud',
    bucketStart: '2026-09-07T01:00:00.000Z',
    inputTokens: 30, outputTokens: 40, cachedInputTokens: 30,
    reasoningOutputTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0,
    totalTokens: 70,
  }]);
  assert.equal(result.info.tokenEvents, 1);
  assert.equal(result.info.events, 1);
  assert.equal(result.info.latestEventAt, new Date(TS).toISOString());
  assert.match(result.info.account, /^auth0\|/);
});

test('Cursor fills a stale CSV gap from events without touching older history', async (t) => {
  await withCursorDb(t);
  const now = Date.now();
  const csvLatest = now - 2 * 24 * 60 * 60 * 1000;
  const eventTime = now - 60 * 60 * 1000;
  let eventBody;
  const fetchMock = mockFetch(t, {
    csv: new Response([
      CSV_HEADER,
      `${new Date(csvLatest).toISOString()},csv-model,1,2,3,4`,
    ].join('\n')),
    events: async (init) => {
      eventBody = JSON.parse(init.body);
      return eventsPage([event({
        usageEventId: 'gap-1',
        timestamp: String(eventTime),
        model: 'new-model',
        tokenUsage: { inputTokens: 100, cacheWriteTokens: 10, cacheReadTokens: 20, outputTokens: 5 },
      })]);
    },
  });

  const result = await cursor.parse();
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.equal(eventBody.startDate, String(csvLatest - 60 * 60 * 1000));
  assert.equal(result.buckets.length, 2);
  assert.equal(result.buckets.find(b => b.model === 'csv-model').inputTokens, 3);
  assert.equal(result.buckets.find(b => b.model === 'new-model').inputTokens, 110);
  assert.match(result.warnings[0], /CSV 最新 token 事件停在/);
  assert.equal(result.info.fallbackLatestAt, new Date(eventTime).toISOString());
  assert.equal(result.info.events, 2);
});

test('Cursor does not repeat a stale-CSV warning for the same gap', async (t) => {
  await withCursorDb(t);
  const now = Date.now();
  const csvLatest = now - 2 * 24 * 60 * 60 * 1000;
  const eventTime = now - 60 * 60 * 1000;
  mockFetch(t, {
    csv: new Response([
      CSV_HEADER,
      `${new Date(csvLatest).toISOString()},csv-model,1,2,3,4`,
    ].join('\n')),
    events: eventsPage([event({
      usageEventId: 'gap-1',
      timestamp: String(eventTime),
      model: 'new-model',
      tokenUsage: { inputTokens: 100, cacheWriteTokens: 10, cacheReadTokens: 20, outputTokens: 5 },
    })]),
  });

  const result = await cursor.parse({
    previousInfo: { fallbackLatestAt: new Date(eventTime).toISOString() },
  });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.buckets.length, 2);
});

test('Cursor keeps usable CSV data when the stale-gap probe fails', async (t) => {
  await withCursorDb(t);
  const csvLatest = Date.now() - 2 * 24 * 60 * 60 * 1000;
  mockFetch(t, {
    csv: new Response([
      CSV_HEADER,
      `${new Date(csvLatest).toISOString()},csv-model,1,2,3,4`,
    ].join('\n')),
    events: async () => { throw networkError('ECONNRESET'); },
  });

  const result = await cursor.parse();
  assert.equal(result.skipped, undefined);
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].model, 'csv-model');
  assert.deepEqual(result.warnings, []);
});

test('Cursor does not probe events while the CSV is fresh', async (t) => {
  await withCursorDb(t);
  const fetchMock = mockFetch(t, {
    csv: new Response([
      CSV_HEADER,
      `${new Date().toISOString()},csv-model,1,2,3,4`,
    ].join('\n')),
    events: async () => { throw new Error('events must not be called'); },
  });

  const result = await cursor.parse();
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(result.buckets.length, 1);
});

test('Cursor reads a token stored as a SQLite BLOB', async (t) => {
  await withCursorDb(t, { value: Buffer.from(TOKEN, 'utf16le') });
  mockFetch(t, { csv: (init) => {
    assert.ok(init.headers.Cookie.includes(encodeURIComponent(TOKEN)));
    return new Response(CSV);
  } });
  const result = await cursor.parse();
  assert.equal(result.buckets.length, 1);
  assert.match(result.info.account, /^auth0\|/);
});

test('Cursor falls back to the events API when the CSV is empty', async (t) => {
  await withCursorDb(t);
  const fetchMock = mockFetch(t, {
    csv: new Response(CSV_HEADER),
    events: eventsPage([event()]),
  });

  const result = await cursor.parse();
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].model, 'test-model');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /CSV 导出不可用/);
  assert.match(result.warnings[0], /事件接口/);
});

test('Cursor fallback only adds events newer than the previous sync', async (t) => {
  await withCursorDb(t);
  const previousLatest = Date.parse('2026-10-19T00:00:00Z');
  let requestBody;
  mockFetch(t, {
    csv: new Response(CSV_HEADER),
    events: async (init) => {
      requestBody = JSON.parse(init.body);
      return eventsPage([
        event({ usageEventId: 'old', timestamp: String(previousLatest - 3600_000), model: 'old-model' }),
        event({ usageEventId: 'new', timestamp: String(previousLatest + 3600_000), model: 'new-model' }),
      ]);
    },
  });

  const result = await cursor.parse({
    previousInfo: { latestEventAt: new Date(previousLatest).toISOString() },
  });
  assert.equal(requestBody.startDate, String(previousLatest - 3600_000));
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].model, 'new-model');
  assert.match(result.warnings[0], /2026-10-19T00:00:00.000Z 之后/);
  assert.equal(result.info.events, 1);
});

test('Cursor falls back when the CSV header changed or all token columns are empty', async (t) => {
  for (const csv of [
    'Date,Model,Kind,Input Tokens,Output\n2026-09-07T01:02:00Z,test-model,Included,10,20',
    `${CSV_HEADER}\n2026-09-07T01:02:00Z,test-model,0,0,0,0`,
  ]) {
    await t.test(csv.includes('Kind') ? 'renamed header' : 'tokenless rows', async (t) => {
      await withCursorDb(t);
      mockFetch(t, { csv: new Response(csv), events: eventsPage([event()]) });
      const result = await cursor.parse();
      assert.equal(result.buckets.length, 1);
      assert.match(result.warnings[0], /CSV 导出不可用/);
    });
  }
});

test('Cursor skips when both the CSV and events API have no token usage', async (t) => {
  await withCursorDb(t);
  mockFetch(t, { csv: new Response(CSV_HEADER), events: new Response('{}') });

  const result = await cursor.parse();
  assert.equal(result.skipped, true);
  assert.deepEqual(result.buckets, []);
  assert.match(result.warnings[0], /也没有读到 token 用量/);
});

test('Cursor pages the events fallback and deduplicates page-boundary rows', async (t) => {
  await withCursorDb(t);
  const firstPage = Array.from({ length: 1000 }, (_, i) => event({
    usageEventId: `e-${i}`,
    tokenUsage: i === 0 ? { inputTokens: 1, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 } : null,
  }));
  let eventCalls = 0;
  mockFetch(t, {
    csv: new Response(CSV_HEADER),
    events: async () => {
      eventCalls++;
      if (eventCalls === 1) return eventsPage(firstPage, 1001);
      // The dashboard can repeat the last row at a page boundary.
      return eventsPage([event({ usageEventId: 'e-999' }), event({ usageEventId: 'e-1000' })], 1001);
    },
  });

  const result = await cursor.parse();
  assert.equal(eventCalls, 2);
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].totalTokens, 71);
  assert.equal(result.info.events, 1001);
});

test('Cursor skips an incomplete events fallback instead of pruning state', async (t) => {
  await withCursorDb(t);
  mockFetch(t, { csv: new Response(CSV_HEADER), events: eventsPage([event()], 5) });

  const result = await cursor.parse();
  assert.equal(result.skipped, true);
  assert.match(result.warnings[0], /received 1 of 5/);
  assert.deepEqual(result.buckets, []);
});

test('Cursor reports underlying network codes and skips without trying other credentials', async (t) => {
  await withCursorDb(t);
  for (const [code, hint] of [
    ['ENOTFOUND', /DNS/],
    ['EAI_AGAIN', /DNS/],
    ['UND_ERR_CONNECT_TIMEOUT', /代理/],
    ['ECONNRESET', /网络/],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', /证书/],
  ]) {
    await t.test(code, async (t) => {
      const fetchMock = mockFetch(t, {
        csv: async () => { throw networkError(code); },
      });
      const result = await cursor.parse();
      assert.equal(result.skipped, true);
      assert.deepEqual(result.buckets, []);
      assert.deepEqual(result.sessions, []);
      assert.match(result.warnings[0], new RegExp(code));
      assert.match(result.warnings[0], hint);
      assert.equal(fetchMock.mock.callCount(), 1);
    });
  }
});

test('Cursor reports nested IPv4/IPv6 connection failures without exposing error messages', async (t) => {
  await withCursorDb(t);
  const detail = `https://proxy-user:proxy-password@proxy.invalid/ ${TOKEN}`;
  const aggregate = new AggregateError([
    Object.assign(new Error(detail), { code: 'ETIMEDOUT' }),
    Object.assign(new Error(detail), { code: 'ENETUNREACH' }),
    Object.assign(new Error(detail), { code: 'ETIMEDOUT' }),
  ]);
  mockFetch(t, {
    csv: async () => { throw new TypeError(detail, { cause: aggregate }); },
  });

  const result = await cursor.parse();
  assert.equal(result.skipped, true);
  assert.match(result.warnings[0], /ETIMEDOUT/);
  assert.match(result.warnings[0], /ENETUNREACH/);
  assert.equal(result.warnings[0].match(/ETIMEDOUT/g).length, 1);
  assert.doesNotMatch(result.warnings[0], /proxy-user|proxy-password|proxy\.invalid|test-signature/);
});

test('Cursor gives a network hint even when fetch has no underlying error code', async (t) => {
  await withCursorDb(t);
  mockFetch(t, { csv: async () => { throw new TypeError('fetch failed'); } });
  const result = await cursor.parse();
  assert.equal(result.skipped, true);
  assert.match(result.warnings[0], /network: fetch failed/);
  assert.match(result.warnings[0], /代理/);
});

test('Cursor soft-skips a CSV body connection failure after successful response headers', async (t) => {
  await withCursorDb(t);
  const fetchMock = mockFetch(t, {
    csv: async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => { throw networkError('UND_ERR_SOCKET'); },
    }),
  });

  const result = await cursor.parse();
  assert.equal(result.skipped, true);
  assert.deepEqual(result.buckets, []);
  assert.match(result.warnings[0], /UND_ERR_SOCKET/);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('Cursor recognizes the export deadline during both fetch and CSV body reads', async (t) => {
  await withCursorDb(t);
  for (const phase of ['headers', 'body']) {
    await t.test(phase, async (t) => {
      const timeoutError = new DOMException('deadline reached', 'TimeoutError');
      mockFetch(t, {
        csv: async () => {
          if (phase === 'headers') throw timeoutError;
          return { ok: true, status: 200, statusText: 'OK', text: async () => { throw timeoutError; } };
        },
      });

      const result = await cursor.parse();
      assert.equal(result.skipped, true);
      assert.match(result.warnings[0], /timeout/);
      assert.match(result.warnings[0], /VIBE_USAGE_CURSOR_FETCH_TIMEOUT_MS/);
      assert.deepEqual(result.buckets, []);
    });
  }
});

test('Cursor retries with the short cookie form after an auth rejection', async (t) => {
  await withCursorDb(t);
  let calls = 0;
  mockFetch(t, {
    csv: async () => {
      calls++;
      if (calls === 1) return new Response('', { status: 401, statusText: 'Unauthorized' });
      return new Response(CSV);
    },
  });

  const result = await cursor.parse();
  assert.equal(calls, 2);
  assert.equal(result.skipped, undefined);
  assert.equal(result.buckets.length, 1);
});

test('Cursor still surfaces expired credentials and soft-skips server failures', async (t) => {
  await withCursorDb(t);
  for (const status of [401, 403]) {
    await t.test(String(status), async (t) => {
      const fetchMock = mockFetch(t, { csv: async () => new Response('', { status }) });
      await assert.rejects(cursor.parse(), /Cursor session rejected.*sign in again/);
      assert.equal(fetchMock.mock.callCount(), 4);
    });
  }
  for (const status of [429, 503]) {
    await t.test(String(status), async (t) => {
      const fetchMock = mockFetch(t, { csv: async () => new Response('', { status }) });
      const result = await cursor.parse();
      assert.equal(result.skipped, true);
      assert.match(result.warnings[0], new RegExp(`HTTP ${status}`));
      assert.equal(fetchMock.mock.callCount(), 1);
    });
  }
});

// --- Incremental CSV (issue #131) ------------------------------------------

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const ACCOUNT = cursor.cursorAccountLabel('auth0|cursor-test-user');

function csvOf(rows) {
  return [
    CSV_HEADER,
    ...rows.map(r => `${new Date(r.at).toISOString()},${r.model},${r.cw ?? 0},${r.input ?? 0},${r.cr ?? 0},${r.out ?? 0}`),
  ].join('\n');
}

/**
 * A cursor.com stand-in that honors `startDate` / `endDate` the way the
 * dashboard's own date picker uses them. `requests` records every CSV URL.
 */
function csvServer(rows, { ignoreRange = false, startOverride } = {}) {
  const requests = [];
  const handler = (init, url) => {
    requests.push(url);
    const params = new URL(url).searchParams;
    const start = startOverride ?? (params.has('startDate') ? Number(params.get('startDate')) : -Infinity);
    const end = params.has('endDate') ? Number(params.get('endDate')) : Infinity;
    const visible = ignoreRange ? rows : rows.filter(r => r.at >= start && r.at <= end);
    return new Response(csvOf(visible));
  };
  return { handler, requests };
}

/** Deterministic synthetic history: a row every 7 minutes, two models. */
function syntheticRows(from, to) {
  const rows = [];
  let i = 0;
  for (let at = from; at <= to; at += 7 * MINUTE, i++) {
    rows.push({
      at,
      model: i % 3 === 0 ? 'model-b' : 'model-a',
      cw: (i * 7) % 50,
      input: 100 + (i % 13),
      cr: (i * 11) % 200,
      out: 20 + (i % 5),
    });
  }
  return rows;
}

/** What a whole-account run at `at` would have recorded in parserMeta. */
function infoAsOf(rows, at) {
  const seen = rows.filter(r => r.at <= at);
  const tokens = seen.filter(r => (r.cw || 0) + (r.input || 0) + (r.cr || 0) + (r.out || 0) > 0);
  return {
    account: ACCOUNT,
    latestEventAt: new Date(Math.max(...seen.map(r => r.at))).toISOString(),
    latestTokenAt: new Date(Math.max(...tokens.map(r => r.at))).toISOString(),
    events: seen.length,
    tokenEvents: tokens.length,
  };
}

test('Cursor plans an incremental tail only for the same account with a known newest token event', () => {
  const now = Date.parse('2026-11-04T08:00:00Z');
  const anchor = Date.parse('2026-11-04T07:10:00Z');
  const info = { account: ACCOUNT, latestTokenAt: new Date(anchor).toISOString() };

  assert.equal(cursor.incrementalCsvPlan(undefined, ACCOUNT, now), null);
  assert.equal(cursor.incrementalCsvPlan(info, null, now), null);
  assert.equal(cursor.incrementalCsvPlan({ ...info, account: 'auth0|othe…user' }, ACCOUNT, now), null);
  assert.equal(cursor.incrementalCsvPlan({ account: ACCOUNT }, ACCOUNT, now), null);
  assert.equal(cursor.incrementalCsvPlan({ ...info, latestTokenAt: 'garbage' }, ACCOUNT, now), null);
  assert.equal(cursor.incrementalCsvPlan({ ...info, latestTokenAt: new Date(now + HOUR).toISOString() }, ACCOUNT, now), null);

  const plan = cursor.incrementalCsvPlan(info, ACCOUNT, now);
  assert.equal(plan.anchor, anchor);
  // A real bucket boundary on this machine, at least 24h before the anchor.
  assert.equal(plan.emitFrom, roundToHalfHour(new Date(anchor - 24 * HOUR)).getTime());
  assert.ok(plan.emitFrom <= anchor - 24 * HOUR);
  assert.equal(plan.range.startDate, plan.emitFrom - HOUR);
  assert.equal(plan.range.endDate, now);
});

test('Cursor incremental tail uploads exactly the whole export\'s windows from its start on', async (t) => {
  await withCursorDb(t);
  const now = Date.now();
  const rows = syntheticRows(now - 5 * 24 * HOUR, now - 2 * MINUTE);
  const server = csvServer(rows);
  mockFetch(t, { csv: server.handler, events: async () => { throw new Error('events must not be called'); } });

  const full = await cursor.parse();
  assert.equal(server.requests.length, 1);
  assert.doesNotMatch(server.requests[0], /startDate/);

  // The previous sync ran six hours ago.
  const previousInfo = infoAsOf(rows, now - 6 * HOUR);
  const plan = cursor.incrementalCsvPlan(previousInfo, ACCOUNT);
  const tail = await cursor.parse({ previousInfo });
  assert.equal(server.requests.length, 2);
  const tailUrl = new URL(server.requests[1]);
  assert.equal(tailUrl.searchParams.get('startDate'), String(plan.range.startDate));
  assert.ok(Number(tailUrl.searchParams.get('endDate')) >= now);
  assert.equal(tailUrl.searchParams.get('strategy'), 'tokens');

  // Same keys and same numbers as the whole export, for every window the tail
  // covers -- and nothing older.
  const expected = full.buckets.filter(b => Date.parse(b.bucketStart) >= plan.emitFrom);
  assert.ok(expected.length > 40);
  assert.ok(expected.length < full.buckets.length);
  assert.deepEqual(tail.buckets, expected);
  // A tail is a partial view: sync.js must not prune Cursor's older keys.
  assert.equal(tail.skipped, true);
  assert.deepEqual(tail.warnings, []);
  // Diagnostics continue the whole-account numbers instead of shrinking.
  assert.deepEqual(tail.info, full.info);
});

test('Cursor never uploads a window the tail did not fetch whole', async (t) => {
  await withCursorDb(t);
  const now = Date.now();
  const rows = syntheticRows(now - 4 * 24 * HOUR, now - 2 * MINUTE);
  const previousInfo = infoAsOf(rows, now - 3 * HOUR);
  const plan = cursor.incrementalCsvPlan(previousInfo, ACCOUNT);
  const full = csvServer(rows);

  for (const [name, options] of [
    // The server answers from mid-window, 45 minutes before the first emitted
    // window: the window holding that start is incomplete and must not ship.
    ['server starts mid-window', { startOverride: plan.emitFrom - 45 * MINUTE }],
    // The server ignores the range entirely and returns the whole account.
    ['server ignores the range', { ignoreRange: true }],
  ]) {
    await t.test(name, async (t) => {
      const server = csvServer(rows, options);
      mockFetch(t, { csv: (init, url) => (url.includes('startDate') ? server.handler(init, url) : full.handler(init, url)) });
      const whole = await cursor.parse();
      const tail = await cursor.parse({ previousInfo });
      assert.ok(tail.buckets.every(b => Date.parse(b.bucketStart) >= plan.emitFrom));
      assert.deepEqual(tail.buckets, whole.buckets.filter(b => Date.parse(b.bucketStart) >= plan.emitFrom));
    });
  }
});

test('Cursor takes the whole export when the tail cannot be tied to known history', async (t) => {
  const now = Date.now();
  const rows = syntheticRows(now - 3 * 24 * HOUR, now - 2 * MINUTE);
  const previousInfo = infoAsOf(rows, now - 2 * HOUR);

  await t.test('account switched', async (t) => {
    await withCursorDb(t);
    const server = csvServer(rows);
    mockFetch(t, { csv: server.handler });
    const result = await cursor.parse({ previousInfo: { ...previousInfo, account: 'auth0|othe…user' } });
    assert.equal(server.requests.length, 1);
    assert.doesNotMatch(server.requests[0], /startDate/);
    assert.equal(result.skipped, undefined);
  });

  await t.test('empty tail (idle vs. emptied export look the same)', async (t) => {
    await withCursorDb(t);
    const requests = [];
    mockFetch(t, {
      csv: (init, url) => {
        requests.push(url);
        return new Response(url.includes('startDate') ? CSV_HEADER : csvOf(rows));
      },
    });
    const result = await cursor.parse({ previousInfo });
    assert.equal(requests.length, 2);
    assert.match(requests[0], /startDate=/);
    assert.doesNotMatch(requests[1], /startDate/);
    // The whole export is a complete view again: prunes normally.
    assert.equal(result.skipped, undefined);
    assert.equal(result.info.events, rows.length);
  });

  await t.test('tail only has rows newer than anything seen before', async (t) => {
    await withCursorDb(t);
    const requests = [];
    mockFetch(t, {
      csv: (init, url) => {
        requests.push(url);
        const visible = url.includes('startDate') ? rows.filter(r => r.at > Date.parse(previousInfo.latestTokenAt)) : rows;
        return new Response(csvOf(visible));
      },
    });
    const result = await cursor.parse({ previousInfo });
    assert.equal(requests.length, 2);
    assert.equal(result.skipped, undefined);
  });

  await t.test('an emptied export still reaches the events fallback', async (t) => {
    await withCursorDb(t);
    // Both the tail and the whole export come back empty (X Subscription).
    mockFetch(t, {
      csv: () => new Response(CSV_HEADER),
      events: eventsPage([event({ usageEventId: 'after', timestamp: String(now - 30 * MINUTE) })]),
    });
    const result = await cursor.parse({ previousInfo });
    assert.equal(result.buckets.length, 1);
    assert.match(result.warnings[0], /CSV 导出不可用/);
  });
});

test('Cursor takes the whole export if cursor.com refuses the date range', async (t) => {
  await withCursorDb(t);
  const now = Date.now();
  const rows = syntheticRows(now - 2 * 24 * HOUR, now - 2 * MINUTE);
  const requests = [];
  mockFetch(t, {
    csv: (init, url) => {
      requests.push(url);
      return url.includes('startDate')
        ? new Response('bad request', { status: 400, statusText: 'Bad Request' })
        : new Response(csvOf(rows));
    },
  });
  const result = await cursor.parse({ previousInfo: infoAsOf(rows, now - HOUR) });
  assert.equal(requests.length, 2);
  assert.doesNotMatch(requests[1], /startDate/);
  assert.equal(result.skipped, undefined);
  assert.equal(result.info.events, rows.length);
});

test('Cursor keeps the previous state when the tail request fails', async (t) => {
  await withCursorDb(t);
  const now = Date.now();
  const rows = syntheticRows(now - 2 * 24 * HOUR, now - 2 * MINUTE);
  const fetchMock = mockFetch(t, { csv: async () => { throw networkError('ECONNRESET'); } });
  const result = await cursor.parse({ previousInfo: infoAsOf(rows, now - HOUR) });
  assert.equal(result.skipped, true);
  assert.deepEqual(result.buckets, []);
  assert.match(result.warnings[0], /ECONNRESET/);
  // No second, whole-account attempt after a network failure.
  assert.equal(fetchMock.mock.callCount(), 1);

  // Same for a transient server state (rate limit / 5xx).
  for (const status of [429, 503]) {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      return new Response('busy', { status, statusText: 'Busy' });
    });
    const busy = await cursor.parse({ previousInfo: infoAsOf(rows, now - HOUR) });
    assert.equal(busy.skipped, true);
    assert.equal(calls, 1);
  }
});

test('Cursor tail still fills a stale CSV gap from the events API', async (t) => {
  await withCursorDb(t);
  const now = Date.now();
  // The export stopped two days ago; the previous run already saw its newest row.
  const rows = syntheticRows(now - 5 * 24 * HOUR, now - 2 * 24 * HOUR);
  const previousInfo = infoAsOf(rows, now - 2 * 24 * HOUR);
  const gapEvent = now - HOUR;
  const server = csvServer(rows);
  mockFetch(t, {
    csv: server.handler,
    events: eventsPage([event({ usageEventId: 'gap', timestamp: String(gapEvent), model: 'new-model' })]),
  });

  const result = await cursor.parse({ previousInfo });
  assert.match(server.requests[0], /startDate=/);
  assert.equal(result.skipped, true);
  assert.ok(result.buckets.some(b => b.model === 'new-model'));
  assert.match(result.warnings[0], /CSV 最新 token 事件停在/);
  assert.equal(result.info.latestTokenAt, new Date(gapEvent).toISOString());
  assert.equal(result.info.events, previousInfo.events + 1);
});

test('Cursor events fallback rebuilds the previous newest event\'s window whole', async (t) => {
  await withCursorDb(t);
  // Previous sync saw an event at 10:15; this run's newer event lands at 10:20
  // in the same 10:00 window. Uploading only the 10:20 event under the 10:00
  // key would replace (or, being smaller, be refused in favour of) the value
  // already holding the 10:05 and 10:15 events.
  const previousLatest = Date.parse('2026-10-19T10:15:00Z');
  const windowStart = roundToHalfHour(new Date(previousLatest)).getTime();
  let requestBody;
  mockFetch(t, {
    csv: new Response(CSV_HEADER),
    events: async (init) => {
      requestBody = JSON.parse(init.body);
      return eventsPage([
        event({ usageEventId: 'before-window', timestamp: String(windowStart - 10 * MINUTE) }),
        event({ usageEventId: 'a', timestamp: String(windowStart + 5 * MINUTE) }),
        event({ usageEventId: 'b', timestamp: String(previousLatest) }),
        event({ usageEventId: 'c', timestamp: String(previousLatest + 5 * MINUTE) }),
      ]);
    },
  });

  const result = await cursor.parse({
    previousInfo: { latestTokenAt: new Date(previousLatest).toISOString() },
  });
  assert.equal(requestBody.startDate, String(windowStart - HOUR));
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].bucketStart, new Date(windowStart).toISOString());
  // a + b + c, each 30 input / 30 cache read / 40 output.
  assert.equal(result.buckets[0].inputTokens, 90);
  assert.equal(result.buckets[0].totalTokens, 3 * 70);
  // "New usage" is still judged strictly after the previous newest event.
  assert.equal(result.info.events, 1);
  assert.match(result.warnings[0], /补回.*1 个 token 事件/);
  // Recent windows only: must not prune the older Cursor keys.
  assert.equal(result.skipped, true);
});
