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
import { bucketHash, bucketKey, stateIdentity } from '../src/state.js';

const execFileAsync = promisify(execFile);
const HOST = 'deferred-host';
const API_KEY = 'vbu_deferred';
const START = '2026-11-01T00:00:00.000Z';

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

/**
 * Settings + ingest stand-in. `fail({ sources, index })` returning true makes
 * that ingest request fail with HTTP 400 (nothing stored); `index` counts
 * every ingest request from 1.
 */
async function withBackend(run, { fail } = {}) {
  const backend = { ingests: [], requests: 0 };
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
      const sources = [...payload.buckets, ...(payload.sessions || [])].map(item => item.source);
      backend.requests++;
      if (fail?.({ sources, index: backend.requests })) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'forced failure' }));
        return;
      }
      backend.ingests.push({
        sources,
        models: payload.buckets.map(b => b.model),
        syncId: payload.client?.syncId,
        batch: [payload.client?.batchIndex, payload.client?.batchCount],
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ingested: payload.buckets.length, sessions: payload.sessions?.length || 0 }));
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

const bucket = (source, model = 'm') => `({
  source: '${source}', model: '${model}', project: 'p', bucketStart: '${START}',
  inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 2,
})`;
const LOCAL_FAST = `parsers['local-fast'] = async () => ({ buckets: [${bucket('local-fast')}], sessions: [] });`;
const cursorAfter = ms => `
  parsers['cursor'] = async () => {
    await new Promise(r => setTimeout(r, ${ms}));
    return { buckets: [${bucket('cursor')}], sessions: [] };
  };
`;

// `cursor` finishes only after the local tool's upload reached the server --
// impossible if runSync still waited for every parser before uploading.
// `observe` runs at that moment and its string becomes the bucket's model.
const slowCursor = (observe = `'m'`) => `
  parsers['cursor'] = async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const res = await fetch(process.env.TEST_API + '/test/received');
      if ((await res.json()).length > 0) {
        const model = ${observe};
        return { buckets: [{ source: 'cursor', model, project: 'p', bucketStart: '${START}',
          inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 2 }], sessions: [] };
      }
      await new Promise(r => setTimeout(r, 50));
    }
    return { buckets: [${bucket('cursor', 'waited-for-everything')}], sessions: [] };
  };
`;

function script(parsersCode, runOptions = '{}') {
  return `
    import { parsers } from './src/parsers/index.js';
    for (const source of Object.keys(parsers)) delete parsers[source];
    ${parsersCode}
    const { runSync } = await import('./src/sync.js');
    await runSync(${runOptions});
  `;
}

async function inSandbox(backend, fn, { env: extraEnv = {}, state: initialState } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-deferred-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ apiKey: API_KEY, apiUrl: backend.url, hostname: HOST }));
  if (initialState) writeFileSync(join(stateDir, 'state.json'), JSON.stringify(initialState));
  const env = {
    ...process.env,
    HOME: root,
    VIBE_USAGE_DEV: '0',
    VIBE_USAGE_CONFIG_DIR: configDir,
    VIBE_USAGE_STATE_DIR: stateDir,
    VIBE_USAGE_DEFERRED_GRACE_MS: '0',
    TEST_API: backend.url,
    ...extraEnv,
  };
  try {
    return await fn({
      run: code => execFileAsync(process.execPath, ['--input-type=module', '-e', code], { cwd: process.cwd(), env }),
      fails: code => execFileAsync(process.execPath, ['--input-type=module', '-e', code], { cwd: process.cwd(), env })
        .then(() => assert.fail('the run must fail'), err => err),
      state: () => JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')),
      statePath: join(stateDir, 'state.json'),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const keySources = state => Object.keys(state.buckets).map(k => k.split('|')[0]).sort();

test('a slow Cursor export no longer holds back the other tools\' upload', async () => {
  await withBackend(async (backend) => {
    // Default 5s grace, so the ordinary path is exercised too.
    await inSandbox(backend, async ({ run, state }) => {
      const { stdout } = await run(script(LOCAL_FAST + slowCursor()));
      assert.deepEqual(backend.ingests.map(i => i.sources), [['local-fast'], ['cursor']]);
      // Two passes, one sync: the same syncId, each pass its own final batch.
      assert.ok(backend.ingests[0].syncId);
      assert.equal(backend.ingests[1].syncId, backend.ingests[0].syncId);
      assert.deepEqual(backend.ingests.map(i => i.batch), [[0, 1], [0, 1]]);
      assert.match(stdout, /cursor: 仍在读取用量数据，先上传其他工具/);
      assert.equal(stdout.match(/已同步/g)?.length, 2);
      assert.equal(stdout.match(/前往 Dashboard 查看详情/g)?.length, 1);
      assert.equal(stdout.match(/项目名/g)?.length, 1);
      assert.deepEqual(keySources(state()), ['cursor', 'local-fast']);
    }, { env: { VIBE_USAGE_DEFERRED_GRACE_MS: '' } });
  });
});

test('a Cursor result inside the grace period keeps one pass and one summary', async () => {
  await withBackend(async (backend) => {
    await inSandbox(backend, async ({ run }) => {
      const { stdout } = await run(script(LOCAL_FAST + cursorAfter(200)));
      assert.doesNotMatch(stdout, /先上传其他工具/);
      assert.equal(stdout.match(/已同步/g)?.length, 1);
      assert.deepEqual(backend.ingests.map(i => i.sources), [['local-fast', 'cursor']]);
    }, { env: { VIBE_USAGE_DEFERRED_GRACE_MS: '' } });
  });
});

test('a quiet two-pass sync prints only the result lines', async () => {
  await withBackend(async (backend) => {
    await inSandbox(backend, async ({ run }) => {
      const { stdout } = await run(script(LOCAL_FAST + slowCursor(), '{ quiet: true }'));
      assert.deepEqual(backend.ingests.map(i => i.sources), [['local-fast'], ['cursor']]);
      assert.doesNotMatch(stdout, /先上传其他工具|前往 Dashboard|项目名|待上传/);
      assert.equal(stdout.match(/已同步/g)?.length, 2);
    });
  });
});

test('each pass prunes only its own sources; Cursor keys survive the first pass', async () => {
  const dead = source => `${source}|gone|p|${HOST}|2026-10-01T00:00:00.000Z`;
  await withBackend(async (backend) => {
    await inSandbox(backend, async ({ run, state }) => {
      // While the first pass has already pruned and saved, look at the file:
      // Cursor's dead key must still be there (its parser had not finished).
      const observe = `JSON.parse((await import('node:fs')).readFileSync(process.env.VIBE_USAGE_STATE_DIR + '/state.json', 'utf8')).buckets['${dead('cursor')}'] ? 'cursor-keys-kept' : 'cursor-keys-pruned-early'`;
      await run(script(LOCAL_FAST + slowCursor(observe)));
      assert.deepEqual(backend.ingests.map(i => i.models), [['m'], ['cursor-keys-kept']]);
      const keys = Object.keys(state().buckets);
      assert.ok(!keys.includes(dead('local-fast')));
      assert.ok(!keys.includes(dead('cursor')));
      // A source no parser ran for this sync is never pruned.
      assert.ok(keys.includes(dead('other-tool')));
    }, { state: { buckets: { [dead('local-fast')]: 'x', [dead('cursor')]: 'y', [dead('other-tool')]: 'z' }, sessions: {} } });
  });
});

test('a failing first pass stops the sync before the slow source uploads', async () => {
  await withBackend(async (backend) => {
    await inSandbox(backend, async ({ fails, statePath }) => {
      const error = await fails(script(LOCAL_FAST + slowCursor()));
      assert.equal(error.code, 1);
      assert.match(error.stderr, /同步失败/);
      assert.doesNotMatch(error.stderr, /部分完成/);
      assert.deepEqual(backend.ingests, []);
      let saved = { buckets: {} };
      try { saved = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* nothing saved */ }
      assert.deepEqual(Object.keys(saved.buckets), []);
    });
  }, { fail: ({ sources }) => sources.includes('local-fast') });
});

test('when only the slow source\'s pass fails, the other tools stay uploaded and the run exits 1', async () => {
  await withBackend(async (backend) => {
    await inSandbox(backend, async ({ fails, state }) => {
      const error = await fails(script(LOCAL_FAST + slowCursor()));
      assert.equal(error.code, 1);
      // The first pass reported and committed its upload ...
      assert.match(error.stdout, /已同步 1 buckets/);
      assert.deepEqual(keySources(state()), ['local-fast']);
      // ... and the failure says some data did go up, instead of a bare 同步失败.
      assert.match(error.stderr, /部分完成（已上传 1 buckets）/);
      assert.doesNotMatch(error.stderr, /同步失败/);
      assert.deepEqual(backend.ingests.map(i => i.sources), [['local-fast']]);
    });
  }, { fail: ({ sources }) => sources.includes('cursor') });
});

test('a first pass that uploaded only sessions still counts as partial success', async () => {
  const session = `{ source: 'sessions-only', project: 'p', sessionHash: 'h1', firstMessageAt: '${START}',
    lastMessageAt: '${START}', durationSeconds: 60, activeSeconds: 30, messageCount: 2, userMessageCount: 1, userPromptHours: [] }`;
  await withBackend(async (backend) => {
    await inSandbox(backend, async ({ fails }) => {
      const error = await fails(script(`
        parsers['sessions-only'] = async () => ({ buckets: [], sessions: [${session}] });
        ${slowCursor()}
      `));
      assert.equal(error.code, 1);
      assert.match(error.stderr, /部分完成（已上传 0 buckets · 1 sessions）/);
      assert.doesNotMatch(error.stderr, /同步失败/);
    });
  }, { fail: ({ sources }) => sources.includes('cursor') });
});

test('an interrupted multi-batch slow pass resumes from its uncommitted batches', async () => {
  // 150 Cursor buckets = two batches; the second one fails on the first run.
  const cursor150 = `
    parsers['cursor'] = async () => {
      await new Promise(r => setTimeout(r, 300));
      return {
        buckets: Array.from({ length: 150 }, (_, i) => ({ source: 'cursor', model: 'm' + i, project: 'p',
          bucketStart: '${START}', inputTokens: 1, outputTokens: 1, cachedInputTokens: 0,
          reasoningOutputTokens: 0, totalTokens: 2 })),
        sessions: [],
        info: { account: 'auth0|test', latestTokenAt: '${START}' },
      };
    };
  `;
  let failing = true;
  await withBackend(async (backend) => {
    await inSandbox(backend, async ({ run, fails, state }) => {
      const error = await fails(script(LOCAL_FAST + cursor150));
      assert.match(error.stderr, /部分完成（已上传 101 buckets）/);
      const afterFailure = state();
      assert.equal(Object.keys(afterFailure.buckets).filter(k => k.startsWith('cursor|')).length, 100);
      // Cursor's parser info waits for all of Cursor's items.
      assert.equal(afterFailure.parserMeta?.cursor, undefined);

      failing = false;
      const before = backend.ingests.length;
      await run(script(LOCAL_FAST + cursor150));
      const resent = backend.ingests.slice(before);
      assert.deepEqual(resent.map(i => i.sources.length), [50]);
      assert.ok(resent[0].sources.every(source => source === 'cursor'));
      const final = state();
      assert.equal(Object.keys(final.buckets).filter(k => k.startsWith('cursor|')).length, 150);
      assert.deepEqual(final.parserMeta.cursor, { account: 'auth0|test', latestTokenAt: START });
    });
  }, { fail: ({ index }) => failing && index === 3 });
});

test('a re-bound account re-uploads everything across both passes, announced once', async () => {
  const sameHash = bucketHash({ inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 2 });
  const keyOf = source => bucketKey({ source, model: 'm', project: 'p', hostname: HOST, bucketStart: START });
  await withBackend(async (backend) => {
    await inSandbox(backend, async ({ run, state }) => {
      const { stdout } = await run(script(LOCAL_FAST + slowCursor()));
      // Same hashes, but recorded for another account: both passes resend.
      assert.deepEqual(backend.ingests.map(i => i.sources), [['local-fast'], ['cursor']]);
      assert.equal(stdout.match(/检测到上传账号已更换/g)?.length, 1);
      assert.deepEqual(state().identity, stateIdentity({ apiUrl: backend.url, apiKey: API_KEY }));
    }, {
      state: {
        buckets: { [keyOf('local-fast')]: sameHash, [keyOf('cursor')]: sameHash },
        sessions: {},
        identity: { apiUrl: 'https://old.example', keyFingerprint: 'deadbeefdeadbeef' },
      },
    });
  });
});

test('the Kiki migration guard runs once, in the pass that holds Kiki', async () => {
  const legacy = bucketKey({ source: 'kimi-code', model: 'm', project: 'p', hostname: HOST, bucketStart: START });
  await withBackend(async (backend) => {
    await inSandbox(backend, async ({ run, state }) => {
      const { stderr } = await run(script(`
        parsers['kiki'] = async () => ({ buckets: [${bucket('kiki')}], sessions: [] });
        parsers['kimi-code'] = async () => ({ buckets: [], sessions: [] });
        ${LOCAL_FAST}
        ${slowCursor()}
      `));
      // The legacy kimi-code row overlaps Kiki: Kiki is held back, reported once.
      assert.equal(stderr.match(/kiki: 历史与 kimi-code 同步记录重叠/g)?.length, 1);
      assert.deepEqual(backend.ingests.map(i => i.sources), [['local-fast'], ['cursor']]);
      assert.equal(state().buckets[legacy], 'recorded-by-a-compat-collector');
    }, { state: { buckets: { [legacy]: 'recorded-by-a-compat-collector' }, sessions: {} } });
  });
});
