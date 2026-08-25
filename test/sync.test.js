import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import {
  resolveCodexExtraHome,
  resolveCachedUploadProjectSetting,
  resolveOptionalBoolean,
  resolveSyncHostname,
  resolveUploadProjectSetting,
  mapWithConcurrency,
} from '../src/sync.js';
import { normalizeParserResult } from '../src/parsers/contract.js';

const execFileAsync = promisify(execFile);

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('local project deny overrides the server and works without a response', () => {
  assert.equal(resolveUploadProjectSetting({ uploadProject: true }), true);
  assert.equal(resolveUploadProjectSetting({ uploadProject: false }), false);
  assert.equal(resolveUploadProjectSetting({ uploadProject: true }, false), false);
  assert.equal(resolveUploadProjectSetting(undefined, false), false);
});

test('unavailable or malformed settings abort instead of becoming false', () => {
  for (const settings of [null, undefined, {}, { uploadProject: 'false' }]) {
    assert.throws(
      () => resolveUploadProjectSetting(settings),
      error => error.code === 'SETTINGS_UNAVAILABLE',
    );
  }
});

test('privacy config accepts only JSON booleans', () => {
  assert.equal(resolveOptionalBoolean(undefined, 'uploadProject'), undefined);
  assert.equal(resolveOptionalBoolean(true, 'uploadProject'), true);
  assert.equal(resolveOptionalBoolean(false, 'uploadProject'), false);
  assert.throws(
    () => resolveOptionalBoolean('false', 'uploadProject'),
    error => error.code === 'INVALID_CONFIG',
  );
});

test('hostname privacy uses a stable opaque id without reading the system hostname', () => {
  const config = {
    hostname: 'secret-workstation',
    uploadHostname: false,
  };
  let hostnameReads = 0;
  const first = resolveSyncHostname(config, {
    systemHostname: () => {
      hostnameReads++;
      return 'must-not-be-read';
    },
    createDeviceId: () => 'device-0011223344556677',
  });
  const second = resolveSyncHostname(config, {
    systemHostname: () => {
      hostnameReads++;
      return 'must-not-be-read';
    },
    createDeviceId: () => 'device-8899aabbccddeeff',
  });

  assert.equal(first.hostname, 'device-0011223344556677');
  assert.equal(first.previousHostname, 'secret-workstation');
  assert.equal(first.changed, true);
  assert.equal(second.hostname, first.hostname);
  assert.equal(second.changed, false);
  assert.equal(hostnameReads, 0);
});

test('cached project-upload settings are scoped to the confirming API', () => {
  const config = {
    lastUploadProject: true,
    lastUploadProjectApiUrl: 'https://confirmed.example',
  };
  assert.equal(
    resolveCachedUploadProjectSetting(config, 'https://confirmed.example'),
    true,
  );
  assert.equal(
    resolveCachedUploadProjectSetting(config, 'https://different.example'),
    undefined,
  );
  assert.equal(
    resolveCachedUploadProjectSetting({ lastUploadProject: false }, 'https://confirmed.example'),
    undefined,
  );
});

test('temporary extra Codex home overrides persisted config only for this run', () => {
  assert.equal(resolveCodexExtraHome('/persisted/.codex', '/temporary/.codex'), '/temporary/.codex');
  assert.equal(resolveCodexExtraHome('/persisted/.codex', undefined), '/persisted/.codex');
});

test('mapWithConcurrency preserves order and bounds in-flight work', async () => {
  const order = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const result = await mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, n % 2 === 0 ? 10 : 1));
    inFlight--;
    order.push(n);
    return n * 10;
  });
  // Output order follows input order, not completion order.
  assert.deepEqual(result, [0, 10, 20, 30, 40, 50, 60, 70]);
  assert.ok(maxInFlight <= 3);
  assert.deepEqual(order.slice().sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]); // every item ran once
});

test('normalizeParserResult accepts object and legacy bare-array shapes', () => {
  const buckets = [{ source: 'codex', model: 'm' }];
  assert.deepEqual(normalizeParserResult('codex', { buckets, sessions: [] }), {
    buckets, sessions: [], skipped: false, warnings: [],
  });
  assert.deepEqual(normalizeParserResult('codex', buckets), {
    buckets, sessions: [], skipped: false, warnings: [],
  });
});

test('normalizeParserResult rejects malformed results', () => {
  assert.throws(() => normalizeParserResult('codex', { buckets: 'nope', sessions: [] }), /invalid result/);
  assert.throws(() => normalizeParserResult('codex', { buckets: [], sessions: 'nope' }), /invalid result/);
  assert.throws(() => normalizeParserResult('codex', null), /invalid result/);
});

test('normalizeParserResult rejects sources that mismatch the registry key', () => {
  assert.throws(
    () => normalizeParserResult('cursor', {
      buckets: [{ source: 'codex', model: 'm' }],
      sessions: [],
    }),
    /emitted a bucket with source="codex"/,
  );
  assert.throws(
    () => normalizeParserResult('cursor', {
      buckets: [],
      sessions: [{ source: 'codex', sessionHash: 's' }],
    }),
    /emitted a session with source="codex"/,
  );
});

test('a successful batch is persisted before a later batch fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-sync-batches-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const homeDir = join(root, 'home');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  const received = [];
  let phase = 'first';
  try {
    await withServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/usage/settings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ uploadProject: true }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/usage/ingest') {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          const compressed = Buffer.concat(chunks);
          const body = req.headers['content-encoding'] === 'gzip'
            ? gunzipSync(compressed)
            : compressed;
          const payload = JSON.parse(body.toString('utf8'));
          received.push({ phase, buckets: payload.buckets.length });
          const phaseRequestCount = received.filter(item => item.phase === phase).length;

          if (phase === 'first' && phaseRequestCount === 2) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'forced tail failure' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            ingested: payload.buckets.length,
            sessions: payload.sessions?.length || 0,
          }));
        });
        return;
      }
      res.writeHead(404).end();
    }, async apiUrl => {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        apiKey: 'vbu_sync_batch_test',
        apiUrl,
        hostname: 'sync-batch-test',
      }));
      const env = {
        ...process.env,
        HOME: homeDir,
        VIBE_USAGE_DEV: '0',
        VIBE_USAGE_CONFIG_DIR: configDir,
        VIBE_USAGE_STATE_DIR: stateDir,
      };
      const command = `
        import { parsers } from './src/parsers/index.js';
        for (const source of Object.keys(parsers)) delete parsers[source];
        parsers['sync-batch-test'] = async () => ({
          buckets: Array.from({ length: 101 }, (_, index) => ({
            source: 'sync-batch-test',
            model: 'model-' + index,
            project: 'project',
            bucketStart: '2026-08-15T00:00:00.000Z',
            inputTokens: index + 1,
            outputTokens: 0,
            cachedInputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: index + 1,
          })),
          sessions: [],
        });
        const { runSync } = await import('./src/sync.js');
        await runSync({ throws: true, quiet: true });
      `;

      await assert.rejects(
        execFileAsync(process.execPath, ['--input-type=module', '-e', command], {
          cwd: process.cwd(),
          env,
        }),
        error => /HTTP 400/.test(`${error.message}\n${error.stderr || ''}`),
      );
      const partialState = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
      assert.equal(Object.keys(partialState.buckets).length, 100);

      phase = 'retry';
      await execFileAsync(process.execPath, ['--input-type=module', '-e', command], {
        cwd: process.cwd(),
        env,
      });
      const completeState = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
      assert.equal(Object.keys(completeState.buckets).length, 101);
    });

    assert.deepEqual(received, [
      { phase: 'first', buckets: 100 },
      { phase: 'first', buckets: 1 },
      { phase: 'retry', buckets: 1 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local privacy controls sanitize every network hostname and project field', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-network-privacy-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const homeDir = join(root, 'home');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  let settingsRequests = 0;
  let received;
  try {
    await withServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/usage/settings') {
        settingsRequests++;
        res.writeHead(500).end();
        return;
      }
      if (req.method === 'POST' && req.url === '/api/usage/ingest') {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          const compressed = Buffer.concat(chunks);
          const body = req.headers['content-encoding'] === 'gzip'
            ? gunzipSync(compressed)
            : compressed;
          received = JSON.parse(body.toString('utf8'));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ingested: 1, sessions: 1 }));
        });
        return;
      }
      res.writeHead(404).end();
    }, async apiUrl => {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        apiKey: 'vbu_privacy_test',
        apiUrl,
        hostname: 'employee-secret-mac',
        uploadProject: false,
        uploadHostname: false,
        deviceId: 'device-0011223344556677',
      }));
      const env = {
        ...process.env,
        HOME: homeDir,
        VIBE_USAGE_DEV: '0',
        VIBE_USAGE_CONFIG_DIR: configDir,
        VIBE_USAGE_STATE_DIR: stateDir,
      };
      const command = `
        import { parsers } from './src/parsers/index.js';
        for (const source of Object.keys(parsers)) delete parsers[source];
        parsers['privacy-test'] = async () => ({
          buckets: [{
            source: 'privacy-test',
            model: 'model',
            project: 'customer-secret-project',
            bucketStart: '2026-08-25T00:00:00.000Z',
            inputTokens: 10,
            outputTokens: 2,
            cachedInputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 12,
          }],
          sessions: [{
            source: 'privacy-test',
            project: 'customer-secret-project',
            sessionHash: 'session-hash',
            firstMessageAt: '2026-08-25T00:00:00.000Z',
            lastMessageAt: '2026-08-25T00:01:00.000Z',
            durationSeconds: 60,
            activeSeconds: 30,
            messageCount: 2,
            userMessageCount: 1,
            userPromptHours: [0, 1],
          }],
        });
        const { runSync } = await import('./src/sync.js');
        await runSync({ throws: true, quiet: true });
      `;
      await execFileAsync(process.execPath, ['--input-type=module', '-e', command], {
        cwd: process.cwd(),
        env,
      });
    });

    assert.equal(settingsRequests, 0);
    assert.equal(received.buckets[0].project, 'unknown');
    assert.equal(received.buckets[0].hostname, 'device-0011223344556677');
    assert.equal(received.sessions[0].project, 'unknown');
    assert.equal(received.sessions[0].hostname, 'device-0011223344556677');
    assert.equal(received.client.hostname, 'device-0011223344556677');
    assert.doesNotMatch(JSON.stringify(received), /employee-secret-mac|customer-secret-project/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
