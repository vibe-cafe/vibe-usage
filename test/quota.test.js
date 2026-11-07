import test from 'node:test';
import { assertPrivateCredentialFile, makePrivateWindowsFixtureDirectory } from '../test-support/file-permissions.js';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { discoverQuotaProducts, fetchQuotaProducts } from '../src/quotas/registry.js';
import { quotaResult } from '../src/quotas/schema.js';
import {
  fetchKimiCodeQuota,
  kimiCredentialPath,
  kimiCredentialPaths,
  parseKimiUsage,
} from '../src/quotas/providers/kimi-code.js';
import {
  fetchGrokQuota,
  grokBillingLogPath,
  parseGrokBillingLog,
} from '../src/quotas/providers/grok.js';
import { fetchZaiQuota, parseZaiQuota } from '../src/quotas/providers/zai.js';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function runNodeModule(script, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`child exited ${code}: ${stderr}`));
    });
  });
}

const kimiPayload = {
  usage: { name: 'Weekly', used: 25, limit: 100, reset_at: '2026-09-14T00:00:00Z' },
  limits: [
    {
      window: { duration: 300, timeUnit: 'MINUTE' },
      detail: { remaining: 80, limit: 100, resetAt: '2026-09-07T05:00:00Z' },
    },
  ],
};

const zaiPayload = {
  code: 200,
  msg: 'success',
  success: true,
  data: {
    planName: 'Pro',
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 25, nextResetTime: 1785816000000 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 9, nextResetTime: 1786291200000 },
      { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 1000, currentValue: 224,
        remaining: 776, percentage: 22 },
    ],
  },
};

test('quota discovery detects Grok and Cursor independently', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-quota-discovery-'));
  const bin = join(root, 'bin');
  mkdirSync(join(root, '.kimi-code'), { recursive: true });
  mkdirSync(join(root, '.grok', 'logs'), { recursive: true });
  mkdirSync(join(root, '.local', 'share', 'opencode'), { recursive: true });
  mkdirSync(join(root, '.cursor'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(bin, 'zcode'), '#!/bin/sh\n');
  chmodSync(join(bin, 'zcode'), 0o700);
  try {
    const envelope = discoverQuotaProducts({
      environment: { PATH: bin },
      home: root,
      platform: 'linux',
    });
    assert.equal(envelope.schemaVersion, 1);
    assert.deepEqual(envelope.products, [
      { id: 'kimi-code', detected: true, fetchable: true },
      { id: 'zcode', detected: true, fetchable: true },
      { id: 'grok', detected: true, fetchable: true },
      { id: 'opencode-go', detected: true, fetchable: true },
      { id: 'cursor', detected: true, fetchable: true },
      { id: 'antigravity', detected: false, fetchable: true },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quota discovery follows Windows PATH and PATHEXT command rules', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-quota-windows-discovery-'));
  const firstBin = join(root, 'first-bin');
  const secondBin = join(root, 'second-bin');
  mkdirSync(firstBin);
  mkdirSync(secondBin);
  writeFileSync(join(firstBin, 'kimi.CMD'), '');
  writeFileSync(join(secondBin, 'zcode.exe'), '');
  writeFileSync(join(secondBin, 'grok.BAT'), '');
  writeFileSync(join(secondBin, 'cursor.com'), '');
  try {
    const envelope = discoverQuotaProducts({
      environment: {
        PATH: `${firstBin};${secondBin}`,
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        GROK_HOME: join(root, 'missing-grok-home'),
      },
      home: join(root, 'empty-home'),
      platform: 'win32',
    });
    assert.deepEqual(envelope.products, [
      { id: 'kimi-code', detected: true, fetchable: true },
      { id: 'zcode', detected: true, fetchable: true },
      { id: 'grok', detected: true, fetchable: true },
      { id: 'opencode-go', detected: false, fetchable: true },
      { id: 'cursor', detected: true, fetchable: true },
      { id: 'antigravity', detected: false, fetchable: true },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Grok parser selects the latest structured billing event and exposes only quota fields', () => {
  const parsed = parseGrokBillingLog([
    '{not-json',
    JSON.stringify({ ts: '2026-09-08T00:00:00Z', msg: 'unrelated', ctx: { secret: 'nope' } }),
    JSON.stringify({
      ts: '2026-09-08T01:00:00Z',
      msg: 'billing: fetched credits config',
      ctx: {
        config: {
          creditUsagePercent: 12,
          currentPeriod: {
            type: 'USAGE_PERIOD_TYPE_WEEKLY',
            start: '2026-09-07T00:00:00Z',
            end: '2026-09-14T00:00:00Z',
          },
          accountId: 'must-not-be-returned',
        },
        subscriptionTier: 'X Premium+',
        accessToken: 'must-not-be-returned',
      },
    }),
    JSON.stringify({
      ts: '2026-09-08T02:00:00Z',
      msg: 'billing: fetched credits config',
      ctx: {
        config: {
          creditUsagePercent: 30,
          currentPeriod: {
            type: 'USAGE_PERIOD_TYPE_WEEKLY',
            start: '2026-09-07T00:00:00Z',
            end: '2026-09-14T00:00:00Z',
          },
        },
        subscriptionTier: 'X Premium+',
      },
    }),
  ].join('\n'), new Date('2026-09-08T03:00:00Z'));

  assert.deepEqual(parsed, {
    active: true,
    dataAsOf: new Date('2026-09-08T02:00:00Z'),
    meters: [{
      id: 'subscription-credits',
      label: '7d',
      utilization: 30,
      resetsAt: '2026-09-14T00:00:00.000Z',
      windowSeconds: 604_800,
    }],
    planLabel: 'X Premium+',
  });
  assert.equal(JSON.stringify(parsed).includes('must-not-be-returned'), false);
});

test('Grok fetch reads its official bounded local log without credentials or network', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-grok-quota-'));
  const grokHome = join(root, 'custom-grok');
  const logPath = join(grokHome, 'logs', 'unified.jsonl');
  mkdirSync(join(grokHome, 'logs'), { recursive: true });
  writeFileSync(logPath, `${JSON.stringify({
    ts: '2026-09-08T02:00:00Z',
    msg: 'billing: fetched credits config',
    ctx: {
      config: {
        creditUsagePercent: 30,
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-09-07T00:00:00Z',
          end: '2026-09-14T00:00:00Z',
        },
      },
      subscriptionTier: 'X Premium+',
    },
  })}\n`);
  try {
    const environment = { GROK_HOME: grokHome };
    assert.equal(grokBillingLogPath(environment, root), logPath);
    const result = fetchGrokQuota({
      environment,
      home: root,
      now: new Date('2026-09-08T03:00:00Z'),
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.source, 'local');
    assert.equal(result.planLabel, 'X Premium+');
    assert.equal(result.meters[0].utilization, 30);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Grok fetch drops an expired billing period and handles a missing log quietly', () => {
  const expired = parseGrokBillingLog(JSON.stringify({
    ts: '2026-09-01T00:00:00Z',
    msg: 'billing: fetched credits config',
    ctx: { config: {
      creditUsagePercent: 75,
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-08-24T00:00:00Z',
        end: '2026-08-31T00:00:00Z',
      },
    } },
  }), new Date('2026-09-08T00:00:00Z'));
  assert.equal(expired.active, false);

  const missing = fetchGrokQuota({
    environment: { GROK_HOME: '/definitely/missing/grok-home' },
    now: new Date('2026-09-08T00:00:00Z'),
  });
  assert.equal(missing.status, 'no_data');
});

test('Kimi parser supports summary, detail.remaining, duration, and reset spellings', () => {
  const meters = parseKimiUsage(kimiPayload, new Date('2026-09-07T00:00:00Z'));
  assert.equal(meters.length, 2);
  assert.deepEqual(meters[0], {
    id: '1-5h',
    label: '5h',
    utilization: 20,
    resetsAt: '2026-09-07T05:00:00.000Z',
    windowSeconds: 18_000,
  });
  assert.deepEqual(meters[1], {
    id: '0-weekly',
    label: '7d',
    utilization: 25,
    resetsAt: '2026-09-14T00:00:00.000Z',
    windowSeconds: 604_800,
  });
});

test('Kimi parser supports the Kimi Code 2.x usages schema', () => {
  const meters = parseKimiUsage({
    usages: {
      limit_5h: { used_ratio: 0.3, reset_time: '2026-09-11T18:00:00Z' },
      limit_7d: { used_ratio: 0.2, reset_time: '2026-09-17T00:00:00Z' },
      limit_month_total: { used_ratio: 0.4, reset_time: '2026-10-01T00:00:00Z' },
      limit_month_code: { used_ratio: '0.25', reset_time: '2026-10-01T00:00:00Z' },
    },
  });

  assert.deepEqual(meters, [
    {
      id: 'limit-5h', label: '5h', utilization: 30,
      resetsAt: '2026-09-11T18:00:00.000Z', windowSeconds: 18_000,
    },
    {
      id: 'limit-7d', label: '7d', utilization: 20,
      resetsAt: '2026-09-17T00:00:00.000Z', windowSeconds: 604_800,
    },
    {
      id: 'limit-month-total', label: 'Month', utilization: 40,
      resetsAt: '2026-10-01T00:00:00.000Z',
    },
    {
      id: 'limit-month-code', label: 'Monthly Code', utilization: 25,
      resetsAt: '2026-10-01T00:00:00.000Z',
    },
  ]);
});

test('quota layout keeps generic periods first and preserves extra-meter order', () => {
  const result = quotaResult({
    id: 'kimi-code',
    status: 'ok',
    meters: [
      { id: 'mcp', label: 'MCP', utilization: 4, windowSeconds: 2_592_000 },
      { id: 'weekly', label: 'Weekly', utilization: 30 },
      { id: 'sonnet', label: 'Sonnet', utilization: 40, windowSeconds: 604_800 },
      { id: 'five-hour', label: '5h', utilization: 10, windowSeconds: 18_000 },
      { id: 'extra', label: 'Extra', utilization: 50 },
    ],
  });

  assert.deepEqual(result.meters.map(meter => meter.label), [
    '5h', '7d', 'MCP', 'Sonnet', 'Extra',
  ]);
});

test('Kimi deduplicates weekly aliases after canonicalizing their labels', () => {
  const meters = parseKimiUsage({
    usage: { name: 'Weekly', used: 25, limit: 100 },
    limits: [{
      window: { duration: 7, timeUnit: 'DAY' },
      detail: { name: '7d', used: 25, limit: 100 },
    }],
  });

  assert.deepEqual(meters.map(meter => meter.label), ['7d']);
});

test('Kimi credential discovery names the current CLI home when no login exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-kimi-home-'));
  try {
    // No login anywhere: the current CLI's path is named, not the legacy one, so
    // `missing_credentials` and a later rotation both point at the file the
    // installed CLI writes (issue #112).
    assert.equal(kimiCredentialPath({}, root), join(root, '.kimi-code', 'credentials', 'kimi-code.json'));
    assert.equal(kimiCredentialPaths({}, root).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Kimi fetch keeps a fresh official login unchanged and sends bearer auth', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-kimi-quota-'));
  const share = join(root, 'share');
  mkdirSync(join(share, 'credentials'), { recursive: true });
  writeFileSync(join(share, 'credentials', 'kimi-code.json'), JSON.stringify({
    access_token: 'kimi-fixture-token',
    refresh_token: 'must-not-be-used',
    expires_at: 2_000_000_000,
  }));
  let authorization;
  try {
    assert.equal(kimiCredentialPath({ KIMI_SHARE_DIR: share }, root),
      join(share, 'credentials', 'kimi-code.json'));
    const result = await fetchKimiCodeQuota({
      environment: { KIMI_SHARE_DIR: share },
      home: root,
      now: new Date('2026-09-07T00:00:00Z'),
      fetchImpl: async (_url, request) => {
        authorization = request.headers.Authorization;
        return jsonResponse(kimiPayload);
      },
    });
    assert.equal(authorization, 'Bearer kimi-fixture-token');
    assert.equal(result.status, 'ok');
    assert.equal(result.meters.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Kimi fetch prefers the Kimi Code 2.x home and keeps the legacy login as fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-kimi-code-home-'));
  const currentPath = join(root, '.kimi-code', 'credentials', 'kimi-code.json');
  const legacyPath = join(root, '.kimi', 'credentials', 'kimi-code.json');
  mkdirSync(join(root, '.kimi-code', 'credentials'), { recursive: true });
  mkdirSync(join(root, '.kimi', 'credentials'), { recursive: true });
  writeFileSync(currentPath, JSON.stringify({
    access_token: 'current-token', refresh_token: 'current-refresh', expires_at: 2_000_000_000,
  }));
  writeFileSync(legacyPath, JSON.stringify({
    access_token: 'legacy-token', refresh_token: 'legacy-refresh', expires_at: 2_000_000_000,
  }));
  try {
    assert.deepEqual(kimiCredentialPaths({}, root), [currentPath, legacyPath]);
    assert.equal(kimiCredentialPath({}, root), currentPath);
    let authorization;
    const result = await fetchKimiCodeQuota({
      environment: {},
      home: root,
      now: new Date('2026-09-07T00:00:00Z'),
      fetchImpl: async (_url, request) => {
        authorization = request.headers.Authorization;
        return jsonResponse({ usages: {
          limit_5h: { used_ratio: 0.3, reset_time: '2026-09-07T05:00:00Z' },
          limit_7d: { used_ratio: 0.2, reset_time: '2026-09-14T00:00:00Z' },
        } });
      },
    });
    assert.equal(authorization, 'Bearer current-token');
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.meters.map(meter => meter.label), ['5h', '7d']);

    rmSync(join(root, '.kimi-code'), { recursive: true, force: true });
    assert.equal(kimiCredentialPath({}, root), legacyPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Kimi expired credentials without a refresh token return without network access', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-kimi-expired-'));
  mkdirSync(join(root, '.kimi', 'credentials'), { recursive: true });
  writeFileSync(join(root, '.kimi', 'credentials', 'kimi-code.json'), JSON.stringify({
    access_token: 'expired',
    expires_at: 1,
  }));
  let called = false;
  try {
    const result = await fetchKimiCodeQuota({
      environment: {},
      home: root,
      now: new Date('2026-09-07T00:00:00Z'),
      fetchImpl: async () => { called = true; },
    });
    assert.equal(result.status, 'expired_credentials');
    assert.equal(called, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Kimi refreshes an expiring login, rotates it atomically, and keeps mode private', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-kimi-refresh-'));
  const credentialDirectory = join(root, '.kimi', 'credentials');
  const credentialPath = join(credentialDirectory, 'kimi-code.json');
  const oauthURL = 'https://auth.example.test/token';
  const usageURL = 'https://api.example.test/usages';
  mkdirSync(credentialDirectory, { recursive: true });
  makePrivateWindowsFixtureDirectory(credentialDirectory);
  writeFileSync(credentialPath, JSON.stringify({
    access_token: 'expired-access-token',
    refresh_token: 'original-refresh-token',
    expires_at: 1,
    expires_in: 900,
    scope: 'openid',
    token_type: 'Bearer',
  }), { mode: 0o600 });
  const calls = [];
  try {
    const now = new Date('2026-09-07T00:00:00Z');
    const result = await fetchKimiCodeQuota({
      environment: {},
      home: root,
      oauthURL,
      usageURL,
      now,
      sleepImpl: async () => {},
      fetchImpl: async (url, request) => {
        calls.push([url, request]);
        if (url === oauthURL) {
          const body = new URLSearchParams(request.body);
          assert.equal(request.method, 'POST');
          assert.equal(body.get('grant_type'), 'refresh_token');
          assert.equal(body.get('refresh_token'), 'original-refresh-token');
          return jsonResponse({
            access_token: 'fresh-access-token',
            refresh_token: 'rotated-refresh-token',
            expires_in: 900,
            scope: 'openid',
            token_type: 'Bearer',
          });
        }
        assert.equal(request.headers.Authorization, 'Bearer fresh-access-token');
        return jsonResponse(kimiPayload);
      },
    });
    assert.equal(result.status, 'ok');
    assert.deepEqual(calls.map(call => call[0]), [oauthURL, usageURL]);
    const persisted = JSON.parse(readFileSync(credentialPath, 'utf8'));
    assert.equal(persisted.access_token, 'fresh-access-token');
    assert.equal(persisted.refresh_token, 'rotated-refresh-token');
    assert.equal(persisted.expires_at, now.getTime() / 1000 + 900);
    assertPrivateCredentialFile(credentialPath);
    assert.equal(readdirSync(credentialDirectory).some(name => name.includes('.tmp')), false);
    assert.equal(existsSync(`${credentialPath}.vibe-usage-refresh-lock`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Kimi retries usage once with a forced refresh after HTTP 401', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-kimi-usage-401-'));
  const credentialDirectory = join(root, '.kimi', 'credentials');
  mkdirSync(credentialDirectory, { recursive: true });
  writeFileSync(join(credentialDirectory, 'kimi-code.json'), JSON.stringify({
    access_token: 'rejected-access-token',
    refresh_token: 'usable-refresh-token',
    expires_at: 2_000_000_000,
    expires_in: 900,
  }), { mode: 0o600 });
  const authorizations = [];
  let refreshCalls = 0;
  try {
    const result = await fetchKimiCodeQuota({
      environment: {},
      home: root,
      oauthURL: 'https://auth.example.test/token',
      usageURL: 'https://api.example.test/usages',
      now: new Date('2026-09-07T00:00:00Z'),
      sleepImpl: async () => {},
      fetchImpl: async (url, request) => {
        if (url.includes('auth.example')) {
          refreshCalls += 1;
          return jsonResponse({
            access_token: 'replacement-access-token',
            refresh_token: 'replacement-refresh-token',
            expires_in: 900,
          });
        }
        authorizations.push(request.headers.Authorization);
        return authorizations.length === 1 ? jsonResponse({}, 401) : jsonResponse(kimiPayload);
      },
    });
    assert.equal(result.status, 'ok');
    assert.equal(refreshCalls, 1);
    assert.deepEqual(authorizations, [
      'Bearer rejected-access-token',
      'Bearer replacement-access-token',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Kimi serializes concurrent refreshes and reuses the rotated login', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-kimi-concurrent-refresh-'));
  const credentialDirectory = join(root, '.kimi', 'credentials');
  mkdirSync(credentialDirectory, { recursive: true });
  writeFileSync(join(credentialDirectory, 'kimi-code.json'), JSON.stringify({
    access_token: 'expired-concurrent-access',
    refresh_token: 'concurrent-refresh-token',
    expires_at: 1,
    expires_in: 900,
  }), { mode: 0o600 });
  let refreshCalls = 0;
  let usageCalls = 0;
  const options = {
    environment: {},
    home: root,
    oauthURL: 'https://auth.example.test/token',
    usageURL: 'https://api.example.test/usages',
    now: new Date('2026-09-07T00:00:00Z'),
    fetchImpl: async url => {
      if (url.includes('auth.example')) {
        refreshCalls += 1;
        await new Promise(resolve => setTimeout(resolve, 20));
        return jsonResponse({
          access_token: 'shared-fresh-access',
          refresh_token: 'shared-fresh-refresh',
          expires_in: 900,
        });
      }
      usageCalls += 1;
      return jsonResponse(kimiPayload);
    },
  };
  try {
    const results = await Promise.all([
      fetchKimiCodeQuota(options),
      fetchKimiCodeQuota(options),
    ]);
    assert.deepEqual(results.map(result => result.status), ['ok', 'ok']);
    assert.equal(refreshCalls, 1);
    assert.equal(usageCalls, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Kimi refresh lock coordinates separate CLI processes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-kimi-cross-process-'));
  const credentialDirectory = join(root, '.kimi', 'credentials');
  mkdirSync(credentialDirectory, { recursive: true });
  writeFileSync(join(credentialDirectory, 'kimi-code.json'), JSON.stringify({
    access_token: 'expired-cross-process-access',
    refresh_token: 'cross-process-refresh-token',
    expires_at: 1,
    expires_in: 900,
  }), { mode: 0o600 });
  let refreshCalls = 0;
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/token') {
      refreshCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 50));
      response.end(JSON.stringify({
        access_token: 'cross-process-fresh-access',
        refresh_token: 'cross-process-fresh-refresh',
        expires_in: 900,
      }));
      return;
    }
    response.end(JSON.stringify(kimiPayload));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const providerURL = pathToFileURL(join(process.cwd(), 'src', 'quotas', 'providers',
      'kimi-code.js')).href;
    const script = `
      import { fetchKimiCodeQuota } from ${JSON.stringify(providerURL)};
      const result = await fetchKimiCodeQuota({
        home: process.env.TEST_KIMI_HOME,
        environment: {},
        oauthURL: process.env.TEST_KIMI_OAUTH_URL,
        usageURL: process.env.TEST_KIMI_USAGE_URL,
        now: new Date('2026-09-07T00:00:00Z'),
      });
      process.stdout.write(result.status);
    `;
    const environment = {
      TEST_KIMI_HOME: root,
      TEST_KIMI_OAUTH_URL: `http://127.0.0.1:${address.port}/token`,
      TEST_KIMI_USAGE_URL: `http://127.0.0.1:${address.port}/usages`,
    };
    const results = await Promise.all([
      runNodeModule(script, environment),
      runNodeModule(script, environment),
    ]);
    assert.deepEqual(results, ['ok', 'ok']);
    assert.equal(refreshCalls, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('Kimi treats refresh HTTP 401 and 403 as unauthorized without leaking credentials', async t => {
  for (const status of [401, 403]) {
    await t.test(`HTTP ${status}`, async () => {
      const root = mkdtempSync(join(tmpdir(), `vibe-usage-kimi-refresh-${status}-`));
      const credentialDirectory = join(root, '.kimi', 'credentials');
      mkdirSync(credentialDirectory, { recursive: true });
      writeFileSync(join(credentialDirectory, 'kimi-code.json'), JSON.stringify({
        access_token: `secret-access-${status}`,
        refresh_token: `secret-refresh-${status}`,
        expires_at: 1,
      }), { mode: 0o600 });
      try {
        const result = await fetchKimiCodeQuota({
          environment: {},
          home: root,
          oauthURL: 'https://auth.example.test/token',
          now: new Date('2026-09-07T00:00:00Z'),
          sleepImpl: async () => {},
          fetchImpl: async () => jsonResponse({
            error_description: `server echoed secret-refresh-${status}`,
          }, status),
        });
        const serialized = JSON.stringify(result);
        assert.equal(result.status, 'unauthorized');
        assert.equal(serialized.includes(`secret-access-${status}`), false);
        assert.equal(serialized.includes(`secret-refresh-${status}`), false);
        assert.equal(serialized.includes('server echoed'), false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('Kimi refresh retry failures stay generic and never include token-shaped server errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-kimi-refresh-redaction-'));
  const credentialDirectory = join(root, '.kimi', 'credentials');
  mkdirSync(credentialDirectory, { recursive: true });
  writeFileSync(join(credentialDirectory, 'kimi-code.json'), JSON.stringify({
    access_token: 'secret-expired-access',
    refresh_token: 'secret-refresh-value',
    expires_at: 1,
  }), { mode: 0o600 });
  let calls = 0;
  try {
    const result = await fetchKimiCodeQuota({
      environment: {},
      home: root,
      oauthURL: 'https://auth.example.test/token',
      now: new Date('2026-09-07T00:00:00Z'),
      sleepImpl: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ error_description: 'secret-refresh-value' }, 503);
      },
    });
    const serialized = JSON.stringify(result);
    assert.equal(calls, 3);
    assert.equal(result.status, 'retryable_error');
    assert.equal(serialized.includes('secret-expired-access'), false);
    assert.equal(serialized.includes('secret-refresh-value'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Z.ai parser maps plan windows and count-derived MCP utilization', () => {
  const parsed = parseZaiQuota(zaiPayload, new Date('2026-08-01T00:00:00Z'));
  assert.equal(parsed.planLabel, 'Pro');
  assert.deepEqual(parsed.meters.map(meter => [meter.label, meter.utilization]), [
    ['5h', 25],
    ['7d', 9],
    ['MCP', 22.4],
  ]);
  assert.equal(parsed.meters[0].windowSeconds, 5 * 3600);
  assert.equal(parsed.meters[1].windowSeconds, 7 * 86400);
});

test('provider meter identifiers remain unique when upstream identifiers repeat', () => {
  const kimi = parseKimiUsage({
    limits: [
      { id: 'same', name: 'Primary', used: 1, limit: 10 },
      { id: 'same', name: 'Secondary', used: 2, limit: 10 },
    ],
  });
  assert.deepEqual(kimi.map(meter => meter.id), ['0-same', '1-same']);

  const zai = parseZaiQuota({
    code: 200,
    success: true,
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10 },
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 20 },
      ],
    },
  });
  assert.deepEqual(zai.meters.map(meter => meter.id), [
    '0-tokens_limit-3-5',
    '1-tokens_limit-3-5',
  ]);
});

test('ZCode fetch requires an explicit regional key and isolates authorization failure', async () => {
  let called = false;
  const missing = await fetchZaiQuota({
    environment: {},
    fetchImpl: async () => { called = true; },
  });
  assert.equal(missing.status, 'missing_credentials');
  assert.equal(called, false);

  let authorization;
  const denied = await fetchZaiQuota({
    environment: { Z_AI_API_KEY: 'zai-fixture-key' },
    fetchImpl: async (_url, request) => {
      authorization = request.headers.Authorization;
      return jsonResponse({}, 401);
    },
  });
  assert.equal(authorization, 'Bearer zai-fixture-key');
  assert.equal(denied.status, 'unauthorized');
});

test('ZCode routes BigModel and Z.ai keys only to their matching regional quota hosts', async () => {
  const requests = [];
  const fetchImpl = async (url, request) => {
    requests.push([url, request.headers.Authorization]);
    return jsonResponse(zaiPayload);
  };

  const bigModel = await fetchZaiQuota({
    environment: { BIGMODEL_API_KEY: 'bigmodel-fixture-key' },
    fetchImpl,
  });
  const zai = await fetchZaiQuota({
    environment: { Z_AI_API_KEY: 'zai-fixture-key' },
    fetchImpl,
  });

  assert.equal(bigModel.status, 'ok');
  assert.equal(zai.status, 'ok');
  assert.notEqual(bigModel.cacheScope, zai.cacheScope);
  assert.deepEqual(requests, [
    [
      'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
      'Bearer bigmodel-fixture-key',
    ],
    [
      'https://api.z.ai/api/monitor/usage/quota/limit',
      'Bearer zai-fixture-key',
    ],
  ]);
});

test('an explicitly named BigModel key wins without sending either key to the other region', async () => {
  let request;
  const result = await fetchZaiQuota({
    environment: {
      BIGMODEL_API_KEY: 'bigmodel-fixture-key',
      Z_AI_API_KEY: 'zai-fixture-key',
    },
    fetchImpl: async (url, options) => {
      request = [url, options.headers.Authorization];
      return jsonResponse(zaiPayload);
    },
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(request, [
    'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
    'Bearer bigmodel-fixture-key',
  ]);
});

test('fetch handles only requested products and uses sanitized cache on transient failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-quota-cache-'));
  mkdirSync(join(root, '.kimi', 'credentials'), { recursive: true });
  writeFileSync(join(root, '.kimi', 'credentials', 'kimi-code.json'), JSON.stringify({
    access_token: 'must-never-enter-cache',
    expires_at: 2_000_000_000,
  }));
  const environment = { VIBE_USAGE_QUOTA_CACHE_DIR: join(root, 'cache') };
  try {
    const live = await fetchQuotaProducts(['kimi-code'], {
      environment,
      home: root,
      now: new Date('2026-09-07T00:00:00Z'),
      fetchImpl: async () => jsonResponse(kimiPayload),
    });
    assert.deepEqual(live.products.map(product => product.id), ['kimi-code']);
    assert.equal(live.products[0].source, 'live');
    const cacheText = readFileSync(join(root, 'cache', 'quota-cache.json'), 'utf8');
    assert.equal(cacheText.includes('must-never-enter-cache'), false);

    const cached = await fetchQuotaProducts(['kimi-code'], {
      environment,
      home: root,
      now: new Date('2026-09-07T01:00:00Z'),
      fetchImpl: async () => { throw new Error('offline'); },
    });
    assert.equal(cached.products[0].status, 'ok');
    assert.equal(cached.products[0].source, 'cache');
    assert.equal(JSON.stringify(cached).includes('must-never-enter-cache'), false);

    const cachedAfterServerError = await fetchQuotaProducts(['kimi-code'], {
      environment,
      home: root,
      now: new Date('2026-09-07T01:30:00Z'),
      fetchImpl: async () => jsonResponse({}, 503),
    });
    assert.equal(cachedAfterServerError.products[0].status, 'ok');
    assert.equal(cachedAfterServerError.products[0].source, 'cache');

    writeFileSync(join(root, '.kimi', 'credentials', 'kimi-code.json'), JSON.stringify({
      access_token: 'a-different-account-token',
      expires_at: 2_000_000_000,
    }));
    const differentAccount = await fetchQuotaProducts(['kimi-code'], {
      environment,
      home: root,
      now: new Date('2026-09-07T02:00:00Z'),
      fetchImpl: async () => { throw new Error('offline'); },
    });
    assert.equal(differentAccount.products[0].status, 'retryable_error');
    assert.equal(differentAccount.products[0].source, 'live');

    writeFileSync(join(root, '.kimi', 'credentials', 'kimi-code.json'), JSON.stringify({
      access_token: 'must-never-enter-cache',
      expires_at: 2_000_000_000,
    }));
    const stale = await fetchQuotaProducts(['kimi-code'], {
      environment,
      home: root,
      now: new Date('2026-09-16T00:00:00Z'),
      fetchImpl: async () => { throw new Error('offline'); },
    });
    assert.equal(stale.products[0].status, 'retryable_error');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
