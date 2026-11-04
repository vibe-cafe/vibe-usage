// A slow network parser (Cursor's whole-account export) uploads last instead of
// holding back every other tool (issue #131). Fake parsers and a local ingest
// stand-in only; HOME, config and state live in a temporary directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

const execFileAsync = promisify(execFile);

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      resolve(req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw);
    });
  });
}

/** Settings + ingest stand-in. `failSource` makes any batch holding it fail with HTTP 400. */
async function withBackend(run, { failSource } = {}) {
  const backend = { ingests: [] };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/api/usage/settings') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ uploadProject: true }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/test/received') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(backend.ingests.flatMap(i => i.sources)));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/usage/ingest') {
      const payload = JSON.parse((await readBody(req)).toString('utf8'));
      const sources = payload.buckets.map(b => b.source);
      if (failSource && sources.includes(failSource)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'forced failure' }));
        return;
      }
      backend.ingests.push({ sources, syncId: payload.client?.syncId, batch: [payload.client?.batchIndex, payload.client?.batchCount] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ingested: payload.buckets.length, sessions: 0 }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  backend.url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(backend);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const bucket = source => `({
  source: '${source}', model: 'm', project: 'p', bucketStart: '2026-11-01T00:00:00.000Z',
  inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 2,
})`;

// `cursor` finishes only after the local tool's upload reached the server --
// impossible if runSync still waited for every parser before uploading.
const SLOW_CURSOR = `
  parsers['cursor'] = async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const res = await fetch(process.env.TEST_API + '/test/received');
      if ((await res.json()).includes('local-fast')) return { buckets: [${bucket('cursor')}], sessions: [] };
      await new Promise(r => setTimeout(r, 50));
    }
    return { buckets: [${bucket('cursor-waited-for-everything')}], sessions: [] };
  };
`;

function runSyncScript(cursorParser) {
  return `
    import { parsers } from './src/parsers/index.js';
    for (const source of Object.keys(parsers)) delete parsers[source];
    parsers['local-fast'] = async () => ({ buckets: [${bucket('local-fast')}], sessions: [] });
    ${cursorParser}
    const { runSync } = await import('./src/sync.js');
    await runSync();
  `;
}

async function inSandbox(backend, fn, extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-deferred-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    apiKey: 'vbu_deferred', apiUrl: backend.url, hostname: 'deferred-host',
  }));
  const env = {
    ...process.env,
    HOME: root,
    VIBE_USAGE_DEV: '0',
    VIBE_USAGE_CONFIG_DIR: configDir,
    VIBE_USAGE_STATE_DIR: stateDir,
    TEST_API: backend.url,
    ...extraEnv,
  };
  try {
    return await fn({
      run: script => execFileAsync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env }),
      state: () => JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a slow Cursor export no longer holds back the other tools\' upload', async () => {
  await withBackend(async (backend) => {
    await inSandbox(backend, async ({ run, state }) => {
      const { stdout } = await run(runSyncScript(SLOW_CURSOR));
      assert.deepEqual(backend.ingests.map(i => i.sources), [['local-fast'], ['cursor']]);
      // Two passes, one sync: the same syncId, each pass its own final batch.
      assert.ok(backend.ingests[0].syncId);
      assert.equal(backend.ingests[1].syncId, backend.ingests[0].syncId);
      assert.deepEqual(backend.ingests.map(i => i.batch), [[0, 1], [0, 1]]);
      assert.match(stdout, /cursor: 仍在读取用量数据，先上传其他工具/);
      assert.equal(stdout.match(/已同步/g)?.length, 2);
      assert.equal(stdout.match(/前往 Dashboard 查看详情/g)?.length, 1);
      assert.equal(stdout.match(/项目名/g)?.length, 1);
      assert.deepEqual(Object.keys(state().buckets).map(k => k.split('|')[0]).sort(), ['cursor', 'local-fast']);
    });
  });
});

test('a Cursor result inside the grace period keeps one pass and one summary', async () => {
  await withBackend(async (backend) => {
    await inSandbox(backend, async ({ run }) => {
      const { stdout } = await run(runSyncScript(`
        parsers['cursor'] = async () => {
          await new Promise(r => setTimeout(r, 200));
          return { buckets: [${bucket('cursor')}], sessions: [] };
        };
      `));
      assert.doesNotMatch(stdout, /先上传其他工具/);
      assert.equal(stdout.match(/已同步/g)?.length, 1);
      assert.deepEqual(backend.ingests.map(i => i.sources), [['local-fast', 'cursor']]);
    });
  });
});

test('when only the slow source\'s pass fails, the other tools stay uploaded and the run exits 1', async () => {
  await withBackend(async (backend) => {
    await inSandbox(backend, async ({ run, state }) => {
      const error = await run(runSyncScript(SLOW_CURSOR)).then(() => null, err => err);
      assert.ok(error, 'the run must fail');
      assert.equal(error.code, 1);
      // The first pass reported and committed its upload ...
      assert.match(error.stdout, /已同步 1 buckets/);
      assert.deepEqual(Object.keys(state().buckets).map(k => k.split('|')[0]), ['local-fast']);
      // ... and the failure says some data did go up, instead of a bare 同步失败.
      assert.match(error.stderr, /部分完成（已上传 1 buckets）/);
      assert.doesNotMatch(error.stderr, /同步失败/);
      assert.deepEqual(backend.ingests.map(i => i.sources), [['local-fast']]);
    }, { VIBE_USAGE_DEFERRED_GRACE_MS: '0' });
  }, { failSource: 'cursor' });
});
