import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fetchCursorQuota, parseCursorQuota, readCursorQuotaToken, cursorQuotaDbPath } from '../src/quotas/providers/cursor.js';
import { fetchAntigravityQuota, parseAntigravityQuota, withAntigravitySession } from '../src/quotas/providers/antigravity.js';
import { fetchQuotaProducts, discoverQuotaProducts } from '../src/quotas/registry.js';

const token = `header.${Buffer.from(JSON.stringify({ sub: 'fixture-account' })).toString('base64url')}.fixture-signature`;
const cursorPayload = { billingCycleStart: '2026-10-01T00:00:00Z', billingCycleEnd: '2026-11-01T00:00:00Z', membershipType: 'premium',
  individualUsage: { plan: { enabled: true, totalPercentUsed: .36, autoPercentUsed: 0,
    apiPercentUsed: .72, used: 90, limit: 100 } } };
const agyPayload = { response: { groups: [
  { displayName: 'Gemini Models', buckets: [
    { bucketId: 'gemini-weekly', remainingFraction: .75, resetTime: '2026-11-01T00:00:00Z' },
    { bucketId: 'gemini-5h', remainingFraction: 0 },
  ] },
  { displayName: 'Claude and GPT models', buckets: [
    { bucketId: '3p-weekly', remaining: { case: 'remainingFraction', value: 1 } },
    { bucketId: '3p-5h', resetTime: '2026-11-01T00:00:00Z' },
  ] },
  { displayName: 'Gemini 4 Argon', buckets: [{ bucketId: 'gemini-argon-wtu-weekly', remainingFraction: .5 }] },
] } };

async function fixture(t, encoding = 'utf8', login = token) {
  const root = mkdtempSync(join(tmpdir(), 'vbu-quota-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, 'state.vscdb');
  const sql = `CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);
    INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', X'${Buffer.from(login, encoding).toString('hex')}');
    INSERT INTO ItemTable VALUES ('unrelated', 'PRIVATE-UNRELATED');`;
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}
  if (DatabaseSync) { const db = new DatabaseSync(dbPath); try { db.exec(sql); } finally { db.close(); } }
  else execFileSync('sqlite3', [dbPath, sql]);
  return { root, dbPath, environment: { CURSOR_STATE_DB_PATH: dbPath, VIBE_USAGE_QUOTA_CACHE_DIR: root } };
}

test('Cursor preserves percentage units, zero and reset, and never invents a missing limit', () => {
  const meters = parseCursorQuota(cursorPayload);
  assert.deepEqual(meters.map(m => [m.id, m.label, m.utilization]), [['plan', 'Month', .36]]);
  assert.deepEqual(meters[0].breakdown, [{ id: 'auto', label: 'Cursor models', utilization: 0 },
    { id: 'api', label: 'Third-party models', utilization: .72 }]);
  assert.equal(meters[0].resetsAt, '2026-11-01T00:00:00.000Z');
  assert.equal(meters[0].windowSeconds, 31 * 86400);
  const onDemand = parseCursorQuota({ ...cursorPayload, individualUsage: { ...cursorPayload.individualUsage,
    onDemand: { enabled: true, used: 1250, limit: 5000 } } });
  assert.deepEqual(onDemand.map(m => [m.id, m.label, m.utilization]), [['plan', 'Month', .36], ['on-demand', 'On-demand', 25]]);
  assert.equal(parseCursorQuota({ individualUsage: { plan: { totalPercentUsed: 5 } } })[0].windowSeconds, undefined);
  assert.deepEqual(parseCursorQuota({ individualUsage: { plan: {} } }), []);
  assert.deepEqual(parseCursorQuota({ individualUsage: { plan: { enabled: false, totalPercentUsed: 90 } } }), []);
  assert.throws(() => parseCursorQuota({ error: 'bad response' }));
  const enterprise = parseCursorQuota({ individualUsage: { overall: { used: 25, limit: 100 } },
    teamUsage: { pooled: { used: 80, limit: 100 } } });
  assert.deepEqual(enterprise.map(m => [m.id,m.utilization]), [['personal',25]]);
  const missing = parseCursorQuota({ individualUsage: { plan: { used: null, limit: 100 },
    onDemand: { used: 50, limit: null } } });
  assert.deepEqual(missing, []);
});

test('Cursor reads only its login row, including UTF-16 BLOBs, without changing the store', async t => {
  for (const encoding of ['utf8','utf16le']) {
    const { dbPath } = await fixture(t, encoding);
    const before = readFileSync(dbPath);
    assert.equal(readCursorQuotaToken(dbPath), token);
    assert.deepEqual(readFileSync(dbPath), before);
  }
  assert.equal(cursorQuotaDbPath({ APPDATA: '/fixture/AppData' }, '/fixture', 'win32'),
    join('/fixture/AppData', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
});

test('Cursor authenticates only to the fixed official host and sanitizes results', async t => {
  const { environment } = await fixture(t);
  let calls = 0;
  const result = await fetchCursorQuota({ environment, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://cursor.com/api/usage-summary');
    assert.equal(options.redirect, 'error');
    assert.ok(options.headers.Cookie.includes(encodeURIComponent(`fixture-account::${token}`)));
    return new Response(JSON.stringify({ ...cursorPayload, accountEmail: 'private@example.invalid' }));
  } });
  assert.equal(calls,1);
  assert.equal(result.status,'ok');
  assert.equal(result.planLabel,'Pro');
  assert.ok(result.cacheScope);
  for (const secret of [token,'private@example.invalid','PRIVATE-UNRELATED']) assert.ok(!JSON.stringify(result).includes(secret));
});

test('Cursor isolates missing/rejected credentials and uses only same-account unexpired cache on transient failure', async t => {
  const { environment, root } = await fixture(t);
  const now = new Date('2026-10-23T00:00:00Z');
  const success = () => new Response(JSON.stringify(cursorPayload));
  await fetchQuotaProducts(['cursor'], { environment, now, fetchImpl: success });
  const failing = async () => { throw new Error(`private proxy ${token}`); };
  const cached = await fetchQuotaProducts(['cursor'], { environment, now, fetchImpl: failing });
  assert.equal(cached.products[0].source, 'cache');
  const other = await fixture(t, 'utf8', 'different-account-token');
  const switched = await fetchQuotaProducts(['cursor'], { environment: {
    ...environment, CURSOR_STATE_DB_PATH: other.dbPath,
  }, now, fetchImpl: failing });
  assert.equal(switched.products[0].status, 'retryable_error');
  assert.equal(switched.products[0].source, 'live');
  assert.ok(!readFileSync(join(root,'quota-cache.json'),'utf8').includes(token));
  let calls = 0;
  const rejected = await fetchQuotaProducts(['cursor'], { environment, now, fetchImpl: async () => {
    calls++; return new Response('{}',{status:401});
  } });
  assert.equal(calls,2);
  assert.equal(rejected.products[0].status,'unauthorized');
  assert.equal(rejected.products[0].source,'live');
  const expired = await fetchQuotaProducts(['cursor'], { environment, now: new Date('2026-11-02'), fetchImpl: failing });
  assert.equal(expired.products[0].status,'retryable_error');
  const missing = await fetchCursorQuota({ environment: { CURSOR_STATE_DB_PATH: join(root,'absent') }, fetchImpl: () => assert.fail('unexpected network') });
  assert.equal(missing.status,'missing_credentials');
});

test('Cursor malformed/oversized responses and network errors never echo secrets', async t => {
  const { environment } = await fixture(t);
  for (const body of ['<html>login</html>', JSON.stringify({ private: token }), ' '.repeat(1024*1024+1)]) {
    const result = await fetchCursorQuota({ environment, fetchImpl: async () => new Response(body) });
    assert.equal(result.status, 'retryable_error');
    assert.ok(!JSON.stringify(result).includes(token));
  }
});

test('AGY shows only the Gemini family as 5h/7d; other families are validated but not shown', () => {
  const meters = parseAntigravityQuota(agyPayload);
  assert.deepEqual(meters.map(m => [m.id, m.label, m.utilization, m.windowSeconds]),
    [['gemini-5h', '5h', 100, 18000], ['gemini-weekly', '7d', 25, 604800]]);
  assert.equal(meters[1].resetsAt, '2026-11-01T00:00:00.000Z');
  // Without a Gemini group, the first family with data still fills the card.
  const others = parseAntigravityQuota({ response: { groups: agyPayload.response.groups.slice(1) } });
  assert.deepEqual(others.map(m => [m.id, m.label]), [['3p-weekly', '7d']]);
  for (const value of [-.1,1.1,'0.5',Infinity]) {
    const payload = structuredClone(agyPayload);payload.response.groups[0].buckets[0].remainingFraction = value;
    assert.throws(() => parseAntigravityQuota(payload));
    const hidden = structuredClone(agyPayload);hidden.response.groups[1].buckets[0].remaining.value = value;
    assert.throws(() => parseAntigravityQuota(hidden));
  }
  assert.throws(() => parseAntigravityQuota({ code: 'unauthenticated' }));
});

test('AGY never reads credentials during discovery or falls back to another account cache', async () => {
  const environment = { ANTIGRAVITY_CLI_PATH: process.execPath, PATH: '' };
  assert.equal(discoverQuotaProducts({ environment, home: '/missing' }).products.find(p => p.id === 'antigravity').detected,true);
  const result = await fetchAntigravityQuota({ environment,
    sessionImpl: async (binary, callback) => callback({ port: 1234, token: 'private-csrf' }),
    requestImpl: async () => ({ status:200, payload: agyPayload }),
  });
  assert.equal(result.status,'ok');
  assert.equal(result.cacheScope,undefined);
  assert.ok(!JSON.stringify(result).includes('private-csrf'));
  const rejected = await fetchAntigravityQuota({ environment,
    sessionImpl: async (binary, callback) => callback({}), requestImpl: async () => ({status:401}),
  });
  assert.equal(rejected.status,'unauthorized');
  const missing = await fetchAntigravityQuota({ environment: {PATH:''}, home: '/missing' });
  assert.equal(missing.status,'missing_credentials');
});

test('AGY owns and cleans its prompt-free child on success and timeout', async t => {
  const root = mkdtempSync(join(tmpdir(),'vbu-agy-lifecycle-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  const fake = join(root,'fake.cjs');
  writeFileSync(fake, `const fs=require('fs'); const a=process.argv.slice(2);
    fs.writeFileSync(a[a.indexOf('--log-file')+1], 'Language server listening on random port at 12345 for HTTPS (gRPC)');
    process.stdin.on('data', () => process.exit(99)); setInterval(()=>{},1000);`);
  for (const mode of ['success','timeout','exception']) {
    let child, workingDirectory;
    const options = { timeoutMs: mode === 'timeout' ? 300 : 3000, spawnImpl: (binary,args,opts) => {
      assert.equal(args[args.indexOf('--print')+1],'');
      assert.equal(args[args.indexOf('--input-format')+1],'stream-json');
      workingDirectory=opts.cwd;
      child=spawn(process.execPath,[fake,...args],opts);return child;
    } };
    const action = withAntigravitySession(process.execPath, async endpoint => {
      assert.equal(endpoint.port,12345);assert.equal(endpoint.token.length,64);
      if (mode === 'exception') throw new Error('fixture parse failure');
      return mode === 'success' ? { ok:true } : undefined;
    }, options);
    if (mode === 'success') assert.deepEqual(await action,{ok:true});
    else await assert.rejects(action, mode === 'exception' ? /fixture parse failure/ : /unavailable/);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.ok(!existsSync(workingDirectory));
  }
});
