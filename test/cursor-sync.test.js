// End-to-end Cursor sync over several runs (issue #131): the real Cursor parser
// and runSync against a local stand-in for cursor.com (CSV export honoring the
// dashboard's startDate/endDate range) and for the ingest endpoint (upsert by
// bucket key, refusing a smaller total like the production guard). All data is
// synthetic; HOME, config and state live in a temporary directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { roundToHalfHour } from '../src/parsers/aggregate.js';

const execFileAsync = promisify(execFile);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const TOKEN = `header.${Buffer.from(JSON.stringify({ sub: 'auth0|cursor-sync-user' })).toString('base64url')}.sig`;
const CSV_HEADER = 'Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens';

async function writeTokenDb(dbPath) {
  const sql = `CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', '${TOKEN}');`;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    // Node 20: same sqlite3 CLI fallback as the parser.
  }
  if (DatabaseSync) {
    const db = new DatabaseSync(dbPath);
    try { db.exec(sql); } finally { db.close(); }
  } else {
    execFileSync('sqlite3', [dbPath, sql]);
  }
}

function rowsBetween(from, to, salt = 0) {
  const rows = [];
  let i = salt;
  for (let at = from; at <= to; at += 11 * MINUTE, i++) {
    rows.push({ at, model: i % 4 === 0 ? 'model-b' : 'model-a', cw: i % 9, input: 50 + (i % 17), cr: (i * 3) % 40, out: 10 + (i % 6) });
  }
  return rows;
}

function csvOf(rows) {
  return [CSV_HEADER, ...rows.map(r => `${new Date(r.at).toISOString()},${r.model},${r.cw},${r.input},${r.cr},${r.out}`)].join('\n');
}

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

const bucketKey = b => `${b.source}|${b.model}|${b.project}|${b.hostname}|${b.bucketStart}`;
const bucketSum = b => b.inputTokens + b.outputTokens + b.cachedInputTokens + b.reasoningOutputTokens
  + (b.cacheCreation5mTokens || 0) + (b.cacheCreation1hTokens || 0);

/** One fake backend: cursor.com CSV + usage settings/ingest, each with its own table. */
async function withBackend(run) {
  const backend = { rows: [], csvRequests: [], ingests: [], table: new Map() };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/api/dashboard/export-usage-events-csv') {
      backend.csvRequests.push(url.search);
      const start = url.searchParams.has('startDate') ? Number(url.searchParams.get('startDate')) : -Infinity;
      const end = url.searchParams.has('endDate') ? Number(url.searchParams.get('endDate')) : Infinity;
      res.writeHead(200, { 'content-type': 'text/csv' });
      res.end(csvOf(backend.rows.filter(r => r.at >= start && r.at <= end)));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/test/received') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(backend.ingests.flat().map(key => key.split('|')[0])));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/usage/settings') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ uploadProject: true }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/usage/ingest') {
      const payload = JSON.parse((await readBody(req)).toString('utf8'));
      backend.ingests.push(payload.buckets.map(bucketKey));
      for (const b of payload.buckets) {
        const key = bucketKey(b);
        const existing = backend.table.get(key);
        // Production BUCKET_REGRESSION_GUARD_SQL: a smaller total never wins.
        if (!existing || bucketSum(b) >= bucketSum(existing)) backend.table.set(key, b);
      }
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

async function makeClient(root, name, backend) {
  const dir = join(root, name);
  const configDir = join(dir, 'config');
  const stateDir = join(dir, 'state');
  const homeDir = join(dir, 'home');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  const dbPath = join(dir, 'state.vscdb');
  await writeTokenDb(dbPath);
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    apiKey: `vbu_${name}`, apiUrl: backend.url, hostname: `${name}-host`,
  }));
  const env = {
    ...process.env,
    HOME: homeDir,
    VIBE_USAGE_DEV: '0',
    VIBE_USAGE_CONFIG_DIR: configDir,
    VIBE_USAGE_STATE_DIR: stateDir,
    CURSOR_STATE_DB_PATH: dbPath,
    CURSOR_WEB_BASE_URL: backend.url,
  };
  const command = `
    import { parsers } from './src/parsers/index.js';
    for (const source of Object.keys(parsers)) if (source !== 'cursor') delete parsers[source];
    const { runSync } = await import('./src/sync.js');
    await runSync({ throws: true, quiet: true });
  `;
  return {
    statePath: join(stateDir, 'state.json'),
    sync: () => execFileAsync(process.execPath, ['--input-type=module', '-e', command], { cwd: process.cwd(), env }),
    state() { return JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')); },
  };
}

test('Cursor incremental syncs keep state, upload only changes, and end at the whole export\'s numbers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-cursor-sync-'));
  try {
    await withBackend(async (backend) => {
      const now = Date.now();
      backend.rows = rowsBetween(now - 4 * 24 * HOUR, now - 3 * HOUR);
      const client = await makeClient(root, 'incremental', backend);

      // Run 1: no parserMeta yet → whole-account export, full upload.
      await client.sync();
      assert.equal(backend.csvRequests.length, 1);
      assert.doesNotMatch(backend.csvRequests[0], /startDate/);
      const historyKeys = Object.keys(client.state().buckets).filter(k => k.startsWith('cursor|'));
      assert.ok(historyKeys.length > 100);
      assert.equal(new Set(backend.ingests.flat()).size, historyKeys.length);

      // Run 2: nothing new → a tail request, no upload, and no state pruned.
      const ingestsBefore = backend.ingests.length;
      await client.sync();
      assert.equal(backend.csvRequests.length, 2);
      assert.match(backend.csvRequests[1], /startDate=\d+&endDate=\d+/);
      assert.equal(backend.ingests.length, ingestsBefore);
      assert.deepEqual(Object.keys(client.state().buckets).filter(k => k.startsWith('cursor|')).sort(), historyKeys.slice().sort());

      // Run 3: new usage, plus a row that reached the export late with a
      // timestamp before the previous newest event → its window is re-sent
      // whole; nothing else old is touched and no old key is pruned.
      const latest = Math.max(...backend.rows.map(r => r.at));
      const late = { at: latest - 5 * MINUTE, model: 'model-late', cw: 1, input: 7, cr: 0, out: 3 };
      backend.rows.push(late);
      backend.rows.push(...rowsBetween(now - 2 * HOUR, now - MINUTE, 7));
      await client.sync();
      assert.match(backend.csvRequests[2], /startDate=/);
      const sentInRun3 = backend.ingests.slice(ingestsBefore).flat();
      const lateKey = `cursor|model-late|unknown|cursor-cloud|${roundToHalfHour(new Date(late.at)).toISOString()}`;
      assert.ok(sentInRun3.includes(lateKey));
      assert.ok(sentInRun3.every(key => !historyKeys.includes(key)));
      const stateAfter3 = Object.keys(client.state().buckets).filter(k => k.startsWith('cursor|'));
      for (const key of historyKeys) assert.ok(stateAfter3.includes(key), `pruned ${key}`);

      // Run 4: a whole export again (state from before 0.14.5 has no
      // parserMeta) re-sends nothing: the incremental runs lost no keys.
      const state = client.state();
      delete state.parserMeta;
      writeFileSync(client.statePath, JSON.stringify(state));
      const ingestsBeforeFull = backend.ingests.length;
      await client.sync();
      assert.doesNotMatch(backend.csvRequests.at(-1), /startDate/);
      assert.equal(backend.ingests.length, ingestsBeforeFull);

      // The server ends exactly where a single whole-export sync of the same
      // final data lands.
      const incrementalTable = new Map(backend.table);
      backend.table = new Map();
      const fresh = await makeClient(root, 'whole-export', backend);
      await fresh.sync();
      assert.deepEqual(
        [...backend.table.entries()].map(([k, b]) => [k.replace('whole-export-host', ''), bucketSum(b), b.inputTokens, b.outputTokens, b.cachedInputTokens]).sort(),
        [...incrementalTable.entries()].map(([k, b]) => [k.replace('whole-export-host', ''), bucketSum(b), b.inputTokens, b.outputTokens, b.cachedInputTokens]).sort(),
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a slow Cursor export no longer holds back the other tools\' upload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-deferred-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const homeDir = join(root, 'home');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  const received = [];
  try {
    await withBackend(async (backend) => {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        apiKey: 'vbu_deferred', apiUrl: backend.url, hostname: 'deferred-host',
      }));
      const bucket = (source, model) => `({
        source: '${source}', model: '${model}', project: 'p', bucketStart: '2026-11-01T00:00:00.000Z',
        inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 2,
      })`;
      const command = `
        import { parsers } from './src/parsers/index.js';
        for (const source of Object.keys(parsers)) delete parsers[source];
        parsers['local-fast'] = async () => ({ buckets: [${bucket('local-fast', 'm')}], sessions: [] });
        parsers['cursor'] = async () => {
          // Finish only after the local tool's upload reached the server --
          // impossible if runSync still waited for every parser first.
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            const res = await fetch(process.env.TEST_API + '/test/received');
            if ((await res.json()).includes('local-fast')) {
              return { buckets: [${bucket('cursor', 'after-local')}], sessions: [] };
            }
            await new Promise(r => setTimeout(r, 50));
          }
          return { buckets: [${bucket('cursor', 'waited-for-everything')}], sessions: [] };
        };
        const { runSync } = await import('./src/sync.js');
        await runSync({ throws: true });
      `;
      const env = {
        ...process.env,
        HOME: homeDir,
        VIBE_USAGE_DEV: '0',
        VIBE_USAGE_CONFIG_DIR: configDir,
        VIBE_USAGE_STATE_DIR: stateDir,
        VIBE_USAGE_DEFERRED_GRACE_MS: '0',
        TEST_API: backend.url,
      };
      const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', command], { cwd: process.cwd(), env });
      for (const keys of backend.ingests) received.push(...keys.map(k => k.split('|').slice(0, 2).join('|')));
      assert.deepEqual(received, ['local-fast|m', 'cursor|after-local']);
      assert.match(stdout, /cursor: 仍在读取用量数据，先上传其他工具/);
      assert.equal(stdout.match(/前往 Dashboard 查看详情/g)?.length, 1);
      assert.equal(stdout.match(/项目名/g)?.length, 1);
      const state = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
      assert.deepEqual(Object.keys(state.buckets).map(k => k.split('|')[0]).sort(), ['cursor', 'local-fast']);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a Cursor result inside the grace period keeps one pass and one summary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-grace-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  mkdirSync(configDir, { recursive: true });
  try {
    await withBackend(async (backend) => {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        apiKey: 'vbu_grace', apiUrl: backend.url, hostname: 'grace-host',
      }));
      const bucket = source => `({
        source: '${source}', model: 'm', project: 'p', bucketStart: '2026-11-01T00:00:00.000Z',
        inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 2,
      })`;
      const command = `
        import { parsers } from './src/parsers/index.js';
        for (const source of Object.keys(parsers)) delete parsers[source];
        parsers['local-fast'] = async () => ({ buckets: [${bucket('local-fast')}], sessions: [] });
        parsers['cursor'] = async () => {
          await new Promise(r => setTimeout(r, 200));
          return { buckets: [${bucket('cursor')}], sessions: [] };
        };
        const { runSync } = await import('./src/sync.js');
        await runSync({ throws: true });
      `;
      const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', command], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: root, VIBE_USAGE_DEV: '0', VIBE_USAGE_CONFIG_DIR: configDir, VIBE_USAGE_STATE_DIR: stateDir },
      });
      assert.doesNotMatch(stdout, /先上传其他工具/);
      assert.equal(stdout.match(/已同步/g)?.length, 1);
      assert.equal(backend.ingests.length, 1);
      assert.equal(backend.ingests[0].length, 2);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
