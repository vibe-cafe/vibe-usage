import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from '../src/parsers/dimagent.js';
import { getDimAgentRustDbPaths } from '../src/tools.js';
import { classifyWarning } from '../src/warning-codes.js';

// Synthetic Rust Dim stores shaped like arcships/dim store formats 52 (alpha)
// and 23 (no leader column) -- only the tables and columns the parser reads.

async function runSql(dbPath, sqlText) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    // Node 20 exercises the sqlite3 CLI fallback used by queryDbJson().
  }
  if (DatabaseSync) {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(sqlText);
    } finally {
      db.close();
    }
    return;
  }
  execFileSync('sqlite3', [dbPath, sqlText]);
}

const q = value => `'${String(value).replace(/'/g, "''")}'`;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const at = minutes => T0 + minutes * 60_000;

function event({ id, sequence, at: createAt, type, name, data, tags }) {
  return JSON.stringify({
    encoding: 'event',
    record: {
      event: { id, sequence, create_at: createAt, ...(tags ? { tags } : {}), type, name, data },
      refs: null,
      trace: null,
      batch_end: sequence,
    },
  });
}

class Store {
  constructor({ leader = true, catalog = true } = {}) {
    this.leader = leader;
    this.catalog = catalog;
    this.sessions = [];
    this.events = [];
    this.sequence = new Map();
  }

  session(id, { cwd = '/work/demo-app', model = 'config-model', createdAt = T0, leaderId = null, config } = {}) {
    this.sessions.push({ id, cwd, model, createdAt, leaderId, config });
    return this;
  }

  push(sessionId, branchId, kind, data, { id, at: createAt, tags } = {}) {
    const key = `${sessionId}\0${branchId}`;
    const sequence = (this.sequence.get(key) || 0) + 1;
    this.sequence.set(key, sequence);
    const [type, name] = kind.split('/');
    const eventId = id || `${sessionId}-${branchId}-${sequence}`;
    this.events.push({
      sessionId, branchId, sequence, kind, eventId,
      body: event({ id: eventId, sequence, at: createAt, type, name, data, tags }),
    });
    return eventId;
  }

  prompt(sessionId, minutes, { branchId = 'main', tags, applied = true, id } = {}) {
    const eventId = this.push(sessionId, branchId, 'input/message',
      { submission_id: 'sub', user: { content: [{ type: 'text', text: 'hello' }] }, mode: 'queue' },
      { at: at(minutes), tags, id });
    if (applied) this.push(sessionId, branchId, 'input/applied', { input_id: eventId, mode: 'queue' }, { at: at(minutes), tags });
    return eventId;
  }

  runtimeBlock(sessionId, minutes) {
    const eventId = this.push(sessionId, 'main', 'input/message',
      { blocks: [{ type: 'raw', text: '<dim-state source="x">state</dim-state>' }] }, { at: at(minutes) });
    this.push(sessionId, 'main', 'input/applied', { input_id: eventId }, { at: at(minutes) });
  }

  call(sessionId, minutes, requestId, usage, { branchId = 'main', model = 'gpt-test', usageId, config } = {}) {
    this.push(sessionId, branchId, 'model/call', {
      turn_id: 'turn', request_id: requestId,
      request: { providerId: 'dim', modelId: model, messages: [], config },
    }, { at: at(minutes) });
    return this.push(sessionId, branchId, 'model/usage', { turn_id: 'turn', request_id: requestId, usage },
      { at: at(minutes) + 1000, id: usageId });
  }

  async write(dbPath) {
    const sessionsTable = this.leader
      ? 'CREATE TABLE agent_sessions (session_id TEXT NOT NULL PRIMARY KEY, config TEXT NOT NULL, created_at_ms INTEGER NOT NULL, leader_session_id TEXT, origin TEXT NOT NULL DEFAULT \'unknown\');'
      : 'CREATE TABLE agent_sessions (session_id TEXT NOT NULL PRIMARY KEY, config TEXT NOT NULL, created_at_ms INTEGER NOT NULL);';
    const rows = [
      sessionsTable,
      this.catalog ? 'CREATE TABLE session_catalog (session_id TEXT NOT NULL PRIMARY KEY, updated_at_ms INTEGER NOT NULL, preview TEXT, cwd TEXT NOT NULL);' : '',
      'CREATE TABLE timeline_branches (session_id TEXT NOT NULL, branch_id TEXT NOT NULL, info TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY (session_id, branch_id));',
      'CREATE TABLE timeline_events (session_id TEXT NOT NULL, branch_id TEXT NOT NULL, sequence INTEGER NOT NULL, last_sequence INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, event_id TEXT, PRIMARY KEY (session_id, branch_id, sequence));',
    ];
    for (const s of this.sessions) {
      const config = JSON.stringify({ cwd: s.cwd, model: { providerId: 'dim', modelId: s.model, config: s.config } });
      rows.push(this.leader
        ? `INSERT INTO agent_sessions VALUES (${q(s.id)}, ${q(config)}, ${s.createdAt}, ${s.leaderId ? q(s.leaderId) : 'NULL'}, 'client');`
        : `INSERT INTO agent_sessions VALUES (${q(s.id)}, ${q(config)}, ${s.createdAt});`);
      if (this.catalog) rows.push(`INSERT INTO session_catalog VALUES (${q(s.id)}, ${s.createdAt}, NULL, ${q(s.cwd)});`);
    }
    for (const e of this.events) {
      rows.push(`INSERT INTO timeline_events VALUES (${q(e.sessionId)}, ${q(e.branchId)}, ${e.sequence}, ${e.sequence}, ${q(e.kind)}, ${q(e.body)}, ${q(e.eventId)});`);
    }
    await runSql(dbPath, rows.join('\n'));
  }
}

async function legacyStore(dbPath, model = 'legacy-model') {
  await runSql(dbPath, `
    CREATE TABLE sessions (sessionId TEXT PRIMARY KEY, cwd TEXT NOT NULL);
    CREATE TABLE usage_ledger (ledgerId TEXT PRIMARY KEY, sessionId TEXT NOT NULL, runId TEXT,
      providerId TEXT NOT NULL, modelId TEXT NOT NULL, usage TEXT NOT NULL, cost REAL, createdAt TEXT NOT NULL);
    CREATE TABLE messages (messageId TEXT PRIMARY KEY, sessionId TEXT NOT NULL, role TEXT NOT NULL, createdAt TEXT NOT NULL);
    INSERT INTO sessions VALUES ('legacy', '/work/legacy-app');
    INSERT INTO usage_ledger VALUES ('usage_run-1', 'legacy', 'run-1', 'dim', ${q(model)},
      '{"promptTokens":100,"completionTokens":20,"totalTokens":120,"cacheReadTokens":40}', NULL, '2026-07-01T00:10:00.000Z');
    INSERT INTO messages VALUES
      ('u1', 'legacy', 'user', '2026-07-01T00:00:00.000Z'),
      ('a1', 'legacy', 'assistant', '2026-07-01T00:00:05.000Z');
  `);
}

async function withEnv(vars, fn) {
  const previous = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-dimagent-rust-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const byModel = buckets => Object.fromEntries(buckets.map(bucket => [bucket.model, bucket]));
const SMALL_USAGE = { promptTokens: 50, completionTokens: 5, totalTokens: 55 };
const tier = (provider, serviceTier) => ({ providerOptions: { [provider]: { serviceTier } } });

function parseStores(root, paths, legacyPath = join(root, 'absent.sqlite')) {
  return withEnv({ VIBE_USAGE_DIMAGENT_DB: legacyPath, VIBE_USAGE_DIMAGENT_RUST_DBS: paths.join(delimiter) }, parse);
}

test('Rust Dim usage: token split, request model, compaction, branches, forks and member Sessions', async t => {
  const root = tempRoot(t);
  const store = new Store()
    .session('main', { cwd: '/work/demo-app', createdAt: T0 })
    .session('fork', { cwd: '/work/demo-app', createdAt: T0 + 3_600_000 })
    .session('member', { cwd: '/work/demo-app', createdAt: T0 + 60_000, leaderId: 'main' })
    .session('quiet', { cwd: '/work/other-app', createdAt: T0 });

  // Anthropic-shaped: promptTokens already holds cache reads and writes.
  store.prompt('main', 0);
  store.runtimeBlock('main', 0);
  store.call('main', 1, 'r1', {
    promptTokens: 1000, completionTokens: 300, totalTokens: 1300,
    cacheReadTokens: 600, cacheWriteTokens: 100, reasoningTokens: 50,
  }, { model: 'claude-test', usageId: 'usage-r1' });
  // A child branch's own call counts.
  store.call('main', 2, 'r2', { promptTokens: 200, completionTokens: 20, totalTokens: 220 },
    { branchId: 'branch-a', model: 'gpt-test' });
  // Compaction summarizer usage lives only on the compaction event.
  store.push('main', 'main', 'context/compaction', {
    turn_id: 'turn', request_id: 'r3', start: 1, through: 1, status: 'completed',
    diagnostics: { modelCallCount: 1, modelUsage: { promptTokens: 5000, completionTokens: 400, totalTokens: 5400, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  }, { at: at(3) });
  store.push('main', 'main', 'model/call', {
    turn_id: 'turn', request_id: 'r3', request: { providerId: 'dim', modelId: 'claude-test', messages: [] },
  }, { at: at(3) });
  // A withdrawn prompt never reached the conversation.
  store.prompt('main', 4, { applied: false });

  // The fork copies main's events with their ids, then adds its own.
  store.push('fork', 'main', 'model/call', {
    turn_id: 'turn', request_id: 'r1', request: { providerId: 'dim', modelId: 'claude-test', messages: [] },
  }, { at: at(1) });
  store.push('fork', 'main', 'model/usage', {
    turn_id: 'turn', request_id: 'r1',
    usage: { promptTokens: 1000, completionTokens: 300, totalTokens: 1300, cacheReadTokens: 600, cacheWriteTokens: 100, reasoningTokens: 50 },
  }, { at: at(1) + 1000, id: 'usage-r1' });
  store.prompt('fork', 70);
  store.call('fork', 71, 'r4', { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, { model: 'gpt-test' });

  // A member Session's calls count; its prompts come from the leader.
  store.prompt('member', 5);
  store.call('member', 6, 'r5', { promptTokens: 70, completionTokens: 7, totalTokens: 77 }, { model: 'member-model' });

  // Internal work without any human prompt: tokens count, no session.
  store.call('quiet', 8, 'r6', { promptTokens: 40, completionTokens: 4, totalTokens: 44 }, { model: 'quiet-model' });

  const dbPath = join(root, 'dimcode.sqlite');
  await store.write(dbPath);

  const result = await withEnv({ VIBE_USAGE_DIMAGENT_DB: join(root, 'absent.sqlite'), VIBE_USAGE_DIMAGENT_RUST_DBS: dbPath },
    () => parse());
  assert.equal(result.skipped, undefined);
  assert.equal(result.warnings, undefined);

  const models = byModel(result.buckets);
  // claude-test: r1 once (fork copy dropped) + compaction 5000/400.
  assert.deepEqual(
    {
      inputTokens: models['claude-test'].inputTokens,
      outputTokens: models['claude-test'].outputTokens,
      cachedInputTokens: models['claude-test'].cachedInputTokens,
      reasoningOutputTokens: models['claude-test'].reasoningOutputTokens,
      cacheCreation5mTokens: models['claude-test'].cacheCreation5mTokens,
      cacheCreation1hTokens: models['claude-test'].cacheCreation1hTokens,
      project: models['claude-test'].project,
    },
    {
      inputTokens: 300 + 5000,
      outputTokens: 250 + 400,
      cachedInputTokens: 600,
      reasoningOutputTokens: 50,
      cacheCreation5mTokens: 100,
      cacheCreation1hTokens: 0,
      project: 'demo-app',
    },
  );
  const gptTotals = result.buckets.filter(b => b.model === 'gpt-test')
    .reduce((s, b) => ({ input: s.input + b.inputTokens, output: s.output + b.outputTokens }), { input: 0, output: 0 });
  assert.deepEqual(gptTotals, { input: 210, output: 25 });
  assert.equal(models['member-model'].inputTokens, 70);
  assert.equal(models['quiet-model'].project, 'other-app');

  // main (with member folded in) and fork; quiet has no human prompt.
  assert.equal(result.sessions.length, 2);
  const mainSession = result.sessions.find(s => s.firstMessageAt === new Date(at(0)).toISOString());
  assert.equal(mainSession.userMessageCount, 1);
  // prompt, r1, r2 (branch), member prompt + r5 as agent activity.
  assert.equal(mainSession.messageCount, 5);
  const forkSession = result.sessions.find(s => s !== mainSession);
  assert.equal(forkSession.userMessageCount, 1);
  assert.equal(forkSession.messageCount, 2);
});

test('Rust Dim: imported legacy history adds no timing, older store formats and copied homes', async t => {
  const root = tempRoot(t);
  const store = new Store({ leader: false, catalog: false })
    .session('imported', { cwd: '/work/imported-app', model: 'fallback-model' });
  store.prompt('imported', 0, { tags: ['migration:legacy-import'] });
  store.prompt('imported', 10);
  // A usage without its model/call falls back to the Session's model.
  store.push('imported', 'main', 'model/usage', {
    turn_id: 'turn', request_id: 'lonely', usage: { promptTokens: 30, completionTokens: 3, totalTokens: 33 },
  }, { at: at(11) });

  const first = join(root, 'a.sqlite');
  const copy = join(root, 'b.sqlite');
  await store.write(first);
  await store.write(copy);

  const result = await withEnv({ VIBE_USAGE_DIMAGENT_DB: join(root, 'absent.sqlite'), VIBE_USAGE_DIMAGENT_RUST_DBS: [first, copy].join(delimiter) },
    () => parse());
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].model, 'fallback-model');
  assert.equal(result.buckets[0].project, 'imported-app');
  assert.equal(result.buckets[0].inputTokens, 30);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].userMessageCount, 1);
  assert.equal(result.sessions[0].firstMessageAt, new Date(at(10)).toISOString());
});

test('legacy and Rust stores merge; a failing store warns, the others still sync', async t => {
  const root = tempRoot(t);
  const legacyPath = join(root, 'v2.sqlite');
  await legacyStore(legacyPath);
  const rustPath = join(root, 'rust.sqlite');
  const store = new Store().session('s1');
  store.prompt('s1', 0);
  store.call('s1', 1, 'r1', { promptTokens: 50, completionTokens: 5, totalTokens: 55 }, { model: 'rust-model' });
  await store.write(rustPath);
  const broken = join(root, 'broken.sqlite');
  writeFileSync(broken, 'not a database at all, just bytes that are long enough to fail');

  const both = await withEnv({ VIBE_USAGE_DIMAGENT_DB: legacyPath, VIBE_USAGE_DIMAGENT_RUST_DBS: rustPath }, () => parse());
  assert.deepEqual(Object.keys(byModel(both.buckets)).sort(), ['legacy-model', 'rust-model']);
  assert.equal(both.sessions.length, 2);
  assert.equal(both.skipped, undefined);

  // A broken Rust store: the legacy store and the healthy Rust store still sync.
  const rustBroken = await withEnv({
    VIBE_USAGE_DIMAGENT_DB: legacyPath,
    VIBE_USAGE_DIMAGENT_RUST_DBS: [broken, rustPath].join(delimiter),
  }, () => parse());
  assert.equal(rustBroken.skipped, true);
  assert.deepEqual(Object.keys(byModel(rustBroken.buckets)).sort(), ['legacy-model', 'rust-model']);
  assert.equal(rustBroken.warnings.length, 1);
  assert.match(rustBroken.warnings[0], /^DimAgent: 无法读取 .*broken\.sqlite: /);

  // A broken legacy store: the Rust store still syncs.
  const legacyBroken = await withEnv({ VIBE_USAGE_DIMAGENT_DB: broken, VIBE_USAGE_DIMAGENT_RUST_DBS: rustPath }, () => parse());
  assert.equal(legacyBroken.skipped, true);
  assert.deepEqual(Object.keys(byModel(legacyBroken.buckets)), ['rust-model']);
  assert.match(legacyBroken.warnings[0], /^DimAgent: 无法读取 .*broken\.sqlite: /);

  // A SQLite file that is not a Dim store is a format problem, not data loss.
  const foreign = join(root, 'foreign.sqlite');
  await runSql(foreign, 'CREATE TABLE something_else (id INTEGER);');
  const foreignResult = await withEnv({ VIBE_USAGE_DIMAGENT_DB: legacyPath, VIBE_USAGE_DIMAGENT_RUST_DBS: foreign }, () => parse());
  assert.equal(foreignResult.skipped, true);
  assert.match(foreignResult.warnings[0], /不认识的表结构/);
  assert.deepEqual(Object.keys(byModel(foreignResult.buckets)), ['legacy-model']);

  const missingColumn = join(root, 'missing-column.sqlite');
  await runSql(missingColumn, 'CREATE TABLE agent_sessions (session_id TEXT); CREATE TABLE timeline_events (kind TEXT);');
  const incompatible = await withEnv({
    VIBE_USAGE_DIMAGENT_DB: legacyPath, VIBE_USAGE_DIMAGENT_RUST_DBS: missingColumn,
  }, () => parse());
  assert.equal(incompatible.skipped, true);
  assert.equal(classifyWarning(incompatible.warnings[0]), 'unsupported_format');
  assert.deepEqual(Object.keys(byModel(incompatible.buckets)), ['legacy-model']);
});

test('Rust Dim reads a store reached through a directory link only once', async t => {
  const root = tempRoot(t);
  const home = join(root, 'home');
  const alias = join(root, 'alias');
  mkdirSync(home);
  symlinkSync(home, alias, 'junction');
  const broken = join(home, 'dimcode.sqlite');
  writeFileSync(broken, 'not a SQLite database');

  const result = await withEnv({
    VIBE_USAGE_DIMAGENT_DB: join(root, 'absent.sqlite'),
    VIBE_USAGE_DIMAGENT_RUST_DBS: [broken, join(alias, 'dimcode.sqlite')].join(delimiter),
  }, () => parse());
  assert.equal(result.skipped, true);
  assert.equal(result.warnings.length, 1);
});

test('Rust Dim ignores Timeline rows whose session was deleted from that store', async t => {
  const root = tempRoot(t);
  const first = join(root, 'deleted.sqlite');
  const second = join(root, 'other-home.sqlite');
  const deleted = new Store();
  deleted.prompt('deleted-everywhere', 0);
  deleted.call('deleted-everywhere', 1, 'old', SMALL_USAGE, { model: 'deleted-model' });
  // The same session id is visible in a second home, where only a different
  // request remains. It must not make the first store's orphan rows eligible.
  deleted.prompt('shared', 0, { id: 'deleted-shared-prompt' });
  deleted.call('shared', 1, 'old-shared', SMALL_USAGE, { model: 'deleted-shared-model', usageId: 'deleted-shared-usage' });
  await deleted.write(first);

  const live = new Store().session('shared', { cwd: '/work/live-app' });
  live.prompt('shared', 5);
  live.call('shared', 6, 'live', SMALL_USAGE, { model: 'live-model' });
  await live.write(second);

  const result = await parseStores(root, [first, second]);
  assert.deepEqual(result.buckets.map(({ model, project, inputTokens }) => ({ model, project, inputTokens })), [
    { model: 'live-model', project: 'live-app', inputTokens: 50 },
  ]);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].firstMessageAt, new Date(at(5)).toISOString());
  assert.equal(result.sessions[0].messageCount, 2);
  assert.equal(result.skipped, undefined);
});

test('Rust Dim namespaces bare auto in calls and session fallback', async t => {
  const root = tempRoot(t);
  const rustPath = join(root, 'rust.sqlite');
  const legacyPath = join(root, 'legacy.sqlite');
  const store = new Store().session('s', { model: 'auto' });
  store.call('s', 1, 'selected', SMALL_USAGE, { model: 'auto' });
  store.push('s', 'main', 'model/usage', { turn_id: 'turn', request_id: 'missing', usage: SMALL_USAGE }, { at: at(2) });
  store.call('s', 3, 'concrete', SMALL_USAGE, { model: 'provider/auto' });
  await store.write(rustPath);
  await legacyStore(legacyPath, 'auto');

  const { buckets } = await parseStores(root, [rustPath], legacyPath);
  const models = byModel(buckets);
  assert.deepEqual(Object.keys(models).sort(), ['auto', 'dimagent-auto', 'provider/auto']);
  assert.equal(models['dimagent-auto'].inputTokens, 100);
  assert.equal(models['provider/auto'].inputTokens, 50);
  assert.equal(models.auto.project, 'legacy-app');
});

test('Rust Dim names only known price-changing service tiers for each request', async t => {
  const root = tempRoot(t);
  const dbPath = join(root, 'rust.sqlite');
  const store = new Store().session('s');
  const tiers = [
    ['openai', 'priority'],
    ['openai-compatible', 'flex'],
    ['openai', 'batch'],
    ['openai-compatible', 'ultrafast'],
    ['openai-compatible', 'fast'],
    ['openai', 'default'],
    ['openai-compatible', 'auto'],
    ['openai', 'unrecognized'],
  ];
  // Automatic compaction precedes its model/call within the same branch.
  store.push('s', 'main', 'context/compaction', {
    turn_id: 'turn', request_id: 'priority', status: 'completed', diagnostics: { modelCallCount: 1, modelUsage: SMALL_USAGE },
  }, { at: at(0) });
  for (const [provider, serviceTier] of tiers) {
    store.call('s', 1, serviceTier, SMALL_USAGE, { model: 'gpt-test', config: tier(provider, serviceTier) });
  }
  await store.write(dbPath);

  const { buckets } = await parseStores(root, [dbPath]);
  const models = byModel(buckets);
  assert.deepEqual(Object.keys(models).sort(), [
    'gpt-test', 'gpt-test-batch', 'gpt-test-fast', 'gpt-test-flex', 'gpt-test-priority', 'gpt-test-ultrafast',
  ]);
  assert.equal(models['gpt-test'].inputTokens, 150);
  assert.equal(models['gpt-test-priority'].inputTokens, 100);
});

test('Rust Dim attributes manual compaction to the last earlier configuration on its own branch', async t => {
  const root = tempRoot(t);
  const dbPath = join(root, 'rust.sqlite');
  const store = new Store()
    .session('s', { model: 'initial-model', config: tier('openai', 'batch') })
    .session('fallback', { model: 'fallback-model', config: tier('openai', 'flex') });
  const configure = (branch, minute, modelId, config) => store.push('s', branch, 'context/configured', {
    timeline: branch, revision: `${branch}-${modelId}`, settings: { providerId: 'dim', modelId, config },
  }, { at: at(minute) });
  const compact = (session, branch, minute) => store.push(session, branch, 'context/compaction', {
    status: 'completed', diagnostics: { modelCallCount: 1, modelUsage: SMALL_USAGE },
  }, { at: at(minute) });
  configure('side', 0, 'previous-model', tier('openai', 'batch'));
  configure('side', 3, 'switched-model', tier('openai-compatible', 'priority'));
  configure('main', 4, 'other-branch-model', tier('openai', 'ultrafast'));
  compact('s', 'side', 5);
  // Sequence is authoritative even if timestamps are tied or move backwards.
  configure('side', 2, 'later-model', tier('openai', 'flex'));
  compact('s', 'side', 6);
  compact('fallback', 'main', 1);
  await store.write(dbPath);

  const { buckets } = await parseStores(root, [dbPath]);
  assert.deepEqual(buckets.map(bucket => bucket.model).sort(), [
    'fallback-model-flex', 'later-model-flex', 'switched-model-priority',
  ]);
  assert.ok(buckets.every(bucket => bucket.inputTokens === 50));
});

test('Rust Dim excludes inherited fork timing after the original session is deleted', async t => {
  const root = tempRoot(t);
  const dbPath = join(root, 'fork.sqlite');
  const store = new Store().session('fork', { createdAt: at(10) });
  store.prompt('fork', 0);
  store.call('fork', 1, 'original', SMALL_USAGE);
  store.push('fork', 'main', 'session/forked', {}, { at: at(2) });
  store.prompt('fork', 3);
  store.call('fork', 4, 'first-fork', SMALL_USAGE);
  store.push('fork', 'main', 'session/forked', {}, { at: at(10) });
  store.prompt('fork', 11);
  store.call('fork', 12, 'second-fork', SMALL_USAGE);
  // A real child branch uses its own sequence numbers, starting after a
  // different origin. The main branch's sequence cutoff cannot apply to it.
  store.prompt('fork', 13, { branchId: 'side' });
  store.call('fork', 14, 'side-request', SMALL_USAGE, { branchId: 'side' });
  await store.write(dbPath);

  const { buckets, sessions } = await parseStores(root, [dbPath]);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].inputTokens, 200);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].userMessageCount, 2);
  assert.equal(sessions[0].messageCount, 4);
  assert.equal(sessions[0].firstMessageAt, new Date(at(11)).toISOString());
  assert.equal(sessions[0].lastMessageAt, new Date(at(14) + 1000).toISOString());
});

test('Rust Dim keeps sessions with cyclic leaders independent', async t => {
  const root = tempRoot(t);
  const dbPath = join(root, 'rust.sqlite');
  const store = new Store()
    .session('one', { leaderId: 'two', cwd: '/work/one' })
    .session('two', { leaderId: 'one', cwd: '/work/two' });
  store.prompt('one', 1);
  store.call('one', 2, 'r1', SMALL_USAGE);
  store.prompt('two', 3);
  store.call('two', 4, 'r2', SMALL_USAGE);
  await store.write(dbPath);

  const { sessions } = await parseStores(root, [dbPath]);
  const counts = sessions.map(s => [s.project, s.userMessageCount, s.messageCount]);
  assert.deepEqual(counts.sort(([a], [b]) => a.localeCompare(b)), [['one', 1, 2], ['two', 1, 2]]);
});

test('Rust Dim uses completed output for timing when usage is missing', async t => {
  const root = tempRoot(t);
  const dbPath = join(root, 'rust.sqlite');
  const store = new Store().session('s');
  store.prompt('s', 0);
  store.call('s', 1, 'with-usage', SMALL_USAGE);
  const completes = requestId => ({ turn_id: 'turn', request_id: requestId, status: 'completed', finish_reason: 'stop' });
  store.push('s', 'main', 'step/model-output-end', completes('with-usage'), { at: at(2) });
  store.push('s', 'main', 'model/call', {
    turn_id: 'turn', request_id: 'without-usage', request: { providerId: 'dim', modelId: 'gpt-test', messages: [] },
  }, { at: at(3) });
  store.push('s', 'main', 'step/model-output-end', completes('without-usage'), { at: at(4) });
  await store.write(dbPath);

  const { sessions, buckets } = await parseStores(root, [dbPath]);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].totalTokens, SMALL_USAGE.totalTokens);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].messageCount, 3);
  assert.equal(sessions[0].lastMessageAt, new Date(at(4)).toISOString());
});

test('Rust Dim discovery reads every product home', async t => {
  const root = tempRoot(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const custom = join(root, 'custom-home');
  const paths = await withEnv({
    HOME: home, USERPROFILE: home, DIMCODE_HOME: custom,
    VIBE_USAGE_DIMAGENT_DB: undefined, VIBE_USAGE_DIMAGENT_RUST_DBS: undefined,
  }, () => getDimAgentRustDbPaths());
  assert.deepEqual(paths, [
    join(custom, 'rust', 'dimcode.sqlite'),
    join(home, '.dimcode-alpha', 'rust', 'dimcode.sqlite'),
    join(home, '.dimcode', 'rust', 'dimcode.sqlite'),
    join(home, '.dim', 'rust', 'dimcode.sqlite'),
  ]);

  // A fixture that points only the legacy store somewhere reads no real home.
  const isolated = await withEnv({
    HOME: home, USERPROFILE: home, DIMCODE_HOME: undefined,
    VIBE_USAGE_DIMAGENT_DB: join(root, 'v2.sqlite'), VIBE_USAGE_DIMAGENT_RUST_DBS: undefined,
  }, () => getDimAgentRustDbPaths());
  assert.deepEqual(isolated, []);
});
