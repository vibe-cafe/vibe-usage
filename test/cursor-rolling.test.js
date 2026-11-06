// Rolling 7-day Cursor sync end to end (issue #131): the real parser and
// runSync against a local cursor.com that filters its CSV export the way the
// real one was verified to (startDate/endDate in ms, both ends inclusive) and
// an ingest stand-in that upserts by key and refuses smaller totals. After
// every run the server must hold what one whole export would give.
// Synthetic data only; HOME, config and state in a temporary directory.
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
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FLOOR = Date.parse('2024-01-01T00:00:00Z');
const TOKEN = `header.${Buffer.from(JSON.stringify({ sub: 'auth0|rolling-user' })).toString('base64url')}.sig`;
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

const sumOf = b => b.inputTokens + b.outputTokens + b.cachedInputTokens + b.reasoningOutputTokens;

async function withBackend(run) {
  const backend = { rows: [], csvRequests: 0, table: new Map() };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await readBody(req);
    if (url.pathname === '/api/dashboard/export-usage-events-csv') {
      backend.csvRequests++;
      const start = Number(url.searchParams.get('startDate'));
      const end = Number(url.searchParams.get('endDate'));
      const visible = backend.rows.filter(r => r.at >= start && r.at <= end);
      res.writeHead(200, { 'content-type': 'text/csv' });
      res.end([CSV_HEADER, ...visible.map(r => `${new Date(r.at).toISOString()},${r.model},0,${r.input},0,0`)].join('\n'));
      return;
    }
    if (url.pathname === '/api/dashboard/get-filtered-usage-events') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (url.pathname === '/api/usage/settings') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ uploadProject: true }));
      return;
    }
    if (url.pathname === '/api/usage/ingest') {
      const payload = JSON.parse(body.toString('utf8'));
      for (const b of payload.buckets) {
        const key = `${b.model}|${b.bucketStart}`;
        const old = backend.table.get(key);
        if (!old || sumOf(b) >= sumOf(old)) backend.table.set(key, b);
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

/** What one whole export would upload: every row at or after the floor, by window. */
function truth(rows) {
  const out = new Map();
  for (const r of rows.filter(row => row.at >= FLOOR)) {
    const key = `${r.model}|${roundToHalfHour(new Date(r.at)).toISOString()}`;
    out.set(key, (out.get(key) || 0) + r.input);
  }
  return out;
}

test('rolling Cursor syncs keep the server equal to a whole export across first run, late rows and a gap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-cursor-rolling-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  mkdirSync(configDir, { recursive: true });
  const dbPath = join(root, 'state.vscdb');
  await writeTokenDb(dbPath);
  try {
    await withBackend(async (backend) => {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ apiKey: 'vbu_rolling', apiUrl: backend.url, hostname: 'rolling-host' }));
      const env = {
        ...process.env, HOME: root, VIBE_USAGE_DEV: '0', VIBE_USAGE_CONFIG_DIR: configDir, VIBE_USAGE_STATE_DIR: stateDir,
        CURSOR_STATE_DB_PATH: dbPath, CURSOR_WEB_BASE_URL: backend.url,
      };
      const command = `
        import { parsers } from './src/parsers/index.js';
        for (const source of Object.keys(parsers)) if (source !== 'cursor') delete parsers[source];
        const { runSync } = await import('./src/sync.js');
        await runSync({ throws: true, quiet: true });
      `;
      const sync = () => execFileAsync(process.execPath, ['--input-type=module', '-e', command], { cwd: process.cwd(), env });
      const statePath = join(stateDir, 'state.json');
      const state = () => JSON.parse(readFileSync(statePath, 'utf8'));
      const server = () => new Map([...backend.table].map(([k, b]) => [k, b.inputTokens]));
      const cursorKeys = () => Object.keys(state().buckets).filter(k => k.startsWith('cursor|')).length;
      const now = Date.now();

      // Run 1, first run: two months of usage, a 2025 stretch, one row near the floor.
      for (let at = now - 60 * DAY, i = 0; at < now - HOUR; at += 13 * HOUR, i++) {
        backend.rows.push({ at, input: 1 + (i % 7), model: i % 4 ? 'a' : 'b' });
      }
      for (let at = Date.parse('2025-03-01T00:00:00Z'), i = 0; at < Date.parse('2025-04-01T00:00:00Z'); at += 2 * DAY, i++) {
        backend.rows.push({ at, input: 10 + i, model: 'a' });
      }
      backend.rows.push({ at: Date.parse('2024-01-01T00:00:00.000Z'), input: 99, model: 'b' });
      await sync();
      assert.deepEqual(server(), truth(backend.rows));
      assert.equal(state().parserMeta.cursor.backfill, undefined);
      const keysAfterFirst = cursorKeys();

      // Run 2: new usage, and a row that reached the export three days late.
      backend.rows.push({ at: now - 30 * 60 * 1000, input: 5, model: 'a' });
      backend.rows.push({ at: now - 3 * DAY, input: 6, model: 'late' });
      const requestsBefore = backend.csvRequests;
      await sync();
      assert.equal(backend.csvRequests - requestsBefore, 1, 'an ordinary sync is one recent request');
      assert.deepEqual(server(), truth(backend.rows));
      assert.ok(cursorKeys() >= keysAfterFirst, 'no Cursor state key is pruned');

      // Run 3: the machine was off for 10 days; usage from then is older than
      // the recent window and is filled from the gap.
      const saved = state();
      saved.parserMeta.cursor.syncedAt = new Date(now - 10 * DAY).toISOString();
      writeFileSync(statePath, JSON.stringify(saved));
      backend.rows.push({ at: now - 9 * DAY, input: 7, model: 'gap' });
      await sync();
      assert.deepEqual(server(), truth(backend.rows));
      assert.equal(state().parserMeta.cursor.backfill, undefined);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
