import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cursor from '../src/parsers/cursor.js';

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
      return typeof csv === 'function' ? csv(init) : csv;
    }
    if (String(url).includes('/api/dashboard/get-filtered-usage-events')) {
      return typeof events === 'function' ? events(init) : events;
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
