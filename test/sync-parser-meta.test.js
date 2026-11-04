// Parser info (state.parserMeta) is committed with the upload, not before it.
// Cursor's events fallback only asks for events newer than the recorded
// `latestTokenAt`; when sync.js recorded the new value before uploading, a
// failed or killed upload made the retry skip the events that never reached
// the server. Real Cursor parser against local stand-ins for cursor.com and the
// ingest endpoint; synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

const execFileAsync = promisify(execFile);
const HOUR = 60 * 60 * 1000;
const TOKEN = `header.${Buffer.from(JSON.stringify({ sub: 'auth0|parser-meta-user' })).toString('base64url')}.sig`;
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

const bucketKey = b => `${b.source}|${b.model}|${b.project}|${b.hostname}|${b.bucketStart}`;

/**
 * cursor.com (empty CSV export, events API honoring startDate/endDate) plus
 * the settings/ingest endpoints. `interrupt()` may return 'fail' (HTTP 400,
 * nothing stored) or 'hang' (never answer; `onHang` lets the test kill the client).
 */
async function withBackend(run) {
  const backend = { events: [], table: new Map(), interrupt: null, onHang: null };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await readBody(req);
    if (url.pathname === '/api/dashboard/export-usage-events-csv') {
      res.writeHead(200, { 'content-type': 'text/csv' });
      res.end(CSV_HEADER);
      return;
    }
    if (url.pathname === '/api/dashboard/get-filtered-usage-events') {
      const { page, pageSize, startDate, endDate } = JSON.parse(body.toString('utf8'));
      const inRange = backend.events.filter(e => e.at >= Number(startDate) && e.at <= Number(endDate));
      const slice = inRange.slice((page - 1) * pageSize, page * pageSize);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        totalUsageEventsCount: inRange.length,
        usageEventsDisplay: slice.map(e => ({
          usageEventId: e.id, timestamp: String(e.at), model: 'm',
          tokenUsage: { inputTokens: e.input, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1 },
        })),
      }));
      return;
    }
    if (url.pathname === '/api/usage/settings') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ uploadProject: true }));
      return;
    }
    if (url.pathname === '/api/usage/ingest') {
      const payload = JSON.parse(body.toString('utf8'));
      const interruption = backend.interrupt?.(payload);
      if (interruption === 'fail') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'forced failure' }));
        return;
      }
      if (interruption === 'hang') {
        backend.onHang?.();
        return;
      }
      for (const b of payload.buckets) backend.table.set(bucketKey(b), b);
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
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

for (const [label, mode] of [['fails', 'fail'], ['is killed after the state was saved', 'hang']]) {
  test(`a retry re-sends Cursor fallback events after the upload ${label}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'vibe-usage-parser-meta-'));
    const configDir = join(root, 'config');
    const stateDir = join(root, 'state');
    mkdirSync(configDir, { recursive: true });
    const dbPath = join(root, 'state.vscdb');
    await writeTokenDb(dbPath);
    try {
      await withBackend(async (backend) => {
        writeFileSync(join(configDir, 'config.json'), JSON.stringify({
          apiKey: 'vbu_parser_meta', apiUrl: backend.url, hostname: 'parser-meta-host',
        }));
        const env = {
          ...process.env,
          HOME: root,
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
        const start = () => {
          const child = execFile(process.execPath, ['--input-type=module', '-e', command], { cwd: process.cwd(), env });
          return { child, done: new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))) };
        };
        const state = () => JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
        const now = Date.now();

        // Run 1: CSV empty → events fallback, one event three hours ago.
        backend.events = [{ id: 'e1', at: now - 3 * HOUR, input: 10 }];
        assert.equal((await start().done).code, 0);
        const anchor = state().parserMeta.cursor.latestTokenAt;
        assert.equal(anchor, new Date(now - 3 * HOUR).toISOString());

        // Run 2: a newer event; its upload never succeeds.
        backend.events.push({ id: 'e2', at: now - HOUR, input: 20 });
        backend.interrupt = () => mode;
        const run = start();
        if (mode === 'hang') backend.onHang = () => run.child.kill('SIGKILL');
        const outcome = await run.done;
        assert.ok(outcome.code !== 0 || outcome.signal);
        // The anchor did not move past the event the server never got.
        assert.equal(state().parserMeta.cursor.latestTokenAt, anchor);

        // Run 3: recovered → the newer event's window reaches the server.
        backend.interrupt = null;
        backend.onHang = null;
        assert.equal((await start().done).code, 0);
        const inputs = [...backend.table.values()].map(b => b.inputTokens).sort((a, b) => a - b);
        assert.deepEqual(inputs, [10, 20]);
        assert.equal(state().parserMeta.cursor.latestTokenAt, new Date(now - HOUR).toISOString());
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
