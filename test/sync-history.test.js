import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// The history module resolves its directory at import time, like state.js.
// Point it at a fresh, not-yet-existing directory so the 0700 creation is
// observable, and never at the developer's real ~/.vibe-usage.
const root = mkdtempSync(join(tmpdir(), 'vibe-usage-sync-history-'));
const stateDir = join(root, 'state');
process.env.VIBE_USAGE_STATE_DIR = stateDir;
process.env.VIBE_USAGE_DEV = '0';
const {
  SYNC_HISTORY_LIMIT,
  beginSyncRecord,
  getSyncHistoryPath,
  readSyncHistory,
  syncFailureFromError,
} = await import('../src/sync-history.js');
const { COLLECTOR_VERSION } = await import('../src/client-meta.js');

test.after(() => rmSync(root, { recursive: true, force: true }));

function rawEntries() {
  return JSON.parse(readFileSync(getSyncHistoryPath(), 'utf8')).entries;
}

function resetHistory() {
  rmSync(getSyncHistoryPath(), { force: true });
}

// Synthetic sensitive values: none of them may ever reach the history file.
const SECRETS = ['张 三', '秘密项目', '-Users-张-三-Coding', 'vbu_history_secret_key', 'sk-ant-api03-fake', 'eyJhbGciOiJIUzI1NiJ9.fake'];

test('a sync writes its entry on start and fills in the result on finish', () => {
  resetHistory();
  let clock = Date.parse('2026-11-09T06:00:00.000Z');
  const record = beginSyncRecord({ surface: 'daemon', now: () => clock });

  const [started] = rawEntries();
  assert.equal(started.startedAt, '2026-11-09T06:00:00.000Z');
  assert.equal(started.endedAt, null);
  assert.equal(started.result, null);
  assert.equal(started.surface, 'daemon');
  assert.equal(started.cliVersion, COLLECTOR_VERSION);
  assert.equal(started.runtime.name, process.versions.bun ? 'bun' : 'node');
  assert.equal(readSyncHistory().entries[0].result, null, 'an unfinished sync is reported without a result');

  record.uploaded.buckets += 12;
  record.uploaded.sessions += 3;
  clock += 18_000;
  record.finish();
  record.finish({ failure: { code: 'network_failed' } }); // only the first finish counts

  const [ended] = rawEntries();
  assert.equal(ended.result, 'success');
  assert.equal(ended.endedAt, '2026-11-09T06:00:18.000Z');
  assert.equal(ended.durationMs, 18_000);
  assert.deepEqual(ended.uploaded, { buckets: 12, sessions: 3 });
  assert.equal(ended.failure, null);

  if (process.platform !== 'win32') {
    assert.equal(statSync(getSyncHistoryPath()).mode & 0o777, 0o600);
    assert.equal(statSync(stateDir).mode & 0o777, 0o700);
  }
});

test('VIBE_USAGE_SURFACE from a desktop app wins over the default surface', () => {
  resetHistory();
  const previous = process.env.VIBE_USAGE_SURFACE;
  process.env.VIBE_USAGE_SURFACE = 'windows-app';
  try {
    beginSyncRecord({ surface: 'cli' }).finish();
  } finally {
    if (previous === undefined) delete process.env.VIBE_USAGE_SURFACE;
    else process.env.VIBE_USAGE_SURFACE = previous;
  }
  assert.equal(rawEntries()[0].surface, 'windows-app');
});

test('only the last 10 syncs are kept, newest first when read', () => {
  resetHistory();
  for (let index = 0; index < SYNC_HISTORY_LIMIT + 2; index++) {
    const at = Date.parse('2026-11-09T00:00:00.000Z') + index * 60_000;
    const record = beginSyncRecord({ now: () => at });
    record.uploaded.buckets += index;
    record.finish();
  }
  const entries = rawEntries();
  assert.equal(entries.length, SYNC_HISTORY_LIMIT);
  assert.equal(entries[0].uploaded.buckets, 2, 'the two oldest rolled off');
  const read = readSyncHistory();
  assert.equal(read.exists, true);
  assert.equal(read.entries.length, SYNC_HISTORY_LIMIT);
  assert.equal(read.entries[0].uploaded.buckets, SYNC_HISTORY_LIMIT + 1);
});

test('a failure records only its category, and partial when something was uploaded', () => {
  resetHistory();
  const failed = beginSyncRecord();
  failed.finish({ failure: { code: 'server_error', status: 502 } });
  const partial = beginSyncRecord();
  partial.uploaded.buckets += 100;
  partial.finish({ failure: { code: 'unauthorized' } });
  const unknown = beginSyncRecord();
  unknown.finish({ failure: { code: 'HTTP 502: <html>sk-ant-api03-fake</html>' } });

  const [a, b, c] = rawEntries();
  assert.equal(a.result, 'failed');
  assert.deepEqual(a.failure, { code: 'server_error', status: 502 });
  assert.equal(b.result, 'partial');
  assert.deepEqual(b.failure, { code: 'unauthorized' });
  assert.deepEqual(c.failure, { code: 'unexpected_error' });
});

test('per-tool counts keep codes only and leave out tools with nothing to say', () => {
  resetHistory();
  const record = beginSyncRecord();
  record.noteParser('claude-code', { buckets: 1204, sessions: 30, warnings: { read_failed: 2 } });
  record.noteParser('codex', { skipped: true, indexing: { completed: 120, total: 400 } });
  record.noteParser('cursor', { skipped: true, warnings: { cursor_token_encrypted: 1 } });
  record.noteParser('gemini-cli', { buckets: 0, sessions: 0, warnings: {} });
  record.noteParser('kimi-code', { error: 'not a code: /Users/张 三' });
  record.noteParser('qoder', { warnings: { 'free text 秘密项目': 1 } });
  record.noteWarning('kiki', 'upload_withheld');
  record.noteServerDropped('kilo', 30);
  record.flush();

  const { tools } = rawEntries()[0];
  assert.deepEqual(tools['claude-code'], { buckets: 1204, sessions: 30, warnings: { read_failed: 2 } });
  assert.deepEqual(tools.codex, { buckets: 0, sessions: 0, skipped: true, indexing: { completed: 120, total: 400 } });
  assert.deepEqual(tools.cursor.warnings, { cursor_token_encrypted: 1 });
  assert.equal(tools['gemini-cli'], undefined);
  assert.equal(tools['kimi-code'].error, 'parser_error');
  assert.deepEqual(tools.qoder.warnings, { other: 1 });
  assert.deepEqual(tools.kiki.warnings, { upload_withheld: 1 });
  assert.equal(tools.kilo.serverDropped, 30);
  const text = readFileSync(getSyncHistoryPath(), 'utf8');
  for (const secret of SECRETS) assert.ok(!text.includes(secret), secret);
});

test('reading re-validates every field, so a hand-edited file cannot inject text', () => {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(getSyncHistoryPath(), JSON.stringify({
    schemaVersion: 1,
    entries: [
      { startedAt: 'not a date', result: 'success' },
      {
        id: 'x',
        startedAt: '2026-11-09T06:00:00.000Z',
        endedAt: '2026-11-09T06:00:05.000Z',
        surface: 'evil /Users/张 三',
        cliVersion: '0.14.10 vbu_history_secret_key at /Users/张 三',
        runtime: { name: 'node', version: '22.23.1' },
        result: 'failed',
        durationMs: 5000,
        uploaded: { buckets: -1, sessions: 'many' },
        failure: { code: 'server_error', status: 502, body: 'sk-ant-api03-fake' },
        note: 'eyJhbGciOiJIUzI1NiJ9.fake',
        tools: {
          'claude-code': { buckets: 3, warnings: { read_failed: 1, '秘密项目': 4 }, path: '/Users/张 三' },
          '../../etc': { buckets: 1 },
        },
      },
    ],
  }));
  const { entries } = readSyncHistory();
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.surface, null);
  assert.equal(entry.cliVersion, null);
  assert.deepEqual(entry.uploaded, { buckets: 0, sessions: 0 });
  assert.deepEqual(entry.failure, { code: 'server_error', status: 502 });
  assert.deepEqual(entry.tools, { 'claude-code': { buckets: 3, sessions: 0, warnings: { read_failed: 1 } } });
  const text = JSON.stringify(entries);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), secret);
});

test('a missing or corrupt file reads as no history and is replaced on the next sync', () => {
  resetHistory();
  assert.deepEqual(readSyncHistory(), { exists: false, entries: [] });
  writeFileSync(getSyncHistoryPath(), '{ not json');
  assert.deepEqual(readSyncHistory(), { exists: false, entries: [] });
  beginSyncRecord().finish();
  assert.equal(rawEntries().length, 1);
});

test('failure categories never carry the error message', () => {
  const body = new Error('HTTP 422: {"error":"sk-ant-api03-fake"}');
  body.statusCode = 422;
  assert.deepEqual(syncFailureFromError(body), { code: 'server_error', status: 422 });
  assert.deepEqual(syncFailureFromError(new Error('UNAUTHORIZED')), { code: 'unauthorized' });
  const settings = new Error('SETTINGS_UNAVAILABLE');
  settings.code = 'SETTINGS_UNAVAILABLE';
  assert.deepEqual(syncFailureFromError(settings), { code: 'settings_unavailable' });
  assert.deepEqual(syncFailureFromError(new Error('Invalid JSON response: <html>')), { code: 'invalid_response' });
  assert.deepEqual(syncFailureFromError(new Error('Request timed out (60s)')), { code: 'network_failed' });
  const reset = new Error('socket hang up');
  reset.code = 'ECONNRESET';
  assert.deepEqual(syncFailureFromError(reset), { code: 'network_failed' });
  const disk = new Error('ENOSPC: no space left on device, write');
  disk.code = 'ENOSPC';
  assert.deepEqual(syncFailureFromError(disk), { code: 'unexpected_error' });
  assert.deepEqual(syncFailureFromError(undefined), { code: 'unexpected_error' });
});

test('an unwritable history location never throws into the sync', async () => {
  const blocked = join(root, 'blocked');
  writeFileSync(blocked, 'a regular file where the directory should be');
  const command = `
    const { beginSyncRecord, readSyncHistory } = await import('./src/sync-history.js');
    const record = beginSyncRecord();
    record.noteParser('codex', { buckets: 1 });
    record.flush();
    record.finish({ failure: { code: 'network_failed' } });
    console.log(JSON.stringify(readSyncHistory()));
  `;
  const { stdout, stderr } = await execFileAsync(process.execPath, ['--input-type=module', '-e', command], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: root, VIBE_USAGE_STATE_DIR: blocked, VIBE_USAGE_DEV: '0' },
  });
  assert.deepEqual(JSON.parse(stdout), { exists: false, entries: [] });
  assert.equal(stderr, '', 'recording failures stay silent');
});

// ---------------------------------------------------------------------------
// End to end: runSync in a child process against a local server.

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

function bucket(source, index) {
  return {
    source,
    model: `model-${index}`,
    project: '秘密项目',
    bucketStart: '2026-11-09T00:00:00.000Z',
    inputTokens: index + 1,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: index + 1,
  };
}

async function runSyncChild({ handler, parsers, env = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-usage-sync-history-e2e-'));
  const configDir = join(dir, 'config');
  const childState = join(dir, 'state');
  const homeDir = join(dir, 'home');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  try {
    return await withServer(handler, async (apiUrl) => {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        apiKey: 'vbu_history_secret_key',
        apiUrl,
        hostname: '张 三-MacBook-Pro',
      }));
      const command = `
        import { parsers } from './src/parsers/index.js';
        for (const source of Object.keys(parsers)) delete parsers[source];
        const bucket = ${bucket.toString()};
        ${parsers}
        const { runSync } = await import('./src/sync.js');
        try { await runSync({ throws: true, quiet: true }); } catch {}
      `;
      const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', command], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: homeDir,
          VIBE_USAGE_DEV: '0',
          VIBE_USAGE_CONFIG_DIR: configDir,
          VIBE_USAGE_STATE_DIR: childState,
          ...env,
        },
      });
      const file = join(childState, 'sync-history.json');
      const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
      return { ...result, text, entries: text ? JSON.parse(text).entries : [] };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function settingsOk(req, res) {
  if (req.method === 'GET' && req.url === '/api/usage/settings') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ uploadProject: true }));
    return true;
  }
  return false;
}

test('runSync records counts, warning codes and server drops, but no warning text', async () => {
  const { entries, text, stderr } = await runSyncChild({
    env: { VIBE_USAGE_SURFACE: 'mac-app' },
    handler(req, res) {
      if (settingsOk(req, res)) return;
      if (req.method === 'POST' && req.url === '/api/usage/ingest') {
        req.on('data', () => {});
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ingested: 3, sessions: 0, dropped: { buckets: 2, unknownSources: ['kilo'] } }));
        });
        return;
      }
      res.writeHead(404).end();
    },
    parsers: `
      parsers['claude-code'] = async () => ({
        buckets: [bucket('claude-code', 0), bucket('claude-code', 1), bucket('claude-code', 2)],
        sessions: [],
        warnings: [
          'Claude Code: cannot read /Users/张 三/.claude/projects/-Users-张-三-Coding-秘密项目/a.jsonl: EACCES vbu_history_secret_key',
          'Claude Code: cannot read directory /Users/张 三/.claude/projects/-Users-张-三-Coding-秘密项目: EACCES',
        ],
      });
      parsers.kilo = async () => ({ buckets: [bucket('kilo', 0), bucket('kilo', 1)], sessions: [] });
      parsers.cursor = async () => { throw new Error('sqlite3 CLI not found. Install sqlite3 (or use Node >= 22.5) to sync Cursor data.'); };
    `,
  });
  assert.match(stderr, /秘密项目/, 'the terminal still prints the original warning');
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.result, 'success');
  assert.equal(entry.surface, 'mac-app');
  assert.deepEqual(entry.uploaded, { buckets: 3, sessions: 0 });
  assert.deepEqual(entry.tools['claude-code'], {
    buckets: 3, sessions: 0, warnings: { read_failed: 1, dir_unreadable: 1 },
  });
  assert.deepEqual(entry.tools.kilo, { buckets: 2, sessions: 0, serverDropped: 2 });
  assert.deepEqual(entry.tools.cursor, { buckets: 0, sessions: 0, error: 'sqlite_unavailable' });
  for (const secret of [...SECRETS, 'MacBook']) assert.ok(!text.includes(secret), secret);
});

test('runSync records a server error as its status number only', async () => {
  const { entries, text } = await runSyncChild({
    handler(req, res) {
      if (settingsOk(req, res)) return;
      if (req.method === 'POST' && req.url === '/api/usage/ingest') {
        req.on('data', () => {});
        req.on('end', () => {
          res.writeHead(422, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'rejected sk-ant-api03-fake for 张 三' }));
        });
        return;
      }
      res.writeHead(404).end();
    },
    parsers: `parsers['claude-code'] = async () => ({ buckets: [bucket('claude-code', 0)], sessions: [] });`,
  });
  assert.equal(entries[0].result, 'failed');
  assert.deepEqual(entries[0].failure, { code: 'server_error', status: 422 });
  for (const secret of SECRETS) assert.ok(!text.includes(secret), secret);
});

test('runSync records partial when an earlier batch already reached the server', async () => {
  let posts = 0;
  const { entries } = await runSyncChild({
    handler(req, res) {
      if (settingsOk(req, res)) return;
      if (req.method === 'POST' && req.url === '/api/usage/ingest') {
        req.on('data', () => {});
        req.on('end', () => {
          posts++;
          if (posts === 1) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ingested: 100, sessions: 0 }));
          } else {
            res.writeHead(413).end('too large');
          }
        });
        return;
      }
      res.writeHead(404).end();
    },
    parsers: `parsers['claude-code'] = async () => ({ buckets: Array.from({ length: 150 }, (_, i) => bucket('claude-code', i)), sessions: [] });`,
  });
  assert.equal(entries[0].result, 'partial');
  assert.deepEqual(entries[0].uploaded, { buckets: 100, sessions: 0 });
  assert.deepEqual(entries[0].failure, { code: 'server_error', status: 413 });
});

test('runSync records a rejected key and an unavailable settings endpoint', async () => {
  const rejected = await runSyncChild({
    handler(req, res) { res.writeHead(401).end(); },
    parsers: `parsers['claude-code'] = async () => ({ buckets: [], sessions: [] });`,
  });
  assert.equal(rejected.entries[0].result, 'failed');
  assert.deepEqual(rejected.entries[0].failure, { code: 'unauthorized' });

  const unavailable = await runSyncChild({
    handler(req, res) { res.writeHead(404).end('no such route'); },
    parsers: `parsers['claude-code'] = async () => ({ buckets: [], sessions: [] });`,
  });
  assert.deepEqual(unavailable.entries[0].failure, { code: 'settings_unavailable' });
});

test('an unconfigured machine records nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-usage-sync-history-unconfigured-'));
  try {
    const command = `
      const { runSync } = await import('./src/sync.js');
      try { await runSync({ throws: true }); } catch {}
    `;
    await execFileAsync(process.execPath, ['--input-type=module', '-e', command], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: dir,
        VIBE_USAGE_DEV: '0',
        VIBE_USAGE_CONFIG_DIR: join(dir, 'config'),
        VIBE_USAGE_STATE_DIR: join(dir, 'state'),
      },
    });
    assert.equal(existsSync(join(dir, 'state', 'sync-history.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Killed mid-sync (a desktop app's 120s timeout) and an unwritable history.

function childSetup(apiUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-usage-sync-history-kill-'));
  const configDir = join(dir, 'config');
  const childState = join(dir, 'state');
  const homeDir = join(dir, 'home');
  for (const path of [configDir, childState, homeDir]) mkdirSync(path, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    apiKey: 'vbu_history_secret_key',
    apiUrl,
    hostname: 'history-kill-test',
  }));
  const env = {
    ...process.env,
    HOME: homeDir,
    VIBE_USAGE_DEV: '0',
    VIBE_USAGE_CONFIG_DIR: configDir,
    VIBE_USAGE_STATE_DIR: childState,
    VIBE_USAGE_DEFERRED_GRACE_MS: '0',
  };
  return { dir, childState, env };
}

function syncScript(parsers, runOptions) {
  return `
    import { parsers } from './src/parsers/index.js';
    for (const source of Object.keys(parsers)) delete parsers[source];
    const bucket = ${bucket.toString()};
    ${parsers}
    const { runSync } = await import('./src/sync.js');
    await runSync(${runOptions});
  `;
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for the condition');
}

function readEntries(childState) {
  try {
    return JSON.parse(readFileSync(join(childState, 'sync-history.json'), 'utf8')).entries;
  } catch {
    return [];
  }
}

async function killedAfterUpload({ parsers, handler }) {
  return withServer(handler, async (apiUrl) => {
    const { dir, childState, env } = childSetup(apiUrl);
    const child = spawn(process.execPath, ['--input-type=module', '-e', syncScript(parsers, '{ throws: true, quiet: true }')], {
      cwd: process.cwd(), env, stdio: 'ignore',
    });
    const exited = new Promise(resolve => child.once('exit', resolve));
    try {
      // The history file is the only signal: kill as soon as it shows the
      // accepted batch, like an app whose timeout fires mid-sync.
      await waitFor(() => readEntries(childState)[0]?.uploaded?.buckets > 0);
      child.kill('SIGKILL');
      await exited;
      return readEntries(childState);
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('a sync killed after its first batch keeps the uploaded count and no result', async () => {
  let posts = 0;
  const entries = await killedAfterUpload({
    handler(req, res) {
      if (settingsOk(req, res)) return;
      if (req.method === 'POST' && req.url === '/api/usage/ingest') {
        req.on('data', () => {});
        req.on('end', () => {
          posts++;
          if (posts > 1) return; // later batches hang until the process is killed
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ingested: 100, sessions: 0 }));
        });
        return;
      }
      res.writeHead(404).end();
    },
    parsers: `parsers['claude-code'] = async () => ({ buckets: Array.from({ length: 250 }, (_, i) => bucket('claude-code', i)), sessions: [] });`,
  });
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].uploaded, { buckets: 100, sessions: 0 });
  assert.equal(entries[0].result, null);
  assert.equal(entries[0].endedAt, null);
  assert.equal(entries[0].tools['claude-code'].buckets, 250);
});

test('a sync killed while waiting for Cursor keeps the first pass upload', async () => {
  const entries = await killedAfterUpload({
    handler(req, res) {
      if (settingsOk(req, res)) return;
      if (req.method === 'POST' && req.url === '/api/usage/ingest') {
        req.on('data', () => {});
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ingested: 2, sessions: 0 }));
        });
        return;
      }
      res.writeHead(404).end();
    },
    parsers: `
      parsers['claude-code'] = async () => ({ buckets: [bucket('claude-code', 0), bucket('claude-code', 1)], sessions: [] });
      // A whole-account export that never finishes; the timer stands in for
      // its open socket, which keeps a real process alive.
      parsers.cursor = () => new Promise(() => { setInterval(() => {}, 1000); });
    `,
  });
  assert.deepEqual(entries[0].uploaded, { buckets: 2, sessions: 0 });
  assert.equal(entries[0].result, null);
});

test('an unwritable history changes neither the upload, the output nor the exit code', async () => {
  for (const status of [200, 422]) {
    const received = [];
    await withServer((req, res) => {
      if (settingsOk(req, res)) return;
      if (req.method === 'POST' && req.url === '/api/usage/ingest') {
        req.on('data', () => {});
        req.on('end', () => {
          received.push(req.url);
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(status === 200 ? JSON.stringify({ ingested: 1, sessions: 0 }) : '{"error":"rejected"}');
        });
        return;
      }
      res.writeHead(404).end();
    }, async (apiUrl) => {
      const { dir, childState, env } = childSetup(apiUrl);
      // A directory where the history file belongs: every history write fails.
      mkdirSync(join(childState, 'sync-history.json'));
      try {
        const script = syncScript(`parsers['claude-code'] = async () => ({ buckets: [bucket('claude-code', 0)], sessions: [] });`, '{}');
        const result = await new Promise((resolve) => {
          execFile(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env }, (error, stdout, stderr) => {
            resolve({ code: error ? error.code : 0, stdout, stderr });
          });
        });
        assert.equal(received.length, 1, 'the batch was uploaded');
        if (status === 200) {
          assert.equal(result.code, 0);
          assert.match(result.stdout, /已同步 1 buckets/);
          assert.equal(result.stderr, '');
          assert.ok(existsSync(join(childState, 'state.json')), 'upload state still committed');
        } else {
          assert.equal(result.code, 1);
          assert.match(result.stderr, /同步失败: HTTP 422/);
          assert.doesNotMatch(result.stderr, /history|sync-history|EISDIR/);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
