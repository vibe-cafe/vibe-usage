import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'vibe-usage-kiki-'));
const kikiRoot = join(root, 'kiki');
const kimiRoot = join(root, 'kimi');
process.env.VIBE_USAGE_KIKI_DIR = kikiRoot;
process.env.VIBE_USAGE_KIMI_CODE_DIR = kimiRoot;
process.env.VIBE_USAGE_KIMI_DIR = join(root, 'legacy');
const { parse, normalizeKikiModel } = await import('../src/parsers/kiki.js');
const { parseCurrentKimiRoots } = await import('../src/parsers/kimi-code.js');
const { parsers } = await import('../src/parsers/index.js');
const { detectInstalledTools } = await import('../src/tools.js');
const { KIKI_SOURCE_ID, resolveKikiRoots, independentKikiRoots } = await import('../src/kiki-roots.js');
after(() => rmSync(root, { recursive: true, force: true }));

const start = Date.parse('2026-09-01T12:01:00Z');
function usage(model, offset, values = {}) {
  return { type: 'usage.record', time: start + offset, model, usageScope: 'turn',
    usage: { inputOther: 10, output: 2, inputCacheRead: 4, inputCacheCreation: 3, ...values } };
}
function wire(home, agent, records) {
  const sessionDir = join(home, 'sessions', 'wd_fallback_abcd', 'session_1');
  const dir = join(sessionDir, 'agents', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'wire.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
  writeFileSync(join(home, 'session_index.jsonl'), JSON.stringify({ sessionDir, workDir: join(root, 'project') }) + '\n');
}

test('Kiki roots honor isolation override, KIKI_HOME and platform paths', () => {
  assert.deepEqual(resolveKikiRoots({}, 'win32', 'C:\\Users\\fixture'), ['C:\\Users\\fixture\\.kiki']);
  assert.deepEqual(resolveKikiRoots({}, 'linux', '/home/fixture'), ['/home/fixture/.kiki']);
  assert.deepEqual(resolveKikiRoots({ KIKI_HOME: '/relocated' }), ['/relocated']);
  assert.deepEqual(resolveKikiRoots({ KIKI_HOME: '/ignored', VIBE_USAGE_KIKI_DIR: '/fixture' }), ['/fixture']);
  assert.deepEqual(independentKikiRoots([kikiRoot], [kikiRoot]), []);
});

test('only known prefixes are stripped, including nested routes, without guessing model aliases', () => {
  for (const [original, expected] of [
    ['axon/gpt-6.1-sol', 'gpt-6.1-sol'], ['kimi-code/k3-256k', 'k3-256k'],
    ['axon-message/gemini-3.8-flash', 'gemini-3.8-flash'],
    ['deepseek-v4-flash', 'deepseek-v4-flash'], ['Qwen/Qwen3.8-Flash', 'Qwen/Qwen3.8-Flash'],
    ['axon-message/Qwen/Qwen3.8-Flash', 'Qwen/Qwen3.8-Flash'],
    ['axon-chat/deepseek/deepseek-v4.1-flash', 'deepseek-v4.1-flash'],
    ['other/name', 'other/name'], ['axon/', 'axon/'],
  ]) assert.equal(normalizeKikiModel(original), expected);
  assert.equal(normalizeKikiModel('axon/model', []), 'axon/model');
});

test('Kiki reuses all delta scopes and folds agents into one session with exact counters', async () => {
  wire(kikiRoot, 'main', [
    { type: 'turn.prompt', origin: { kind: 'user' }, time: start, content: 'PRIVATE_CONTENT_SENTINEL' },
    { ...usage('axon/gpt-6.1-sol', 60000), content: 'PRIVATE_CONTENT_SENTINEL' },
    { ...usage('axon/gpt-6.1-sol', 120000), usageScope: 'session' },
    { ...usage('ignored', 0), time: 1e20 },
  ]);
  wire(kikiRoot, 'child', [usage('axon/gpt-6.1-sol', 180000)]);
  const result = await parse();
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].source, KIKI_SOURCE_ID);
  assert.equal(result.buckets[0].model, 'gpt-6.1-sol');
  assert.equal(result.buckets[0].project, 'project');
  assert.equal(result.buckets[0].inputTokens, 39);
  assert.equal(result.buckets[0].cachedInputTokens, 12);
  assert.equal(result.buckets[0].outputTokens, 6);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].userMessageCount, 1);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_CONTENT_SENTINEL'));
  assert.ok(detectInstalledTools().some(tool => tool.name === 'Kiki' && tool.id === 'kiki'));
  assert.equal(detectInstalledTools().filter(tool => tool.id === KIKI_SOURCE_ID).length, 1);
});

test('registry keeps identical Kiki and Kimi bucket coordinates under separate sources', async () => {
  wire(kimiRoot, 'main', [usage('gpt-6.1-sol', 60000)]);
  assert.equal(KIKI_SOURCE_ID, 'kiki');
  const kiki = await parsers.kiki();
  const kimi = await parsers['kimi-code']();
  assert.equal(kiki.buckets[0].source, 'kiki');
  assert.equal(kiki.buckets[0].inputTokens, 39);
  assert.equal(kiki.buckets[0].cachedInputTokens, 12);
  assert.equal(kiki.buckets[0].outputTokens, 6);
  assert.equal(kimi.buckets.length, 1);
  assert.equal(kimi.buckets[0].source, 'kimi-code');
  assert.equal(kimi.buckets[0].inputTokens, 13);
});

test('overlapping physical home is not counted as both Kimi and Kiki', async () => {
  const result = await parse({ excludeRoots: [kikiRoot] });
  assert.deepEqual(result, { buckets: [], sessions: [] });
});

test('shared reader accepts a future independent source without changing token semantics', () => {
  const result = parseCurrentKimiRoots([kikiRoot], { source: 'kiki' });
  assert.ok(result.buckets.every(bucket => bucket.source === 'kiki'));
  assert.ok(result.sessions.every(session => session.source === 'kiki'));
});

test('Opus counters are never repaired heuristically by the generic parser', async () => {
  wire(kikiRoot, 'opus', [usage('anthropic/claude-opus-5-5', 240000,
    { inputOther: 100000, inputCacheRead: 0, inputCacheCreation: 0 })]);
  const result = await parse();
  const opus = result.buckets.find(bucket => bucket.model === 'claude-opus-5-5');
  assert.equal(opus.inputTokens, 100000);
  assert.equal(opus.cachedInputTokens, 0);
});


test('copied wires merge unique deltas but preserve repeated calls within a file', () => {
  const original = join(root, 'original');
  const copy = join(root, 'copy');
  const prompt = { type: 'turn.prompt', origin: { kind: 'user' }, time: start };
  const record = usage('model', 1000);
  wire(original, 'main', [prompt, record, record]);
  wire(copy, 'main', [prompt, record, record, usage('model', 2000)]);
  wire(original, 'child', [record]);
  wire(copy, 'child', [record]);
  const result = parseCurrentKimiRoots([original, copy, original], { source: 'kiki', deduplicateCopies: true });
  assert.equal(result.buckets[0].inputTokens, 52); // 2 repeated + 1 unique main + 1 child
  assert.equal(result.buckets[0].cachedInputTokens, 16);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].userMessageCount, 1);
  // The opt-in does not change existing Kimi copied-store behavior.
  assert.equal(parseCurrentKimiRoots([original, copy]).buckets[0].inputTokens, 91);
});

test('KIKI_HOME relocation is used by parser and tool detection', async () => {
  const relocated = join(root, 'relocated');
  wire(relocated, 'main', [usage('model', 1000)]);
  const saved = process.env.VIBE_USAGE_KIKI_DIR;
  const savedHome = process.env.KIKI_HOME;
  try {
    delete process.env.VIBE_USAGE_KIKI_DIR;
    process.env.KIKI_HOME = relocated;
    const result = await parsers.kiki();
    assert.equal(result.buckets[0].source, 'kiki');
    assert.equal(result.buckets[0].inputTokens, 13);
    assert.ok(detectInstalledTools().some(t => t.id === 'kiki' && t.name === 'Kiki'));
  } finally {
    process.env.VIBE_USAGE_KIKI_DIR = saved;
    if (savedHome === undefined) delete process.env.KIKI_HOME;
    else process.env.KIKI_HOME = savedHome;
  }
});

test('registry does not collect a Kimi home again when KIKI_HOME points at it', async () => {
  const saved = process.env.VIBE_USAGE_KIKI_DIR;
  try {
    process.env.VIBE_USAGE_KIKI_DIR = kimiRoot;
    assert.deepEqual(await parsers.kiki(), { buckets: [], sessions: [] });
    assert.equal((await parsers['kimi-code']()).buckets[0].inputTokens, 13);
  } finally { process.env.VIBE_USAGE_KIKI_DIR = saved; }
});

test('cached-only usage is retained without inventing input or a TTL', () => {
  const home = join(root, 'cached-only');
  wire(home, 'main', [usage('model', 1000, { inputOther: 0, inputCacheCreation: 0, output: 0, inputCacheRead: 9 })]);
  const result = parseCurrentKimiRoots([home], { source: 'kiki', deduplicateCopies: true });
  assert.equal(result.buckets[0].inputTokens, 0);
  assert.equal(result.buckets[0].outputTokens, 0);
  assert.equal(result.buckets[0].cachedInputTokens, 9);
  assert.equal(result.buckets[0].totalTokens, 0); // shared protocol excludes cache reads
  assert.equal(result.buckets[0].cacheCreation5mTokens, 0);
});
