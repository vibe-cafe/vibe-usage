import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import {
  resolveCodexExtraHome,
  resolveCachedUploadProjectSetting,
  resolveUploadProjectSetting,
  mapWithConcurrency,
  formatDuration,
  estimateRemainingSeconds,
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

test('explicit project-upload settings preserve both privacy choices', () => {
  assert.equal(resolveUploadProjectSetting({ uploadProject: true }), true);
  assert.equal(resolveUploadProjectSetting({ uploadProject: false }), false);
});

test('unavailable or malformed settings abort instead of becoming false', () => {
  for (const settings of [null, undefined, {}, { uploadProject: 'false' }]) {
    assert.throws(
      () => resolveUploadProjectSetting(settings),
      error => error.code === 'SETTINGS_UNAVAILABLE',
    );
  }
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

// A quiet (daemon) sync used to drop Cursor's fetch soft-skip warning on the
// floor, so an export that failed on every single run left no trace anywhere:
// daemon.log empty, `status` still reporting the tool as installed. Warnings
// must reach stderr regardless of quiet, or a permanent failure is invisible.
// Without an up-front total, a multi-thousand-batch first sync is
// indistinguishable from a hang: the per-batch line only ever shows one batch.
test('a sync announces how much it is about to upload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-pending-line-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const homeDir = join(root, 'home');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  try {
    await withServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/usage/settings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ uploadProject: true }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/usage/ingest') {
        req.on('data', () => {});
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ingested: 250, sessions: 0 }));
        });
        return;
      }
      res.writeHead(404).end();
    }, async apiUrl => {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        apiKey: 'vbu_pending_line_test',
        apiUrl,
        hostname: 'pending-line-test',
      }));
      const command = `
        import { parsers } from './src/parsers/index.js';
        for (const source of Object.keys(parsers)) delete parsers[source];
        parsers['pending-line-test'] = async () => ({
          buckets: Array.from({ length: 250 }, (_, index) => ({
            source: 'pending-line-test',
            model: 'model-' + index,
            project: 'project',
            bucketStart: '2026-09-09T00:00:00.000Z',
            inputTokens: index + 1,
            outputTokens: 0,
            cachedInputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: index + 1,
          })),
          sessions: [],
        });
        const { runSync } = await import('./src/sync.js');
        await runSync({ throws: true });
      `;
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--input-type=module', '-e', command],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: homeDir,
            VIBE_USAGE_DEV: '0',
            VIBE_USAGE_CONFIG_DIR: configDir,
            VIBE_USAGE_STATE_DIR: stateDir,
          },
        },
      );
      assert.match(stdout, /待上传 250 buckets，分 3 批/);
      assert.match(stdout, /上传 .+（已压缩），用时/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a quiet sync still writes a parser skip warning to stderr', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-quiet-warning-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const homeDir = join(root, 'home');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  try {
    await withServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/usage/settings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ uploadProject: true }));
        return;
      }
      res.writeHead(404).end();
    }, async apiUrl => {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        apiKey: 'vbu_quiet_warning_test',
        apiUrl,
        hostname: 'quiet-warning-test',
      }));
      const command = `
        import { parsers } from './src/parsers/index.js';
        for (const source of Object.keys(parsers)) delete parsers[source];
        parsers['cursor'] = async () => ({
          buckets: [],
          sessions: [],
          skipped: true,
          warnings: ['cursor: Cursor usage export skipped (timeout after 120000ms). …'],
        });
        const { runSync } = await import('./src/sync.js');
        await runSync({ throws: true, quiet: true });
      `;
      const { stderr } = await execFileAsync(
        process.execPath,
        ['--input-type=module', '-e', command],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: homeDir,
            VIBE_USAGE_DEV: '0',
            VIBE_USAGE_CONFIG_DIR: configDir,
            VIBE_USAGE_STATE_DIR: stateDir,
          },
        },
      );
      assert.match(stderr, /Cursor usage export skipped/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// `sync` used to print its header and then nothing at all until every parser
// had finished: a cold Codex index build or a 120s Cursor export left the
// terminal blank for minutes, which is indistinguishable from a hang. The live
// line is TTY-only, so a forced run proves the rendering and the redraw, while
// an ordinary piped run proves the desktop apps still get bare result text.
test('silent sync phases report live status only on a TTY', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-progress-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const homeDir = join(root, 'home');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  try {
    await withServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/usage/settings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ uploadProject: true }));
        return;
      }
      res.writeHead(404).end();
    }, async apiUrl => {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        apiKey: 'vbu_progress_test',
        apiUrl,
        hostname: 'progress-test',
      }));
      const command = `
        import { parsers } from './src/parsers/index.js';
        for (const source of Object.keys(parsers)) delete parsers[source];
        parsers['progress-test'] = async () => {
          await new Promise(resolve => setTimeout(resolve, 400));
          return { buckets: [], sessions: [] };
        };
        const { runSync } = await import('./src/sync.js');
        await runSync({ throws: true });
      `;
      const baseEnv = {
        ...process.env,
        HOME: homeDir,
        VIBE_USAGE_DEV: '0',
        VIBE_USAGE_CONFIG_DIR: configDir,
        VIBE_USAGE_STATE_DIR: stateDir,
      };
      const runSyncProcess = extraEnv => execFileAsync(
        process.execPath,
        ['--input-type=module', '-e', command],
        { cwd: process.cwd(), env: { ...baseEnv, ...extraEnv } },
      );

      const forced = await runSyncProcess({
        VIBE_USAGE_FORCE_PROGRESS: '1',
        VIBE_USAGE_PROGRESS_INTERVAL_MS: '100',
      });
      assert.match(forced.stdout, /正在读取上传设置 · 已用时 0s/);
      // The 400ms parser outlives several 100ms ticks: the first render draws
      // immediately, the rest prove the redraw keeps the line alive.
      const scanRenders = forced.stdout.match(/正在扫描本地日志 0\/1 · 已用时 0s/g) || [];
      assert.ok(scanRenders.length >= 2, `expected repeated status renders, got ${scanRenders.length}`);
      // ...and the line is erased before the regular output continues on it.
      assert.match(forced.stdout, /\x1b\[K/);

      const piped = await runSyncProcess({});
      assert.match(piped.stdout, /暂无新数据/);
      assert.doesNotMatch(piped.stdout, /正在读取上传设置|正在扫描本地日志/);
      assert.doesNotMatch(piped.stdout, /\x1b\[K/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('formatDuration renders seconds, minutes and hours', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(59), '59s');
  assert.equal(formatDuration(60), '1m');
  assert.equal(formatDuration(90), '1m30s');
  assert.equal(formatDuration(600), '10m');
  assert.equal(formatDuration(3600), '1h');
  assert.equal(formatDuration(3660), '1h 1m');
  // Unchanged from the session-summary formatter this replaced.
  assert.equal(formatDuration(251880), '69h 58m');
  assert.equal(formatDuration(-5), '0s');
});

// The estimate is extrapolated from batches that actually finished. A first
// sync and a steady-state trickle differ by orders of magnitude, so any
// a-priori rate would be wrong for one of them -- report nothing instead.
test('remaining-time estimate only extrapolates from completed batches', () => {
  assert.equal(estimateRemainingSeconds({ elapsedMs: 5000, doneBatches: 0, totalBatches: 53 }), null);
  assert.equal(estimateRemainingSeconds({ elapsedMs: 0, doneBatches: 3, totalBatches: 53 }), null);
  assert.equal(estimateRemainingSeconds({ elapsedMs: 5000, doneBatches: 53, totalBatches: 53 }), null);
  assert.equal(estimateRemainingSeconds({ elapsedMs: 5000, doneBatches: 1, totalBatches: 53 }), 260);
  assert.equal(estimateRemainingSeconds({ elapsedMs: 10_000, doneBatches: 2, totalBatches: 4 }), 10);
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

// Re-binding the CLI to another account (init again, `config set apiKey`, or a
// desktop app rewriting config.json) used to be invisible to state.json: the
// incremental diff matched every bucket the *previous* account had uploaded and
// sent nothing, so the new account received no history while sync still printed
// success. The state must be scoped to its upload target.
test('a changed API key re-uploads the whole local history exactly once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-rebind-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const homeDir = join(root, 'home');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  const received = [];
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
          const body = req.headers['content-encoding'] === 'gzip'
            ? gunzipSync(Buffer.concat(chunks))
            : Buffer.concat(chunks);
          const payload = JSON.parse(body.toString('utf8'));
          received.push(payload.buckets.length);
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
      const writeKey = (apiKey) => writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        apiKey,
        apiUrl,
        hostname: 'rebind-test',
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
        parsers['rebind-test'] = async () => ({
          buckets: Array.from({ length: 3 }, (_, index) => ({
            source: 'rebind-test',
            model: 'model-' + index,
            project: 'project',
            bucketStart: '2026-09-18T00:00:00.000Z',
            inputTokens: index + 1,
            outputTokens: 0,
            cachedInputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: index + 1,
          })),
          sessions: [],
        });
        const { runSync } = await import('./src/sync.js');
        await runSync({ throws: true });
      `;
      const sync = () => execFileAsync(process.execPath, ['--input-type=module', '-e', command], {
        cwd: process.cwd(), env,
      });

      // First account: full upload, state records the target.
      writeKey('vbu_account_a');
      const first = await sync();
      assert.doesNotMatch(first.stdout, /检测到上传账号已更换/);
      const firstState = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
      assert.equal(Object.keys(firstState.buckets).length, 3);
      assert.equal(firstState.identity.apiUrl, apiUrl);
      assert.equal(firstState.identity.keyFingerprint.length, 16);
      assert.equal(readFileSync(join(stateDir, 'state.json'), 'utf8').includes('vbu_account_a'), false);

      // Re-bind: the same local history must reach the new account in full.
      writeKey('vbu_account_b');
      const second = await sync();
      assert.match(second.stdout, /检测到上传账号已更换，本次全量重传本地历史/);
      const secondState = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
      assert.equal(Object.keys(secondState.buckets).length, 3);
      assert.notEqual(secondState.identity.keyFingerprint, firstState.identity.keyFingerprint);

      // Steady state on the new account: nothing left to send.
      const third = await sync();
      assert.doesNotMatch(third.stdout, /检测到上传账号已更换/);
      assert.match(third.stdout, /无新增数据。/);
    });

    // 3 buckets for the first account, 3 again for the second, none for the third run.
    assert.deepEqual(received, [3, 3]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Buckets AND sessions of a source the backend soft-drops must both stay
// uncommitted, so the first sync after the server registers that source
// re-sends them instead of losing them permanently.
test('dropped unknown sources leave bucket and session state uncommitted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-dropped-source-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const homeDir = join(root, 'home');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  const received = [];
  let dropUnknownSource = true;
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
          const body = req.headers['content-encoding'] === 'gzip'
            ? gunzipSync(Buffer.concat(chunks))
            : Buffer.concat(chunks);
          const payload = JSON.parse(body.toString('utf8'));
          received.push({ buckets: payload.buckets.length, sessions: payload.sessions?.length || 0 });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(dropUnknownSource
            ? {
                ingested: 0,
                sessions: 0,
                dropped: {
                  buckets: payload.buckets.length,
                  unknownSources: ['devin'],
                },
              }
            : {
                ingested: payload.buckets.length,
                sessions: payload.sessions?.length || 0,
              }));
        });
        return;
      }
      res.writeHead(404).end();
    }, async apiUrl => {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        apiKey: 'vbu_dropped_source_test',
        apiUrl,
        hostname: 'dropped-source-test',
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
        parsers['devin'] = async () => ({
          buckets: [{
            source: 'devin', model: 'swe-2-high', project: 'project',
            bucketStart: '2026-09-16T00:00:00.000Z',
            inputTokens: 1, outputTokens: 2,
            cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 3,
          }],
          sessions: [{
            source: 'devin', project: 'project', sessionHash: 'abc',
            firstMessageAt: '2026-09-16T00:00:00.000Z',
            lastMessageAt: '2026-09-16T00:10:00.000Z',
            durationSeconds: 600, activeSeconds: 100,
            messageCount: 4, userMessageCount: 1,
            userPromptHours: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
          }],
        });
        const { runSync } = await import('./src/sync.js');
        await runSync({ throws: true, quiet: true });
      `;

      // First sync: the backend drops the unknown source — nothing is
      // committed (state.json may not even exist yet).
      await execFileAsync(process.execPath, ['--input-type=module', '-e', command], {
        cwd: process.cwd(), env,
      });
      const droppedState = existsSync(join(stateDir, 'state.json'))
        ? JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'))
        : {};
      assert.equal(Object.keys(droppedState.buckets || {}).length, 0);
      assert.equal(Object.keys(droppedState.sessions || {}).length, 0);

      // After the backend learns the source, the next sync re-sends and commits.
      dropUnknownSource = false;
      await execFileAsync(process.execPath, ['--input-type=module', '-e', command], {
        cwd: process.cwd(), env,
      });
      const committedState = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
      assert.equal(Object.keys(committedState.buckets).length, 1);
      assert.equal(Object.keys(committedState.sessions).length, 1);
    });

    assert.deepEqual(received, [
      { buckets: 1, sessions: 1 },
      { buckets: 1, sessions: 1 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A bucket the backend dropped for a reason it did not attribute to a key
// (unknown model / implausible value) must stay uncommitted too, so the next
// sync retries it instead of the usage disappearing for good.
test('dropped buckets without a key stay uncommitted and are retried', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-dropped-key-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const homeDir = join(root, 'home');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  const received = [];
  let dropUnknownModel = true;
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
          const body = req.headers['content-encoding'] === 'gzip'
            ? gunzipSync(Buffer.concat(chunks))
            : Buffer.concat(chunks);
          const payload = JSON.parse(body.toString('utf8'));
          received.push(payload.buckets.length);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(dropUnknownModel
            ? {
                ingested: 0,
                sessions: 0,
                dropped: {
                  buckets: payload.buckets.length,
                  unknownModels: payload.buckets.length,
                },
              }
            : {
                ingested: payload.buckets.length,
                sessions: payload.sessions?.length || 0,
              }));
        });
        return;
      }
      res.writeHead(404).end();
    }, async apiUrl => {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        apiKey: 'vbu_dropped_key_test',
        apiUrl,
        hostname: 'dropped-key-test',
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
        parsers['devin'] = async () => ({
          buckets: [{
            source: 'devin', model: 'swe-2-high', project: 'project',
            bucketStart: '2026-09-16T00:00:00.000Z',
            inputTokens: 1, outputTokens: 2,
            cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 3,
          }],
          sessions: [],
        });
        const { runSync } = await import('./src/sync.js');
        await runSync({ throws: true, quiet: true });
      `;

      // First sync: the backend drops the bucket for an unknown model. The
      // hash must not be committed, or the bucket would never be sent again.
      await execFileAsync(process.execPath, ['--input-type=module', '-e', command], {
        cwd: process.cwd(), env,
      });
      const droppedState = existsSync(join(stateDir, 'state.json'))
        ? JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'))
        : {};
      assert.equal(Object.keys(droppedState.buckets || {}).length, 0);

      // The backend learns the model: the next sync re-sends and commits.
      dropUnknownModel = false;
      await execFileAsync(process.execPath, ['--input-type=module', '-e', command], {
        cwd: process.cwd(), env,
      });
      const committedState = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
      assert.equal(Object.keys(committedState.buckets).length, 1);
    });

    assert.deepEqual(received, [1, 1]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
