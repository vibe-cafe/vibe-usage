import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { withUnreadableFile } from '../test-support/file-permissions.js';
import { findKiloDbs, resolveKiloDataRoot, resolveKiloDbPath, resolveKiloStoreCandidates } from '../src/kilo-roots.js';
import { parse, resolveKiloModel } from '../src/parsers/kilo.js';
import { parsers } from '../src/parsers/index.js';
import { TOOLS } from '../src/tools.js';

const require = createRequire(import.meta.url);
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* Node 20 uses sqlite3. */ }
const execAsync = promisify(execFile);
const T = Date.parse('2026-10-20T01:00:00Z');
const tokens = { input: 11, output: 7, reasoning: 3, cache: { read: 13, write: 5 } };
const CANARY = 'PRIVATE_KILO_PROMPT_TOOL_CREDENTIAL_CANARY';
const schema = `CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER);
CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);`;
const literal = value => value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
function sql(path, query) {
  if (!DatabaseSync) return execFileSync('sqlite3', [path, query], { encoding: 'utf8' });
  const db = new DatabaseSync(path);
  try { db.exec(query); } finally { db.close(); }
}
function session(id, { parent = null, created = T - 1000, directory = '/work/project' } = {}) {
  return `INSERT INTO session VALUES(${literal(id)},${literal(parent)},${literal(directory)},${created},${created});`;
}
function message(id, s, time, role, extra = {}) {
  const data = { role, time: { created: time }, modelID: 'kilo-auto/balanced', path: { root: '/', cwd: '/work/project' }, content: CANARY, ...extra };
  return `INSERT INTO message VALUES(${literal(id)},${literal(s)},${time},${time},${literal(JSON.stringify(data))});`;
}
function step(id, m, s, time, extra = {}) {
  const data = { type: 'step-finish', tokens, time: { start: time, end: time + 200 }, model: { modelID: 'openai/gpt-6-luna' }, text: CANARY, ...extra };
  return `INSERT INTO part VALUES(${literal(id)},${literal(m)},${literal(s)},${time},${time},${literal(JSON.stringify(data))});`;
}
function fixture(t, name, rows = '') {
  const root = mkdtempSync(join(tmpdir(), `vibe-kilo-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'kilo.db');
  sql(path, schema + rows);
  return { root, path };
}
async function withRoots(roots, run = parse) {
  const previous = process.env.VIBE_USAGE_KILO_DIRS;
  process.env.VIBE_USAGE_KILO_DIRS = roots.join(delimiter);
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.VIBE_USAGE_KILO_DIRS;
    else process.env.VIBE_USAGE_KILO_DIRS = previous;
  }
}
const total = r => r.buckets.reduce((sum, b) => sum + b.totalTokens, 0);
const humans = r => r.sessions.reduce((sum, s) => sum + s.userMessageCount, 0);

test('Kilo roots follow XDG/KILO_DB and isolate POSIX and Windows fixture overrides', () => {
  assert.equal(resolveKiloDataRoot({}, '/home/test', 'linux'), '/home/test/.local/share/kilo');
  assert.equal(resolveKiloDataRoot({ XDG_DATA_HOME: '/data\n' }, '/home/test', 'linux'), '/data/kilo');
  assert.equal(resolveKiloDataRoot({ XDG_DATA_HOME: 'relative' }, '/home/test', 'linux'), '/home/test/.local/share/kilo');
  assert.equal(resolveKiloDbPath({ XDG_DATA_HOME: '/data', KILO_DB: 'dev.db' }, '/home/test', 'linux'), '/data/kilo/dev.db');
  assert.equal(resolveKiloDbPath({ KILO_DB: '/custom/live.db' }, '/home/test', 'linux'), '/custom/live.db');
  assert.equal(resolveKiloDbPath({ KILO_DB: ':memory:' }), null);
  assert.equal(resolveKiloDataRoot({}, 'C:\\Users\\test', 'win32'), 'C:\\Users\\test\\.local\\share\\kilo');
  assert.equal(resolveKiloDbPath({ XDG_DATA_HOME: 'D:\\data', KILO_DB: 'dev.db' }, 'C:\\Users\\test', 'win32'), 'D:\\data\\kilo\\dev.db');
  assert.equal(resolveKiloDbPath({ KILO_DB: '\\\\server\\share\\custom.db' }, 'C:\\Users\\test', 'win32'), '\\\\server\\share\\custom.db');
  assert.deepEqual(resolveKiloStoreCandidates({ VIBE_USAGE_KILO_DIRS: 'C:\\one;D:\\two', KILO_DB: ':memory:' }, 'C:\\Users\\test', 'win32').candidates, ['C:\\one', 'D:\\two']);
  assert.deepEqual(resolveKiloStoreCandidates({ VIBE_USAGE_KILO_DIRS: '/one:/two', KILO_DB: '/ignored.db' }, '/home/test', 'linux').candidates, ['/one', '/two']);
});

test('Kilo registers once for CLI and Desktop and detects the shared database', async t => {
  const { root, path } = fixture(t, 'registration');
  assert.equal(parsers.kilo, parse);
  assert.equal(TOOLS.filter(tool => tool.id === 'kilo').length, 1);
  await withRoots([root, path], () => {
    assert.deepEqual(findKiloDbs(), [realpathSync(path)]);
    assert.deepEqual(TOOLS.find(tool => tool.id === 'kilo').detectDataDirs(), [realpathSync(path)]);
  });
  assert.deepEqual(await withRoots([root]), { buckets: [], sessions: [] });
});

test('Kilo preserves concrete slash model ids and namespaces only bare routing labels', () => {
  for (const id of ['anthropic/claude-opus-5.5', 'reflection/beam', 'stealth/glyph-cluster', 'kilo-auto/balanced', 'vendor/custom-model']) assert.equal(resolveKiloModel(id), id);
  assert.equal(resolveKiloModel('auto'), 'kilo-auto');
  assert.equal(resolveKiloModel('default'), 'kilo-default');
  assert.equal(resolveKiloModel(' '), 'unknown');
});

test('Kilo uses routed step models, separate token categories and cwd projects', async t => {
  const { root } = fixture(t, 'usage', session('s')
    + message('u', 's', T, 'user')
    + message('a', 's', T + 1000, 'assistant', { tokens: { input: 99999 } })
    + step('p', 'a', 's', T + 1000, { vercelID: 'request' }));
  const r = await withRoots([root]);
  assert.deepEqual(r.buckets, [{ source: 'kilo', model: 'openai/gpt-6-luna', project: 'project', bucketStart: '2026-10-20T01:00:00.000Z', inputTokens: 11, outputTokens: 7, cachedInputTokens: 13, reasoningOutputTokens: 3, cacheCreation5mTokens: 5, cacheCreation1hTokens: 0, totalTokens: 26 }]);
  assert.equal(r.sessions.length, 1);
  assert.equal(humans(r), 1);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(CANARY));
});

test('Kilo attributes multiple steps independently across half-hour windows and falls back per message', async t => {
  const { root } = fixture(t, 'steps', session('s') + message('u', 's', T, 'user')
    + message('multi', 's', T + 1000, 'assistant', { tokens: { input: 99999 } })
    + step('p1', 'multi', 's', T + 1000, { vercelID: 'r1' })
    + step('p2', 'multi', 's', T + 1801000, { vercelID: 'r2', model: { modelId: 'reflection/beam' }, tokens: { input: 2, reasoning: 4 } })
    + message('fallback', 's', T + 2000, 'assistant', { modelID: 'anthropic/claude-opus-5.5', tokens: { input: 4, output: 2 } })
    + step('empty-step', 'fallback', 's', T + 2000, { tokens: {} })
    + message('zero', 's', T + 3000, 'assistant', { tokens: {} }));
  const r = await withRoots([root]);
  assert.equal(r.buckets.length, 3);
  assert.equal(total(r), 38);
  const routed = r.buckets.find(b => b.model === 'reflection/beam');
  assert.equal(routed.bucketStart, '2026-10-20T01:30:00.000Z');
  assert.equal(routed.reasoningOutputTokens, 4);
});

test('Kilo keeps cache-only, reasoning-only and cache-write-only accounting', async t => {
  const { root } = fixture(t, 'categories', session('s') + message('u', 's', T, 'user')
    + message('cache', 's', T + 1000, 'assistant', { modelID: 'read-only', tokens: { cache: { read: 7 } } })
    + message('reason', 's', T + 2000, 'assistant', { modelID: 'reason-only', tokens: { reasoning: 3 } })
    + message('write', 's', T + 3000, 'assistant', { modelID: 'write-only', tokens: { cache: { write: 5 } } }));
  const r = await withRoots([root]);
  assert.equal(r.buckets.length, 3);
  assert.equal(r.buckets.find(b => b.model === 'read-only').cachedInputTokens, 7);
  assert.equal(r.buckets.find(b => b.model === 'reason-only').reasoningOutputTokens, 3);
  assert.equal(r.buckets.find(b => b.model === 'write-only').cacheCreation5mTokens, 5);
});

test('Kilo uses valid timestamp fallbacks and session directory when cwd is absent', async t => {
  const { root } = fixture(t, 'fallback', session('s', { directory: 'C:\\work\\fallback' })
    + message('u', 's', T, 'user', { path: {} })
    + message('a', 's', T + 1000, 'assistant', { path: {}, time: { created: 'bad' }, modelID: 'model', tokens: { output: 2 } })
    + step('p', 'a', 's', T + 1000, { model: {}, time: { start: 'bad' }, tokens: { output: 2 } }));
  const r = await withRoots([root]);
  assert.equal(r.buckets[0].project, 'fallback');
  assert.equal(r.buckets[0].bucketStart, '2026-10-20T01:00:00.000Z');
  assert.equal(r.buckets[0].model, 'model');
});

function originalAndFork({ identity = true, onlyFork = false, richer = false } = {}) {
  const ids = identity ? { generationID: 'generation', vercelID: 'request' } : {};
  const original = onlyFork ? '' : session('source') + message('u', 'source', T, 'user')
    + message('a', 'source', T + 1000, 'assistant') + step('p', 'a', 'source', T + 1000, ids);
  return original + session('fork', { created: T + 10000 })
    + message('copied-u', 'fork', T, 'user') + message('copied-a', 'fork', T + 1000, 'assistant')
    + step('copied-p', 'copied-a', 'fork', T + 1000, { ...ids, ...(richer ? { tokens: { ...tokens, input: 20 } } : {}) })
    + message('new-u', 'fork', T + 11000, 'user') + message('new-a', 'fork', T + 12000, 'assistant')
    + step('new-p', 'new-a', 'fork', T + 12000, { vercelID: 'new-request' });
}

test('Kilo removes proven rewritten-id fork usage and copied timing, preserving new work', async t => {
  for (const identity of [true, false]) {
    const { root } = fixture(t, `fork-${identity}`, originalAndFork({ identity }));
    const r = await withRoots([root]);
    assert.equal(total(r), 52);
    assert.equal(humans(r), 2);
    assert.equal(r.sessions.reduce((sum, s) => sum + s.messageCount, 0), 4);
  }
});

test('Kilo retains a sole inherited copy when the source has disappeared', async t => {
  const { root } = fixture(t, 'sole-fork', originalAndFork({ onlyFork: true }));
  const r = await withRoots([root]);
  assert.equal(total(r), 52);
  assert.equal(humans(r), 2);
});

test('Kilo keeps the richer proven fork copy once', async t => {
  const { root } = fixture(t, 'rich-fork', originalAndFork({ richer: true }));
  const r = await withRoots([root]);
  assert.equal(total(r), 61);
  assert.equal(humans(r), 2);
});

test('Kilo never deduplicates unrelated equal calls or repeated local request-id collisions', async t => {
  const rows = session('one') + session('two')
    + message('u1', 'one', T, 'user') + message('u2', 'two', T, 'user')
    + message('a1', 'one', T + 1000, 'assistant') + message('a2', 'one', T + 1000, 'assistant')
    + message('a3', 'two', T + 1000, 'assistant')
    + step('p1', 'a1', 'one', T + 1000, { vercelID: 'collision' })
    + step('p2', 'a2', 'one', T + 1000, { vercelID: 'collision' })
    + step('p3', 'a3', 'two', T + 1000, { vercelID: 'collision' });
  const { root } = fixture(t, 'repetitions', rows);
  const r = await withRoots([root]);
  assert.equal(total(r), 78);
  assert.equal(humans(r), 2);
});

test('Kilo pairs repeated inherited occurrences without collapsing original repetitions', async t => {
  let rows = session('source') + session('fork', { created: T + 10000 });
  for (const [s, prefix] of [['source', ''], ['fork', 'copied-']]) {
    rows += message(prefix + 'u', s, T, 'user');
    for (const n of [1, 2]) rows += message(prefix + 'a' + n, s, T + 1000, 'assistant')
      + step(prefix + 'p' + n, prefix + 'a' + n, s, T + 1000, { vercelID: 'same' });
  }
  const { root } = fixture(t, 'occurrences', rows);
  const r = await withRoots([root]);
  assert.equal(total(r), 52);
  assert.equal(humans(r), 1);
  assert.equal(r.sessions.length, 1);
});

test('Kilo counts deep child calls while folding injected prompts into the human session', async t => {
  let rows = session('root') + session('child', { parent: 'root' }) + session('grandchild', { parent: 'child' });
  for (const [index, s] of ['root', 'child', 'grandchild'].entries()) rows += message(s + '-u', s, T + index * 2000, 'user')
    + message(s + '-a', s, T + index * 2000 + 1000, 'assistant')
    + step(s + '-p', s + '-a', s, T + index * 2000 + 1000, { vercelID: s });
  const { root } = fixture(t, 'children', rows);
  const r = await withRoots([root]);
  assert.equal(total(r), 78);
  assert.equal(r.sessions.length, 1);
  assert.equal(humans(r), 1);
  assert.equal(r.sessions[0].messageCount, 6);
});

test('Kilo fails open for orphan and cyclic ancestry', async t => {
  let rows = session('orphan', { parent: 'missing' }) + session('cycle-a', { parent: 'cycle-b' }) + session('cycle-b', { parent: 'cycle-a' });
  for (const [index, s] of ['orphan', 'cycle-a', 'cycle-b'].entries()) rows += message(s + '-u', s, T + index * 2000, 'user')
    + message(s + '-a', s, T + index * 2000 + 1000, 'assistant', { tokens: { input: 2 } });
  const { root } = fixture(t, 'cycles', rows);
  const r = await withRoots([root]);
  assert.equal(total(r), 6);
  assert.equal(humans(r), 3);
  assert.equal(r.sessions.length, 3);
});

test('Kilo merges copied/richer stores and symlinks without duplicating timing', async t => {
  const first = fixture(t, 'copy-first', session('s') + message('u', 's', T, 'user')
    + message('a', 's', T + 1000, 'assistant') + step('p', 'a', 's', T + 1000, { tokens: { input: 1 } }));
  const second = fixture(t, 'copy-second', session('s') + message('u', 's', T, 'user')
    + message('a', 's', T + 1000, 'assistant') + step('p', 'a', 's', T + 1000, { tokens: { input: 9 } }));
  const alias = join(first.root, 'alias');
  symlinkSync(second.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const r = await withRoots([first.root, second.root, alias]);
  assert.equal(total(r), 9);
  assert.equal(humans(r), 1);
  assert.equal(r.sessions[0].messageCount, 2);
});

test('Kilo protects state on missing explicit, corrupt JSON, corrupt DB and incompatible stores', async t => {
  const valid = fixture(t, 'valid');
  const corrupt = fixture(t, 'corrupt');
  writeFileSync(corrupt.path, 'not SQLite');
  const incompatible = fixture(t, 'incompatible');
  sql(incompatible.path, 'DROP TABLE part;');
  const badJson = fixture(t, 'bad-json', session('s'));
  sql(badJson.path, `INSERT INTO message VALUES('a','s',${T},${T},'{broken');`);
  for (const bad of [join(valid.root, 'missing'), corrupt.root, incompatible.root, badJson.root]) {
    const r = await withRoots([valid.root, bad]);
    assert.equal(r.skipped, true);
    assert.deepEqual(r.buckets, []);
    assert.deepEqual(r.sessions, []);
    assert.ok(r.warnings.length);
  }
  const warnings = [];
  assert.deepEqual(findKiloDbs({ env: { KILO_DB: ':memory:' }, onWarning: w => warnings.push(w) }), []);
  assert.ok(warnings.length);
  assert.deepEqual(findKiloDbs({ env: {}, home: join(valid.root, 'missing-home') }), []);
});

test('Kilo treats a directory at an exact database target as failure, not absence', async t => {
  const { root } = fixture(t, 'wrong-type');
  const xdg = join(root, 'xdg');
  const target = join(xdg, 'kilo', 'kilo.db');
  mkdirSync(target, { recursive: true });
  for (const env of [{ XDG_DATA_HOME: xdg }, { KILO_DB: target }]) {
    const warnings = [];
    assert.deepEqual(findKiloDbs({ env, home: root, onWarning: w => warnings.push(w) }), []);
    assert.ok(warnings.length);
  }
});

test('Kilo reports a dangling default database symlink as a broken discovered store', { skip: process.platform === 'win32' && 'file symlinks require Windows privileges' }, t => {
  const { root } = fixture(t, 'dangling');
  const data = join(root, 'xdg', 'kilo');
  mkdirSync(data, { recursive: true });
  symlinkSync(join(root, 'missing.db'), join(data, 'kilo.db'));
  const warnings = [];
  assert.deepEqual(findKiloDbs({ env: { XDG_DATA_HOME: join(root, 'xdg') }, home: root, onWarning: w => warnings.push(w) }), []);
  assert.ok(warnings.length);
});

test('Kilo protects state on unreadable explicit and default databases', async t => {
  const { root, path } = fixture(t, 'unreadable');
  await withUnreadableFile(path, async () => {
    const r = await withRoots([root]);
    assert.equal(r.skipped, true);
  });
  const data = join(root, 'kilo');
  mkdirSync(data);
  const target = join(data, 'kilo.db');
  copyFileSync(path, target);
  await withUnreadableFile(target, async () => {
    const warnings = [];
    assert.deepEqual(findKiloDbs({ env: { XDG_DATA_HOME: root }, home: root, onWarning: w => warnings.push(w) }), []);
    assert.ok(warnings.length);
  });
});

test('Kilo reads active WAL data and leaves the source content unchanged', { skip: !DatabaseSync && 'requires node:sqlite for a live WAL writer' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-kilo-wal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'kilo.db');
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;${schema}${session('s')}${message('u', 's', T, 'user')}${message('a', 's', T + 1000, 'assistant')}${step('p', 'a', 's', T + 1000)}`);
    const before = readFileSync(path), beforeWal = readFileSync(path + '-wal');
    const r = await withRoots([root]);
    assert.equal(total(r), 26);
    assert.deepEqual(readFileSync(path), before);
    assert.deepEqual(readFileSync(path + '-wal'), beforeWal);
  } finally { db.close(); }
});

test('Kilo falls back to a disposable snapshot under an exclusive database lock', { skip: !DatabaseSync && 'requires node:sqlite to hold an exclusive writer lock' }, async t => {
  const { root, path } = fixture(t, 'locked', session('s') + message('u', 's', T, 'user')
    + message('a', 's', T + 1000, 'assistant') + step('p', 'a', 's', T + 1000));
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');
    const before = readFileSync(path);
    const r = await withRoots([root]);
    assert.notEqual(r.skipped, true);
    assert.equal(total(r), 26);
    assert.deepEqual(readFileSync(path), before);
  } finally { db.exec('ROLLBACK'); db.close(); }
});

test('Kilo query is allow-listed and never selects whole payloads or sensitive tables', () => {
  const code = readFileSync(new URL('../src/parsers/kilo.js', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /SELECT\s+(?:\w+\.)?(?:\*|data\b)/i);
  assert.doesNotMatch(code, /(?:FROM|JOIN)\s+(?:event|account|credential|session_input)\b/i);
  assert.doesNotMatch(code, /json_extract\([^,]+,\s*'\$\.(?:content|text|tools|error|cost)'/);
});

test('Kilo real parser sync is idempotent and a later failed parse preserves upload state', async t => {
  const { root, path } = fixture(t, 'sync', session('s') + message('u', 's', T, 'user')
    + message('a', 's', T + 1000, 'assistant') + step('p', 'a', 's', T + 1000));
  const config = join(root, 'config'), state = join(root, 'state'), home = join(root, 'home');
  for (const p of [config, state, home]) mkdirSync(p);
  const requests = [];
  const server = createServer((req, res) => {
    if (req.url === '/api/usage/settings') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ uploadProject: false }));
      return;
    }
    if (req.url === '/api/usage/ingest') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const data = JSON.parse(gunzipSync(Buffer.concat(chunks)).toString());
        requests.push(data);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ingested: data.buckets?.length || 0, sessions: data.sessions?.length || 0 }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    writeFileSync(join(config, 'config.json'), JSON.stringify({ apiKey: 'vbu_kilo_fixture', apiUrl: `http://127.0.0.1:${server.address().port}`, hostname: 'kilo-fixture' }));
    const command = `
      import { readFileSync, writeFileSync } from 'node:fs';
      import assert from 'node:assert/strict';
      import { parsers } from './src/parsers/index.js';
      for (const id of Object.keys(parsers)) if(id !== 'kilo') delete parsers[id];
      const { runSync } = await import('./src/sync.js');
      await runSync({throws:true,quiet:true});
      const before = readFileSync(process.env.VIBE_USAGE_STATE_DIR+'/state.json','utf8');
      await runSync({throws:true,quiet:true});
      assert.equal(readFileSync(process.env.VIBE_USAGE_STATE_DIR+'/state.json','utf8'),before);
      writeFileSync(process.env.KILO_TEST_DB,'corrupted fixture');
      await runSync({throws:true,quiet:true});
      assert.equal(readFileSync(process.env.VIBE_USAGE_STATE_DIR+'/state.json','utf8'),before);
    `;
    await execAsync(process.execPath, ['--input-type=module', '-e', command], { cwd: process.cwd(), env: { ...process.env, HOME: home, VIBE_USAGE_DEV: '0', VIBE_USAGE_CONFIG_DIR: config, VIBE_USAGE_STATE_DIR: state, VIBE_USAGE_KILO_DIRS: root, KILO_TEST_DB: path } });
    const buckets = requests.flatMap(r => r.buckets || []), sessions = requests.flatMap(r => r.sessions || []);
    assert.equal(buckets.length, 1);
    assert.equal(sessions.length, 1);
    assert.equal(buckets[0].source, 'kilo');
    assert.equal(buckets[0].project, 'unknown');
    assert.doesNotMatch(JSON.stringify(requests), new RegExp(CANARY));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
