import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const suiteHome = mkdtempSync(join(tmpdir(), 'vibe-magpie-suite-'));
const originalEnv = { ...process.env };
// Set homes before importing config/state/cache modules; each test also gets
// independent parser roots. No source discovery may reach the developer home.
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'VIBE_USAGE_CONFIG_DIR', 'VIBE_USAGE_STATE_DIR', 'VIBE_USAGE_CACHE_DIR']) process.env[key] = suiteHome;
function restoreEnv(env) {
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
}
test.after(() => { restoreEnv(originalEnv); rmSync(suiteHome, { recursive: true, force: true }); });
const { createMagpieContext } = await import('../src/parsers/magpie.js');
const { parse: claude } = await import('../src/parsers/claude-code.js');
const { parse: codex } = await import('../src/parsers/codex.js');
const { parse: pi } = await import('../src/parsers/pi-coding-agent.js');
const { parse: omp } = await import('../src/parsers/omp.js');
const { parse: opencode } = await import('../src/parsers/opencode.js');
const parsers = { claude, codex, pi, omp, opencode };
const sample = JSON.parse(readFileSync(new URL('./fixtures/magpie/recorded-samples.json', import.meta.url)));
const T = '2026-11-05T09:10:00.000Z';
const NOW = Date.parse('2026-11-05T12:00:00Z');
const require = createRequire(import.meta.url);
function sql(path, text) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* Node 20. */ }
  if (DatabaseSync) { const db = new DatabaseSync(path); try { db.exec(text); } finally { db.close(); } }
  else execFileSync('sqlite3', [path], { input: text });
}
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
function jsonl(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}
function fixture(t) {
  const root = mkdtempSync(join(suiteHome, 'case-'));
  const paths = Object.fromEntries(['claude', 'codex', 'pi', 'omp', 'opencode', 'cache'].map(tool => [tool, join(root, tool)]));
  const env = {
    CODEX_HOME: paths.codex, VIBE_USAGE_CLAUDE_DIRS: paths.claude,
    VIBE_USAGE_CLAUDE_DESKTOP_DIRS: join(root, 'absent'), VIBE_USAGE_CINDY_DIRS: join(root, 'absent'),
    VIBE_USAGE_PI_SESSION_DIRS: paths.pi, VIBE_USAGE_OMP_SESSION_DIRS: paths.omp,
    VIBE_USAGE_OPENCODE_DIRS: paths.opencode, VIBE_USAGE_CACHE_DIR: paths.cache,
    VIBE_USAGE_MAGPIE_TEST_FILE: join(root, 'magpie', 'usage.jsonl'),
    VIBE_USAGE_CODEX_CACHE: '1', VIBE_USAGE_CODEX_WORK_BUDGET_MS: '60000',
  };
  const old = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => { restoreEnv(old); rmSync(root, { recursive: true, force: true }); });
  const ledger = rows => jsonl(env.VIBE_USAGE_MAGPIE_TEST_FILE, rows);
  return { root, paths, file: env.VIBE_USAGE_MAGPIE_TEST_FILE, ledger };
}
function context(startAt = 'none', now = NOW) { return createMagpieContext({ startAt, now }); }
function row(extra = {}) {
  return { t: T, ms: 100, agent: 'pi', provider: 'deepseek', model: 'deepseek-flash',
    req: 'group/lab', response_id: 'response-1', session: 'ses_fixture',
    in: 100, out: 20, cache_read: 30, cache_write: 10, status: 200, ...extra };
}

function synthetic(f, tool, { model = 'group/lab', provider = 'magpie', responseModel,
  timestamp = T, responseId = 'response-1', requestId, fast = false } = {}) {
  const date = Date.parse(timestamp);
  const usage = { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, reasoning: 4 };
  if (tool === 'claude') {
    jsonl(join(f.paths.claude, 'projects', 'fixture', 'session.jsonl'), [
      { type: 'user', timestamp, cwd: '/Users/example/fixture' },
      { type: 'assistant', timestamp, requestId, message: { id: responseId, model,
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30,
          cache_creation_input_tokens: 10, ...(fast ? { speed: 'fast' } : {}) } } },
    ]);
  } else if (tool === 'codex') {
    const u = { input_tokens: 140, output_tokens: 20, cached_input_tokens: 30, reasoning_output_tokens: 4, total_tokens: 160 };
    jsonl(join(f.paths.codex, 'sessions', 'rollout.jsonl'), [
      { type: 'session_meta', timestamp, payload: { id: 'session', cwd: '/Users/example/fixture', model_provider: provider } },
      { type: 'turn_context', timestamp, payload: { model } },
      { type: 'token_usage_record', timestamp, payload: { response_id: responseId, usage: u, thread_token_usage: u } },
      { type: 'event_msg', timestamp, payload: { type: 'token_count', info: { last_token_usage: u, total_token_usage: u } } },
    ]);
  } else if (tool === 'opencode') {
    const dir = join(f.paths.opencode, 'storage', 'message', 'ses_fixture');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'reply.json'), JSON.stringify({ id: 'reply', role: 'assistant', modelID: model, providerID: provider,
      time: { created: date, completed: date + 100 }, path: { root: '/Users/example/fixture' },
      tokens: { input: 100, output: 16, reasoning: 4, cache: { read: 30, write: 10 } } }));
  } else {
    jsonl(join(f.paths[tool], 'session.jsonl'), [
      { type: 'session', id: 'session', timestamp, cwd: '/Users/example/fixture' },
      { type: 'message', id: 'user', timestamp, message: { role: 'user' } },
      { type: 'message', id: 'reply', timestamp, message: { role: 'assistant', provider, model, responseId, responseModel, usage } },
    ]);
  }
}

test('recorded samples: all five tools match exact ledger calls and preserve both accounting tracks', async t => {
  const f = fixture(t);
  f.ledger(sample.ledger);
  for (const [name, records] of Object.entries(sample.files)) {
    const [prefix, file] = name.split('--');
    const target = prefix === 'claude-code' ? join(f.paths.claude, 'projects', 'fixture', file)
      : prefix === 'codex' ? join(f.paths.codex, 'sessions', file) : join(f.paths[prefix], file);
    jsonl(target, records);
  }
  mkdirSync(f.paths.opencode, { recursive: true });
  sql(join(f.paths.opencode, 'opencode.db'), 'CREATE TABLE message (id TEXT, session_id TEXT, data TEXT);'
    + sample.opencode.message.map(r => `INSERT INTO message VALUES (${quote(r.id)},${quote(r.session_id)},${quote(JSON.stringify(r.data))});`).join(''));
  const expectedCalls = { claude: 9, codex: 4, pi: 5, omp: 4, opencode: 4 };
  const shared = context();
  for (const [tool, parse] of Object.entries(parsers)) {
    const before = await parse();
    const after = await parse({ magpie: shared });
    assert.equal(after.skipped, undefined, tool);
    assert.deepEqual(after.sessions, before.sessions, tool + ' timing');
    for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'cacheCreation5mTokens', 'totalTokens']) {
      const sum = result => result.buckets.reduce((n, b) => n + b[key], 0);
      assert.equal(sum(after), sum(before), tool + ' ' + key);
    }
    // Independently sum the exact successful ledger rows belonging to local
    // calls. OpenCode title requests are deliberately absent from local data.
    let ids;
    if (tool === 'opencode') ids = new Set(sample.opencode.message.filter(r => r.data.role === 'assistant')
      .map(r => r.session_id));
    else ids = new Set(Object.entries(sample.files).filter(([n]) => n.startsWith((tool === 'claude' ? 'claude-code' : tool) + '--'))
      .flatMap(([, records]) => records.map(r => tool === 'codex' ? r.payload?.response_id : tool === 'claude' ? r.message?.id : r.message?.responseId)).filter(Boolean));
    const calls = sample.ledger.filter(r => r.status === 200 && r.agent === tool
      && (tool === 'opencode' ? ids.has(r.session) && sample.opencode.message.some(m => m.session_id === r.session
        && m.data.tokens?.input === r.in && m.data.tokens?.output + (m.data.tokens?.reasoning || 0) === r.out) : ids.has(r.response_id)));
    assert.equal(calls.length, expectedCalls[tool]);
    assert.equal(after.buckets.reduce((n, b) => n + b.outputTokens + b.reasoningOutputTokens, 0), calls.reduce((n, r) => n + r.out, 0));
    const changed = calls.filter(r => r.req.startsWith('group/') || r.req.startsWith('claude-haiku'));
    // member-mode Claude already records the concrete name, including stand-in calls.
    const expectedOutput = tool === 'claude' ? 13 + 2 + 2 + 36 : changed.reduce((n, r) => n + r.out, 0);
    assert.equal(after.buckets.filter(b => b.model.startsWith('magpie/')).reduce((n, b) => n + b.outputTokens + b.reasoningOutputTokens, 0), expectedOutput);
  }
  assert.equal(shared.bytesRead, Buffer.byteLength(sample.ledger.map(JSON.stringify).join('\n') + '\n'), 'one shared ledger scan');
});

for (const tool of Object.keys(parsers)) {
  test(`${tool}: exact match, mismatch and conflicting models; prefix, all served tiers, original name and cut`, async t => {
    const f = fixture(t);
    synthetic(f, tool);
    for (const tier of ['priority', 'fast', 'flex', undefined]) {
      f.ledger([row({ agent: tool, tier_served: tier })]);
      const result = await parsers[tool]({ magpie: context() });
      assert.equal(result.buckets[0].model, 'magpie/deepseek/deepseek-flash' + (tier ? '-' + tier : ''));
    }
    for (const rows of [[], [row({ in: 101 })], [row(), row({ model: 'different-model' })],
      [row(), row({ model: 'different-model', in: 101 })]]) {
      f.ledger(rows.map(r => ({ ...r, agent: tool })));
      assert.equal((await parsers[tool]({ magpie: context() })).buckets[0].model, 'group/lab');
    }
    f.ledger([row({ agent: tool })]);
    for (const startAt of [undefined, '2026-11-05T09:30:00Z']) {
      assert.equal((await parsers[tool]({ magpie: createMagpieContext({ startAt, now: NOW }) })).buckets[0].model, 'group/lab');
    }
    assert.equal((await parsers[tool]({ magpie: context('2026-11-05T09:00:00Z') })).buckets[0].model, 'magpie/deepseek/deepseek-flash');
    synthetic(f, tool, { model: 'deepseek/deepseek-flash[1m]:high' });
    assert.equal((await parsers[tool]({ magpie: context() })).buckets[0].model, 'deepseek/deepseek-flash[1m]:high');
    rmSync(f.file);
    assert.deepEqual((await parsers[tool]({ magpie: context() })).buckets, (await parsers[tool]()).buckets);
  });
}

test('Pi responseModel works without a ledger but obeys the cut; OMP ignores it', async t => {
  const f = fixture(t);
  for (const tool of ['pi', 'omp']) synthetic(f, tool, { responseModel: 'deepseek/deepseek-flash' });
  const pending = createMagpieContext({ now: NOW });
  assert.equal((await pi({ magpie: pending })).buckets[0].model, 'group/lab');
  const auto = createMagpieContext({ now: NOW, onPossible: () => 'none' });
  assert.equal((await pi({ magpie: auto })).buckets[0].model, 'magpie/deepseek/deepseek-flash');
  assert.equal(auto.startAt, 'none');
  assert.equal((await omp({ magpie: context() })).buckets[0].model, 'group/lab');
  synthetic(f, 'pi', { responseModel: 'office/group/nested' });
  assert.equal((await pi({ magpie: context() })).buckets[0].model, 'group/lab');
});

test('auto uses served, missing actual models retain originals; Claude fast is added once', async t => {
  const f = fixture(t);
  synthetic(f, 'claude', { model: 'claude-haiku-4-5', fast: true });
  for (const tier of ['fast', undefined]) {
    f.ledger([row({ provider: 'copilot', model: 'auto', served: 'gpt-5-mini', tier_served: tier })]);
    assert.equal((await claude({ magpie: context() })).buckets[0].model, 'magpie/copilot/gpt-5-mini-fast');
  }
  for (const extra of [{ model: 'auto' }, { model: '' }, { model: undefined }]) {
    f.ledger([row(extra)]);
    assert.equal((await claude({ magpie: context() })).buckets[0].model, 'claude-haiku-4-5-fast');
  }
});

test('Codex cache hits and append tails keep raw ids/models and reapply attribution every sync', async t => {
  const f = fixture(t);
  synthetic(f, 'codex'); // includes ten cache-write tokens: 140 = 100 + 30 + 10
  f.ledger([row()]);
  const first = await codex({ magpie: context() });
  assert.equal(first.buckets[0].model, 'magpie/deepseek/deepseek-flash');
  assert.equal(first.buckets[0].inputTokens, 110);
  const warm = await codex({ magpie: context('2026-11-05T09:30:00Z') });
  assert.equal(warm.cache.filesRead, 0);
  assert.equal(warm.buckets[0].model, 'group/lab');
  f.ledger([row({ model: 'another-model' })]);
  const renamed = await codex({ magpie: context() });
  assert.equal(renamed.cache.filesRead, 0);
  assert.equal(renamed.buckets[0].model, 'magpie/deepseek/another-model');
  const u = { input_tokens: 140, cached_input_tokens: 30, output_tokens: 20, reasoning_output_tokens: 4, total_tokens: 160 };
  appendFileSync(join(f.paths.codex, 'sessions', 'rollout.jsonl'), JSON.stringify({ type: 'token_usage_record', timestamp: '2026-11-05T09:11:00Z',
    payload: { response_id: 'response-2', usage: u, thread_token_usage: { ...u, total_tokens: 320 } } }) + '\n');
  f.ledger([row(), row({ response_id: 'response-2' })]);
  const appended = await codex({ magpie: context() });
  assert.equal(appended.cache.tailHits, 1);
  assert.equal(appended.buckets[0].inputTokens, 220);
  for (const dir of readdirSync(f.paths.cache + '/codex')) for (const file of readdirSync(join(f.paths.cache, 'codex', dir))) {
    const text = readFileSync(join(f.paths.cache, 'codex', dir, file), 'utf8');
    assert.doesNotMatch(text, /magpie\/deepseek/);
    if (text.includes('magpieEntries')) assert.match(text, /response-1/);
  }
  // Same-id continuation merging must preserve provider and response ids too.
  const original = readFileSync(join(f.paths.codex, 'sessions', 'rollout.jsonl'));
  writeFileSync(join(f.paths.codex, 'sessions', 'copy.jsonl'), original);
  const copied = await codex({ magpie: context() });
  assert.deepEqual(copied.buckets, appended.buckets);
});

test('ledger tolerates malformed lines, retries partial tails and never reads usage-others', async t => {
  const f = fixture(t);
  synthetic(f, 'omp');
  f.ledger([row()]);
  appendFileSync(f.file, 'bad-json\n');
  const partial = JSON.stringify(row({ response_id: 'response-2', model: 'second-model' }));
  appendFileSync(f.file, partial.slice(0, -8));
  const shared = context();
  assert.equal((await omp({ magpie: shared })).buckets[0].model, 'magpie/deepseek/deepseek-flash');
  assert.equal(shared.failed, false);
  synthetic(f, 'omp', { responseId: 'response-2' });
  assert.equal((await omp({ magpie: shared })).buckets[0].model, 'group/lab');
  appendFileSync(f.file, partial.slice(-8) + '\n');
  assert.equal((await omp({ magpie: shared })).buckets[0].model, 'magpie/deepseek/second-model');
  jsonl(join(dirname(f.file), 'usage-others', 'device', 'day.json'), [row({ response_id: 'response-2' })]);
  rmSync(f.file);
  assert.equal((await omp({ magpie: context() })).buckets[0].model, 'group/lab');
});

test('ledger filters failed, handed-on, reported and other-computer rows independently', async t => {
  const f = fixture(t);
  synthetic(f, 'omp');
  for (const extra of [{ status: 500 }, { handed_on: true }, { source: 'reported' }, { computer: 'other-computer' }]) {
    f.ledger([row({ provider: 'claude', rid: 'request-1', ...extra })]);
    const magpie = context();
    assert.equal((await omp({ magpie })).buckets[0].model, 'group/lab');
    assert.equal(magpie.isBridge(new Set(['request-1'])), false);
  }
  f.ledger([row({ handed_on: false, source: '', computer: '' })]);
  assert.equal((await omp({ magpie: context() })).buckets[0].model, 'magpie/deepseek/deepseek-flash');
});

test('cut eligibility is checked once per context even when the cut remains undefined', t => {
  const f = fixture(t);
  for (const result of [undefined, 'none']) {
    let calls = 0;
    const magpie = createMagpieContext({ onPossible: () => { calls++; return result; } });
    magpie.discover();
    assert.equal(calls, 0, 'no ledger or response model yet');
    magpie.discover(true);
    f.ledger([row()]);
    magpie.prepare();
    magpie.discover(true);
    assert.equal(calls, 1);
    assert.equal(magpie.startAt, result);
    rmSync(f.file);
  }
});

test('Claude collects deduplicated bridge ids only when the ledger exists at initial discovery', async t => {
  const f = fixture(t);
  synthetic(f, 'claude', { requestId: 'request-1' });
  const path = join(f.paths.claude, 'projects', 'fixture', 'session.jsonl');
  appendFileSync(path, readFileSync(path));
  jsonl(join(f.paths.claude, 'transcripts', 'timing.jsonl'), [
    { type: 'user', timestamp: T, requestId: 'timing-request' },
    { type: 'assistant', timestamp: T, requestId: 'timing-request' },
  ]);
  const baseline = await claude();
  const absent = context();
  absent.discover();
  assert.equal(absent.ledgerExists, false);
  for (const method of ['prepare', 'isBridge', 'attribute']) {
    absent[method] = () => assert.fail(`absent ledger must not call ${method}`);
  }
  assert.deepEqual(await claude({ magpie: absent }), baseline);
  f.ledger([row()]);
  assert.deepEqual(await claude({ magpie: absent }), baseline, 'initial discovery stays fixed for this sync');

  const present = context();
  const requests = [];
  present.isBridge = ids => {
    assert.ok(ids instanceof Set);
    requests.push([...ids]);
    return false;
  };
  const result = await claude({ magpie: present });
  assert.equal(present.ledgerExists, true);
  assert.deepEqual(requests, [['request-1'], ['timing-request']]);
  assert.equal(result.buckets[0].model, 'magpie/deepseek/deepseek-flash');
  assert.deepEqual(result.sessions, baseline.sessions);
});

test('dated cuts read only a recent ledger suffix; XDG and default paths stay isolated', async t => {
  const f = fixture(t);
  synthetic(f, 'omp');
  const old = row({ t: '2026-10-01T00:00:00Z' });
  f.ledger([...Array(3000).fill(old), row()]);
  const recent = context('2026-11-05T09:00:00Z');
  assert.equal((await omp({ magpie: recent })).buckets[0].model, 'magpie/deepseek/deepseek-flash');
  assert.ok(recent.bytesRead < 65536);
  delete process.env.VIBE_USAGE_MAGPIE_TEST_FILE;
  process.env.XDG_CONFIG_HOME = join(f.root, 'xdg');
  jsonl(join(process.env.XDG_CONFIG_HOME, 'magpie', 'usage.jsonl'), [row()]);
  assert.equal((await omp({ magpie: context() })).buckets[0].model, 'magpie/deepseek/deepseek-flash');
  delete process.env.XDG_CONFIG_HOME;
  process.env.HOME = f.root; process.env.USERPROFILE = f.root;
  jsonl(join(f.root, '.config', 'magpie', 'usage.jsonl'), [row()]);
  assert.equal((await omp({ magpie: context() })).buckets[0].model, 'magpie/deepseek/deepseek-flash');
});

test('OpenCode requires both sides unique and reads provider/end-time in the v2 projection', async t => {
  const f = fixture(t);
  synthetic(f, 'opencode');
  f.ledger([row({ agent: 'opencode' })]);
  const dir = join(f.paths.opencode, 'storage', 'message', 'ses_fixture');
  const data = JSON.parse(readFileSync(join(dir, 'reply.json')));
  writeFileSync(join(dir, 'other.json'), JSON.stringify({ ...data, id: 'other' }));
  assert.equal((await opencode({ magpie: context() })).buckets[0].model, 'group/lab');
  rmSync(join(dir, 'other.json'));
  f.ledger([row({ agent: 'opencode' }), row({ agent: 'opencode', response_id: 'another' })]);
  assert.equal((await opencode({ magpie: context() })).buckets[0].model, 'group/lab');
  f.ledger([row({ agent: 'opencode' })]);
  sql(join(f.paths.opencode, 'opencode.db'), 'CREATE TABLE session_v2 (id TEXT, directory TEXT);'
    + 'CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, time_created INTEGER, data TEXT);'
    + `INSERT INTO session_v2 VALUES ('ses_fixture', '/Users/example/fixture');`
    + `INSERT INTO session_message VALUES ('reply','ses_fixture','assistant',${Date.parse(T)},${quote(JSON.stringify({ ...data, model: { id: data.modelID, providerID: 'magpie' }, modelID: undefined, providerID: undefined }))});`);
  assert.equal((await opencode({ magpie: context() })).buckets[0].model, 'magpie/deepseek/deepseek-flash');
});

test('subscription bridge skips the entire Claude session only for exact rid, Claude provider and supported callers', async t => {
  const f = fixture(t);
  synthetic(f, 'claude', { requestId: 'request-1' });
  for (const agent of ['claude', 'codex', 'pi', 'omp', 'opencode']) {
    for (const response_id of ['response-1', 'different-response', undefined]) {
      f.ledger([row({ provider: 'claude', rid: 'request-1', agent, response_id })]);
      const result = await claude({ magpie: createMagpieContext() });
      assert.deepEqual(result.buckets, []);
      assert.deepEqual(result.sessions, []);
    }
  }
  for (const extra of [{ agent: 'zed' }, { provider: 'anthropic' }, { rid: '' }, { rid: ' request-1' }, { rid: 'other' }]) {
    f.ledger([row({ provider: 'claude', rid: 'request-1', agent: 'pi', ...extra })]);
    const result = await claude({ magpie: createMagpieContext() });
    assert.equal(result.buckets.length, 1);
    assert.equal(result.sessions.length, 1);
  }
});

test('recent unmatched calls wait ten minutes for all five tools, only after the cut', async t => {
  const f = fixture(t);
  f.ledger([]);
  for (const [tool, parse] of Object.entries(parsers)) {
    synthetic(f, tool);
    const recent = context('none', Date.parse(T) + 599_999);
    await parse({ magpie: recent });
    assert.equal(recent.pending.length, 1, tool);
    const old = context('none', Date.parse(T) + 600_001);
    await parse({ magpie: old });
    assert.equal(old.pending.length, 0, tool);
    const beforeCut = context('2026-11-05T09:30:00Z', Date.parse(T) + 1);
    await parse({ magpie: beforeCut });
    assert.equal(beforeCut.pending.length, 0, tool);
    synthetic(f, tool, { provider: 'direct', model: 'claude-sonnet-4-6' });
    const direct = context('none', Date.parse(T) + 1);
    await parse({ magpie: direct });
    assert.equal(direct.pending.length, 0, tool);
  }
});

test('an existing unreadable ledger is a failure, never a successful unmatched snapshot', async t => {
  const f = fixture(t);
  synthetic(f, 'omp');
  mkdirSync(f.file, { recursive: true });
  const broken = context();
  assert.equal((await omp({ magpie: broken })).buckets[0].model, 'group/lab');
  assert.equal(broken.failed, true);
});

test('a mid-read IO failure discards partial matching decisions', async t => {
  const f = fixture(t);
  synthetic(f, 'omp');
  f.ledger([row(), ...Array(1000).fill(row({ response_id: 'unrelated' }))]);
  const original = fs.readSync;
  let reads = 0;
  fs.readSync = (...args) => {
    if (++reads === 2) throw new Error('synthetic read failure');
    return original(...args);
  };
  syncBuiltinESMExports();
  try {
    const failed = context();
    // Read the ledger directly so unrelated parser file IO is not intercepted.
    failed.prepare();
    assert.equal(failed.failed, true);
    assert.ok(failed.bytesRead > 0);
    assert.equal(failed.attribute([{ source: 'omp', model: 'group/lab', timestamp: T,
      magpie: { responseId: 'response-1', counts: [100, 20, 30, 10] } }], 'omp')[0].model, 'group/lab');
  } finally { fs.readSync = original; syncBuiltinESMExports(); }
});
