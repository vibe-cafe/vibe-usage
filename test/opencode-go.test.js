import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fetchOpenCodeGoQuota, openCodeDataRoots, openCodeDbPath, parseOpenCodeGoUsage } from '../src/quotas/providers/opencode-go.js';
import { quotaResult } from '../src/quotas/schema.js';

const require = createRequire(import.meta.url);

const usagePayload = {
  usage: {
    rolling: { status: 'ok', percent: 3, resetsAt: '2026-09-22T20:51:03.221Z' },
    weekly: { status: 'ok', percent: 1, resetsAt: '2026-09-28T00:00:00.221Z' },
    monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-10-22T15:41:26.221Z' },
  },
};

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Writes an OpenCode-shaped credential database at `<root>/opencode.db`. */
function credentialFixture(root, rows = [{ integrationId: 'opencode-go', value: { type: 'key', key: 'sk-test-key' } }]) {
  mkdirSync(root, { recursive: true });
  const path = openCodeDbPath(root);
  const sql = 'CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, value TEXT, active INTEGER, time_updated INTEGER);'
    + rows.map((row, index) => `INSERT INTO credential VALUES (${quote(`cred-${index}`)},${quote(row.integrationId)},`
      + `${quote(JSON.stringify(row.value))},${row.active ?? 1},${index});`).join('');
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* Node 20 uses the CLI. */ }
  if (DatabaseSync) {
    const db = new DatabaseSync(path);
    try { db.exec(sql); } finally { db.close(); }
  } else {
    execFileSync('sqlite3', [path], { input: sql });
  }
  return path;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-opencode-go-'));
  const dataRoot = join(root, 'opencode');
  try {
    return await run(dataRoot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('OpenCode Go parser maps the three official windows and clamps malformed input', () => {
  const meters = parseOpenCodeGoUsage(usagePayload);
  assert.deepEqual(meters, [
    { id: 'rolling', label: '5h', utilization: 3, resetsAt: '2026-09-22T20:51:03.221Z' },
    { id: 'weekly', label: 'Weekly', utilization: 1, resetsAt: '2026-09-28T00:00:00.221Z' },
    { id: 'monthly', label: 'Monthly', utilization: 100, resetsAt: '2026-10-22T15:41:26.221Z' },
  ]);

  assert.deepEqual(parseOpenCodeGoUsage({
    usage: {
      rolling: { percent: 250, resetsAt: 'not-a-date' },
      weekly: { percent: 'nope' },
      monthly: null,
    },
  }), [{ id: 'rolling', label: '5h', utilization: 100 }]);
  assert.throws(() => parseOpenCodeGoUsage([]), /not an object/);
});

test('OpenCode Go fetch sends the stored key as bearer auth and never leaks it', async () => withFixture(async dataRoot => {
  credentialFixture(dataRoot);
  const requests = [];
  const result = await fetchOpenCodeGoQuota({
    environment: { VIBE_USAGE_OPENCODE_DIRS: dataRoot },
    home: '/definitely/missing-home',
    now: new Date('2026-09-22T16:00:00Z'),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse(usagePayload);
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://opencode.ai/zen/go/v1/usage');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer sk-test-key');
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'live');
  assert.equal(result.meters.length, 3);
  assert.equal(result.meters[0].label, '5h');
  assert.equal(result.dataAsOf, '2026-09-22T16:00:00.000Z');
  assert.equal(typeof result.cacheScope, 'string');
  assert.equal(result.cacheScope.length, 64);
  assert.equal(JSON.stringify(result).includes('sk-test-key'), false);
  assert.equal(Object.keys(result).includes('cacheScope'), false);
}));

test('OpenCode Go fetch reports missing logins without reaching the network', async () => withFixture(async dataRoot => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse(usagePayload); };
  const missingDatabase = await fetchOpenCodeGoQuota({
    environment: { VIBE_USAGE_OPENCODE_DIRS: dataRoot },
    home: '/definitely/missing-home',
    fetchImpl,
  });
  assert.equal(missingDatabase.status, 'missing_credentials');
  assert.deepEqual(missingDatabase.meters, []);

  credentialFixture(dataRoot, [{ integrationId: 'anthropic', value: { type: 'key', key: 'sk-other' } }]);
  const unrelatedCredential = await fetchOpenCodeGoQuota({
    environment: { VIBE_USAGE_OPENCODE_DIRS: dataRoot },
    home: '/definitely/missing-home',
    fetchImpl,
  });
  assert.equal(unrelatedCredential.status, 'missing_credentials');
  assert.equal(calls, 0);
}));

test('OpenCode Go fetch maps authorization, entitlement, and transport failures', async () => withFixture(async dataRoot => {
  credentialFixture(dataRoot);
  const fetch = status => fetchOpenCodeGoQuota({
    environment: { VIBE_USAGE_OPENCODE_DIRS: dataRoot },
    home: '/definitely/missing-home',
    fetchImpl: async () => jsonResponse({ type: 'error' }, status),
  });

  assert.equal((await fetch(401)).status, 'unauthorized');
  assert.equal((await fetch(403)).status, 'no_data');
  assert.equal((await fetch(500)).status, 'retryable_error');

  const timedOut = await fetchOpenCodeGoQuota({
    environment: { VIBE_USAGE_OPENCODE_DIRS: dataRoot },
    home: '/definitely/missing-home',
    fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); },
  });
  assert.equal(timedOut.status, 'retryable_error');
  assert.match(timedOut.message, /timed out/);

  const malformed = await fetchOpenCodeGoQuota({
    environment: { VIBE_USAGE_OPENCODE_DIRS: dataRoot },
    home: '/definitely/missing-home',
    fetchImpl: async () => new Response('not json', { status: 200 }),
  });
  assert.equal(malformed.status, 'retryable_error');
}));

test('OpenCode Go data roots default to the OpenCode data directory and honor the override', () => {
  // Build every expectation with the platform's own rules: the provider joins
  // with node:path and splits the override on the platform delimiter, so a
  // hardcoded POSIX literal (or a `:`-joined override) fails on Windows.
  assert.deepEqual(openCodeDataRoots({}, '/Users/example'),
    [join('/Users/example', '.local', 'share', 'opencode')]);
  assert.deepEqual(
    openCodeDataRoots(
      { VIBE_USAGE_OPENCODE_DIRS: ['/a/opencode', '/b/opencode'].join(delimiter) },
      '/Users/example'
    ),
    ['/a/opencode', '/b/opencode']
  );
});

test('OpenCode Go folds a pre-2.x auth.json login in when the credential table has no Go row', async () => withFixture(async dataRoot => {
  // 1.x data home: a credential table exists but holds no `opencode-go` row,
  // and the CLI's own auth.json carries the key the usage endpoint accepts.
  credentialFixture(dataRoot, [{ integrationId: 'anthropic', value: { type: 'oauth', access: 'must-not-be-read' } }]);
  writeFileSync(join(dataRoot, 'auth.json'), JSON.stringify({
    anthropic: { type: 'oauth', access: 'must-not-be-read' },
    opencode: { type: 'api', key: '  sk-auth-file-key  ' },
  }));

  const requests = [];
  const result = await fetchOpenCodeGoQuota({
    environment: { VIBE_USAGE_OPENCODE_DIRS: dataRoot },
    home: '/definitely/missing-home',
    now: new Date('2026-09-26T09:00:00Z'),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse(usagePayload);
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer sk-auth-file-key');
  assert.equal(JSON.stringify(result).includes('sk-auth-file-key'), false);
}));

test('OpenCode Go prefers the Go-specific credential row over auth.json', async () => withFixture(async dataRoot => {
  credentialFixture(dataRoot, [{ integrationId: 'opencode-go', value: { type: 'key', key: 'sk-go-row-key' } }]);
  writeFileSync(join(dataRoot, 'auth.json'), JSON.stringify({
    opencode: { type: 'api', key: 'sk-auth-file-key' },
  }));

  let authorization;
  const result = await fetchOpenCodeGoQuota({
    environment: { VIBE_USAGE_OPENCODE_DIRS: dataRoot },
    home: '/definitely/missing-home',
    fetchImpl: async (_url, options) => {
      authorization = options.headers.Authorization;
      return jsonResponse(usagePayload);
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal(authorization, 'Bearer sk-go-row-key');
}));

test('OpenCode Go falls back to auth.json when the credential store cannot be read', async () => withFixture(async dataRoot => {
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(openCodeDbPath(dataRoot), 'not a sqlite database');
  writeFileSync(join(dataRoot, 'auth.json'), JSON.stringify({
    opencode: { type: 'api', key: 'sk-auth-file-key' },
  }));

  let authorization;
  const result = await fetchOpenCodeGoQuota({
    environment: { VIBE_USAGE_OPENCODE_DIRS: dataRoot },
    home: '/definitely/missing-home',
    fetchImpl: async (_url, options) => {
      authorization = options.headers.Authorization;
      return jsonResponse(usagePayload);
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal(authorization, 'Bearer sk-auth-file-key');
}));

test('OpenCode Go reports missing credentials when neither store holds an OpenCode key', async () => withFixture(async dataRoot => {
  credentialFixture(dataRoot, [{ integrationId: 'anthropic', value: { type: 'oauth', access: 'x' } }]);
  writeFileSync(join(dataRoot, 'auth.json'), JSON.stringify({
    anthropic: { type: 'oauth', access: 'must-not-be-read' },
    opencode: { type: 'api', key: '   ' },
  }));

  let called = false;
  const result = await fetchOpenCodeGoQuota({
    environment: { VIBE_USAGE_OPENCODE_DIRS: dataRoot },
    home: '/definitely/missing-home',
    fetchImpl: async () => { called = true; },
  });

  assert.equal(result.status, 'missing_credentials');
  assert.equal(called, false);
}));

test('OpenCode Go marks a missing subscription with a machine-readable reason', async () => withFixture(async dataRoot => {
  credentialFixture(dataRoot);
  const result = await fetchOpenCodeGoQuota({
    environment: { VIBE_USAGE_OPENCODE_DIRS: dataRoot },
    home: '/definitely/missing-home',
    fetchImpl: async () => jsonResponse({ type: 'error' }, 403),
  });

  // A client can render 「未订阅」 from the reason instead of parsing the message.
  assert.equal(result.status, 'no_data');
  assert.equal(result.emptyReason, 'notEntitled');
}));

test('quota results reject an unknown emptyReason', async () => withFixture(async dataRoot => {
  credentialFixture(dataRoot);
  const result = await fetchOpenCodeGoQuota({
    environment: { VIBE_USAGE_OPENCODE_DIRS: dataRoot },
    home: '/definitely/missing-home',
    fetchImpl: async () => jsonResponse(usagePayload),
  });
  // The healthy path carries no reason at all.
  assert.equal(result.emptyReason, undefined);

  assert.throws(
    () => quotaResult({ id: 'opencode-go', status: 'no_data', emptyReason: 'made-up' }),
    /invalid quota emptyReason/,
  );
}));

// ---------------------------------------------------------------------------
// Every place OpenCode keeps a Go login (2026-11-24). Fixture values are fake;
// every request goes to a stub that records it and never reaches the network.

const NOW = new Date('2026-11-24T12:00:00Z');
const LATER = NOW.getTime() + 60 * 60 * 1000;
const currentPayload = {
  usage: {
    rolling: { status: 'ok', percent: 12, resetsAt: '2026-11-24T15:00:00.000Z' },
    weekly: { status: 'ok', percent: 30, resetsAt: '2026-11-30T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 8, resetsAt: '2026-12-20T00:00:00.000Z' },
  },
};

function accountLogin({ access = 'acc-fake-1', orgID = 'wrk_fake', expires = LATER, server } = {}) {
  const metadata = {};
  if (orgID !== null) metadata.orgID = orgID;
  if (server !== undefined) metadata.server = server;
  return { type: 'oauth', methodID: 'device', refresh: 'ref-must-not-leave', access, expires, metadata };
}

async function fetchWith(dataRoot, extra = {}) {
  const requests = [];
  const result = await fetchOpenCodeGoQuota({
    environment: { VIBE_USAGE_OPENCODE_DIRS: dataRoot },
    home: '/definitely/missing-home',
    now: NOW,
    fetchImpl: async (url, options) => {
      requests.push({ url, headers: options.headers });
      return jsonResponse(usagePayload);
    },
    ...extra,
  });
  return { result, requests };
}

test('OpenCode Go reads a 1.x login made through "OpenCode Go" (auth.json opencode-go)', async () => withFixture(async dataRoot => {
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(join(dataRoot, 'auth.json'), JSON.stringify({
    anthropic: { type: 'oauth', access: 'must-not-be-read' },
    'opencode-go': { type: 'api', key: 'sk-go-file-key' },
  }));
  const { result, requests } = await fetchWith(dataRoot);
  assert.equal(result.status, 'ok');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://opencode.ai/zen/go/v1/usage');
  assert.equal(requests[0].headers.Authorization, 'Bearer sk-go-file-key');
  assert.equal('x-opencode-org-id' in requests[0].headers, false);
}));

test('OpenCode Go prefers auth.json opencode-go over auth.json opencode', async () => withFixture(async dataRoot => {
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(join(dataRoot, 'auth.json'), JSON.stringify({
    opencode: { type: 'api', key: 'sk-zen-file-key' },
    'opencode-go': { type: 'api', key: 'sk-go-file-key' },
  }));
  const { requests } = await fetchWith(dataRoot);
  assert.equal(requests[0].headers.Authorization, 'Bearer sk-go-file-key');
}));

test('OpenCode Go reads a 2.x OpenCode account sign-in with its workspace', async () => withFixture(async dataRoot => {
  credentialFixture(dataRoot, [{ integrationId: 'opencode', value: accountLogin() }]);
  const { result, requests } = await fetchWith(dataRoot);
  assert.equal(result.status, 'ok');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://opencode.ai/zen/go/v1/usage');
  assert.equal(requests[0].headers.Authorization, 'Bearer acc-fake-1');
  assert.equal(requests[0].headers['x-opencode-org-id'], 'wrk_fake');
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('acc-fake-1'), false);
  assert.equal(serialized.includes('ref-must-not-leave'), false);
  assert.equal(serialized.includes('wrk_fake'), false);
}));

test('OpenCode Go reads a 2.x OpenCode service-account key', async () => withFixture(async dataRoot => {
  credentialFixture(dataRoot, [{
    integrationId: 'opencode',
    value: { type: 'key', key: 'sk-service-key', metadata: { orgID: 'wrk_service' } },
  }]);
  const { result, requests } = await fetchWith(dataRoot);
  assert.equal(result.status, 'ok');
  assert.equal(requests[0].headers.Authorization, 'Bearer sk-service-key');
  assert.equal(requests[0].headers['x-opencode-org-id'], 'wrk_service');
}));

test('OpenCode Go sends nothing for an expired account sign-in and never renews it', async () => withFixture(async dataRoot => {
  credentialFixture(dataRoot, [{ integrationId: 'opencode', value: accountLogin({ expires: NOW.getTime() - 1000 }) }]);
  const { result, requests } = await fetchWith(dataRoot);
  assert.equal(result.status, 'expired_credentials');
  assert.equal(requests.length, 0);

  // Inside the renewal margin counts as expired too: OpenCode renews it when it runs.
  credentialFixture(join(dataRoot, 'margin'), [{
    integrationId: 'opencode', value: accountLogin({ expires: NOW.getTime() + 30_000 }),
  }]);
  const margin = await fetchWith(join(dataRoot, 'margin'));
  assert.equal(margin.result.status, 'expired_credentials');
  assert.equal(margin.requests.length, 0);

  // `expires: 0` means the issuer gave no lifetime.
  credentialFixture(join(dataRoot, 'forever'), [{ integrationId: 'opencode', value: accountLogin({ expires: 0 }) }]);
  assert.equal((await fetchWith(join(dataRoot, 'forever'))).result.status, 'ok');
}));

test('OpenCode Go skips an account sign-in without a workspace or for another Console', async () => withFixture(async dataRoot => {
  credentialFixture(dataRoot, [{ integrationId: 'opencode', value: accountLogin({ orgID: null }) }]);
  const noWorkspace = await fetchWith(dataRoot);
  assert.equal(noWorkspace.result.status, 'missing_credentials');
  assert.equal(noWorkspace.requests.length, 0);

  const custom = join(dataRoot, 'custom');
  credentialFixture(custom, [{
    integrationId: 'opencode', value: accountLogin({ server: 'https://console.example.com' }),
  }]);
  const customConsole = await fetchWith(custom);
  assert.equal(customConsole.result.status, 'missing_credentials');
  assert.equal(customConsole.requests.length, 0);

  // The retired Console host is the default Console, as OpenCode rewrites it.
  const retired = join(dataRoot, 'retired');
  credentialFixture(retired, [{
    integrationId: 'opencode', value: accountLogin({ server: 'https://console.opencode.ai' }),
  }]);
  assert.equal((await fetchWith(retired)).result.status, 'ok');
}));

test('OpenCode Go prefers a Go key over an account sign-in when both are stored', async () => withFixture(async dataRoot => {
  credentialFixture(dataRoot, [
    { integrationId: 'opencode', value: accountLogin() },
    { integrationId: 'opencode-go', value: { type: 'key', key: 'sk-go-row-key' } },
  ]);
  const { requests } = await fetchWith(dataRoot);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.Authorization, 'Bearer sk-go-row-key');
  assert.equal('x-opencode-org-id' in requests[0].headers, false);
}));

test('OpenCode Go uses an older usable login when the account sign-in has expired', async () => withFixture(async dataRoot => {
  credentialFixture(dataRoot, [{ integrationId: 'opencode', value: accountLogin({ expires: NOW.getTime() - 1 }) }]);
  writeFileSync(join(dataRoot, 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'sk-go-file-key' } }));
  const { result, requests } = await fetchWith(dataRoot);
  assert.equal(result.status, 'ok');
  assert.equal(requests[0].headers.Authorization, 'Bearer sk-go-file-key');
}));

test('OpenCode Go uses the active account row and the newest among equals', async () => withFixture(async dataRoot => {
  credentialFixture(dataRoot, [
    { integrationId: 'opencode', value: accountLogin({ access: 'acc-active' }), active: 1 },
    { integrationId: 'opencode', value: accountLogin({ access: 'acc-inactive' }), active: 0 },
  ]);
  const { requests } = await fetchWith(dataRoot);
  assert.equal(requests[0].headers.Authorization, 'Bearer acc-active');
}));

test('OpenCode Go honors XDG_DATA_HOME like OpenCode does', async () => withFixture(async dataRoot => {
  const xdg = join(dataRoot, 'xdg-data');
  assert.deepEqual(openCodeDataRoots({ XDG_DATA_HOME: xdg }, '/Users/example'), [join(xdg, 'opencode')]);

  credentialFixture(join(xdg, 'opencode'), [{ integrationId: 'opencode', value: accountLogin() }]);
  const requests = [];
  const result = await fetchOpenCodeGoQuota({
    environment: { XDG_DATA_HOME: xdg },
    home: '/definitely/missing-home',
    now: NOW,
    fetchImpl: async (url, options) => {
      requests.push(options.headers);
      return jsonResponse(usagePayload);
    },
  });
  assert.equal(result.status, 'ok');
  assert.equal(requests[0].Authorization, 'Bearer acc-fake-1');
}));

test('OpenCode Go scopes an account sign-in cache by workspace, not by its rotating token', async () => withFixture(async dataRoot => {
  const { fetchQuotaProducts } = await import('../src/quotas/registry.js');
  const cacheDir = join(dataRoot, 'quota-cache');
  credentialFixture(join(dataRoot, 'a'), [{ integrationId: 'opencode', value: accountLogin({ access: 'acc-before' }) }]);
  credentialFixture(join(dataRoot, 'b'), [{ integrationId: 'opencode', value: accountLogin({ access: 'acc-after' }) }]);
  credentialFixture(join(dataRoot, 'c'), [{
    integrationId: 'opencode', value: accountLogin({ access: 'acc-after', orgID: 'wrk_other' }),
  }]);
  const run = (root, fetchImpl) => fetchQuotaProducts(['opencode-go'], {
    environment: { VIBE_USAGE_OPENCODE_DIRS: join(dataRoot, root), VIBE_USAGE_QUOTA_CACHE_DIR: cacheDir },
    home: '/definitely/missing-home',
    now: NOW,
    fetchImpl,
    envProxyBlock: null,
  });

  const fresh = await run('a', async () => jsonResponse(currentPayload));
  assert.equal(fresh.products[0].status, 'ok');
  // OpenCode renewed the token; the live read then fails transiently.
  const renewed = await run('b', async () => jsonResponse({}, 502));
  assert.equal(renewed.products[0].status, 'ok');
  assert.equal(renewed.products[0].source, 'cache');
  // Another workspace never sees the first one's numbers.
  const otherWorkspace = await run('c', async () => jsonResponse({}, 502));
  assert.equal(otherWorkspace.products[0].status, 'retryable_error');
}));
