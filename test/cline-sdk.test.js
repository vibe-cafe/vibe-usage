import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parse } from '../src/parsers/cline.js';
import { findClineDataDirs } from '../src/cline-roots.js';

const start = Date.parse('2026-09-12T08:00:00Z');
const user = (id, ts = start) => ({ id, role: 'user', ts, content: 'Synthetic test prompt' });
const assistant = (id, ts = start + 1000, model = 'test-model') => ({
  id, role: 'assistant', ts, content: 'Synthetic reply',
  modelInfo: { id: model, provider: 'openai-compatible' },
  metrics: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10, cost: 999 },
});
function writeSession(root, id, messages, options = {}) {
  const dir = join(root, 'data', 'sessions', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ version: 1, session_id: id,
    started_at: new Date(options.started ?? start).toISOString(), cwd: '/work/project',
    workspace_root: '/work/project', model: 'fallback-model', prompt: 'DO NOT UPLOAD', ...options.manifest }));
  writeFileSync(join(dir, `${id}.messages.json`), JSON.stringify({ version: 1, sessionId: id,
    agent: 'lead', origin: { source: 'cli', mode: 'user', sessionId: id, version: '3.0.61' },
    messages, system_prompt: 'DO NOT UPLOAD', ...options.payload }));
  return dir;
}
async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-cline-sdk-'));
  const old = process.env.VIBE_USAGE_CLINE_DIRS;
  process.env.VIBE_USAGE_CLINE_DIRS = root;
  try { await run(root); }
  finally {
    if (old === undefined) delete process.env.VIBE_USAGE_CLINE_DIRS;
    else process.env.VIBE_USAGE_CLINE_DIRS = old;
    rmSync(root, { recursive: true, force: true });
  }
}

test('Cline 3 SDK artifacts are detected and split inclusive input/cache exactly once', async () => fixture(async root => {
  writeSession(root, 'one', [user('u'), assistant('a')]);
  assert.deepEqual(findClineDataDirs(), [join(root, 'data', 'sessions')]);
  const result = await parse();
  assert.equal(result.buckets.length, 1);
  const b = result.buckets[0];
  assert.equal(b.inputTokens, 70); // Includes cache write; don't add those 10 again.
  assert.equal(b.cachedInputTokens, 30);
  assert.equal(b.outputTokens, 20);
  assert.equal(result.sessions[0].userMessageCount, 1);
  assert.equal(result.sessions[0].durationSeconds, 1);
  assert.equal(JSON.stringify(result).includes('DO NOT UPLOAD'), false);
  assert.equal(JSON.stringify(result).includes('cost'), false);
}));

test('resumed Cline sessions keep old usage and count new equal-sized calls and model switches', async () => fixture(async root => {
  writeSession(root, 'one', [user('u'), assistant('a')]);
  const first = await parse();
  writeSession(root, 'one', [user('u'), assistant('a'), user('u2', start + 2000), assistant('a2', start + 3000, 'other-model')]);
  const second = await parse();
  assert.equal(first.buckets[0].inputTokens, 70);
  assert.equal(second.buckets.reduce((n, b) => n + b.inputTokens, 0), 140);
  assert.equal(second.buckets.length, 2);
  assert.equal(second.sessions.length, 1);
  assert.equal(second.sessions[0].userMessageCount, 2);
  assert.deepEqual(await parse(), second);
}));

test('copied stores and symlinked roots do not duplicate Cline SDK usage', async () => fixture(async root => {
  const a = join(root, 'a'), b = join(root, 'b');
  writeSession(a, 'one', [user('u'), assistant('a')]);
  cpSync(a, b, { recursive: true });
  symlinkSync(a, join(root, 'alias'), 'dir');
  process.env.VIBE_USAGE_CLINE_DIRS = [a, b, join(root, 'alias')].join(delimiter);
  const result = await parse();
  assert.equal(result.buckets[0].inputTokens, 70);
  assert.equal(result.sessions.length, 1);
}));

test('restored history is counted once while separate calls with equal usage remain distinct', async () => fixture(async root => {
  writeSession(root, 'original', [user('u'), assistant('a')]);
  writeSession(root, 'restored', [user('u'), assistant('a'), user('u2', start + 2000), assistant('a2', start + 3000)], { started: start + 2000 });
  const result = await parse();
  assert.equal(result.buckets[0].inputTokens, 140);
  assert.equal(result.sessions.reduce((n, s) => n + s.userMessageCount, 0), 2);
}));

test('subagent artifacts contribute their own usage without counting inherited history or agent prompts as human turns', async () => fixture(async root => {
  const dir = writeSession(root, 'one', [user('u'), assistant('a')]);
  writeFileSync(join(dir, 'worker.messages.json'), JSON.stringify({ version: 1, sessionId: 'one__worker', agent: 'subagent',
    origin: { parentThreadId: 'one' }, messages: [user('u'), assistant('a'), user('agent-prompt', start + 2000), assistant('worker-reply', start + 3000)] }));
  const result = await parse();
  assert.equal(result.buckets[0].inputTokens, 140);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].userMessageCount, 1);
}));

test('tool results and synthetic user messages are not human prompts', async () => fixture(async root => {
  writeSession(root, 'one', [user('u'), assistant('a'),
    { ...user('tool'), content: [{ type: 'tool_result', content: 'test' }] },
    { ...user('system'), metadata: { kind: 'completion_reminder' } },
    { ...user('zero'), metadata: { userRunSpan: 0 } },
  ]);
  const result = await parse();
  assert.equal(result.sessions[0].userMessageCount, 1);
}));

test('legacy data/ store remains additive and migrated cumulative metrics are not re-dated', async () => fixture(async root => {
  const data = join(root, 'data');
  mkdirSync(join(data, 'state'), { recursive: true });
  mkdirSync(join(data, 'tasks', 'one'), { recursive: true });
  writeFileSync(join(data, 'state', 'taskHistory.json'), JSON.stringify([{ id: 'one', cwd: '/work/project' }]));
  writeFileSync(join(data, 'tasks', 'one', 'ui_messages.json'), JSON.stringify([
    { type: 'ask', ts: start },
    { type: 'say', say: 'api_req_started', ts: start + 1000, text: JSON.stringify({ model: 'test-model', tokensIn: 70, tokensOut: 20, cacheReads: 30 }) },
  ]));
  const migrated = assistant('old-summary'); delete migrated.ts;
  writeSession(root, 'one', [migrated, user('new', start + 2000), assistant('new-reply', start + 3000)]);
  const result = await parse();
  assert.equal(result.buckets[0].inputTokens, 140);
  assert.equal(result.buckets[0].cachedInputTokens, 60);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].userMessageCount, 2);
}));

test('corrupt or unsupported SDK artifacts skip the source instead of pruning old state', async () => fixture(async root => {
  const dir = writeSession(root, 'one', [user('u'), assistant('a')]);
  const path = join(dir, 'one.messages.json');
  const before = readFileSync(path);
  for (const value of ['{', JSON.stringify({ version: 2, messages: [] }), JSON.stringify({ version: 1, sessionId: 'wrong', messages: [] })]) {
    writeFileSync(path, value);
    const result = await parse();
    assert.equal(result.skipped, true);
    assert.deepEqual(result.buckets, []);
    assert.ok(result.warnings.length > 0);
  }
  writeFileSync(path, before);
  assert.equal((await parse()).skipped, undefined);
}));

test('SDK discovery honors CLINE_DATA_DIR without requiring a diagnostic override', async () => fixture(async root => {
  writeSession(root, 'one', [user('u'), assistant('a')]);
  const env = { ...process.env, CLINE_DATA_DIR: join(root, 'data') };
  delete env.VIBE_USAGE_CLINE_DIRS;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    'import { findClineDataDirs } from "./src/cline-roots.js"; console.log(JSON.stringify(findClineDataDirs()))'], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8' }));
  assert.ok(result.includes(join(root, 'data', 'sessions')));
}));
