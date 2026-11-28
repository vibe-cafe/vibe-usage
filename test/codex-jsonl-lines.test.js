import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import zlib from 'node:zlib';
import { parse } from '../src/parsers/codex.js';

// A rollout record ends at a newline byte and nowhere else. Codex writes
// U+2028 and U+2029 raw inside JSON strings, and Node 24's readline ends a
// line at each of them (Node 20/22 do not), which cut such a record in two
// unparseable halves and dropped it. Every fixture here is synthetic.

const previousCindyDirs = process.env.VIBE_USAGE_CINDY_DIRS;
process.env.VIBE_USAGE_CINDY_DIRS = join(tmpdir(), 'vibe-usage-cindy-disabled');
test.after(() => {
  if (previousCindyDirs === undefined) delete process.env.VIBE_USAGE_CINDY_DIRS;
  else process.env.VIBE_USAGE_CINDY_DIRS = previousCindyDirs;
});

const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function';
const needsZstd = HAS_ZSTD ? {} : { skip: 'node:zlib has no zstd before Node 22.15' };

// U+2028 and U+2029 end a line in Node 24's readline (issue #174); U+0085 is a
// Unicode line separator that it does not split on today and is here as a guard.
const SEPARATORS = ['\u2028', '\u2029', '\u0085'];

function sessionMeta(timestamp, id, extra = {}) {
  return { timestamp, type: 'session_meta', payload: { id, cwd: '/Users/x/proj', timestamp, ...extra } };
}

function usage(input, cached, output, reasoning) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

function tokenCount(timestamp, last, cumulativeTotal, text = null) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      // A real record carries no free text; the field is here only to put the
      // separator inside the record that carries the tokens.
      ...(text == null ? {} : { note: text }),
      info: { model: 'gpt-5.2', total_token_usage: { total_tokens: cumulativeTotal }, last_token_usage: last },
    },
  };
}

function agentMessage(timestamp, message) {
  return { timestamp, type: 'event_msg', payload: { type: 'agent_message', message } };
}

function jsonl(records) {
  return `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
}

const DAY_DIR = join('sessions', '2026', '07', '10');
const T0 = '2026-07-10T08:00:00.000Z';

/** One rollout shape, with `marker` standing in for the text a separator sits in. */
function rollout(marker, separator) {
  const text = (label) => `${marker}${separator}${label}`;
  return [
    sessionMeta(T0, 'lines-1', { instructions: text('instructions') }),
    { type: 'turn_context', timestamp: T0, payload: { model: 'gpt-5.2', summary: text('summary') } },
    tokenCount(T0, usage(100, 40, 10, 2), 110, text('first')),
    agentMessage('2026-07-10T08:05:00.000Z', text('answer')),
    tokenCount('2026-07-10T08:35:00.000Z', usage(200, 50, 20, 5), 330, text('second')),
    { type: 'user_message', timestamp: '2026-07-10T08:50:00.000Z', payload: { message: text('prompt') } },
  ];
}

function writeRollouts(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name.includes('/') ? name : join(DAY_DIR, name));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
}

async function withCodexHome(fn) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codex-lines-'));
  const saved = {
    CODEX_HOME: process.env.CODEX_HOME,
    VIBE_USAGE_CACHE_DIR: process.env.VIBE_USAGE_CACHE_DIR,
    VIBE_USAGE_CODEX_WORK_BUDGET_MS: process.env.VIBE_USAGE_CODEX_WORK_BUDGET_MS,
  };
  process.env.CODEX_HOME = root;
  process.env.VIBE_USAGE_CACHE_DIR = join(root, 'cache');
  process.env.VIBE_USAGE_CODEX_WORK_BUDGET_MS = '600000';
  try {
    return await fn(root);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

async function parseRollouts(files) {
  return withCodexHome(async root => {
    writeRollouts(root, files);
    return parse();
  });
}

/** Buckets and sessions only, in a stable order. */
function view(result) {
  return {
    buckets: [...result.buckets]
      .map(({ source, ...bucket }) => bucket)
      .sort((a, b) => `${a.bucketStart}${a.model}`.localeCompare(`${b.bucketStart}${b.model}`)),
    sessions: [...result.sessions]
      .map(({ sessionHash, ...session }) => session)
      .sort((a, b) => String(a.firstMessageAt).localeCompare(String(b.firstMessageAt))),
  };
}

for (const separator of SEPARATORS) {
  const name = `U+${separator.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

  test(`a plain rollout parses the same whatever ${name} sits inside its records`, async () => {
    const plain = await parseRollouts({ 'rollout-a.jsonl': jsonl(rollout('marker', '')) });
    const marked = await parseRollouts({ 'rollout-a.jsonl': jsonl(rollout('marker', separator)) });
    assert.deepEqual(view(marked), view(plain));
    // Not just equal: the records around the separators are really there
    // (input excludes the cache reads: 100 - 40 + 200 - 50).
    assert.equal(marked.buckets.reduce((sum, bucket) => sum + bucket.inputTokens, 0), 210);
    assert.equal(marked.buckets[0].project, 'proj');
    assert.equal(marked.sessions.length, 1);
  });

  test(`a compressed rollout parses the same whatever ${name} sits inside its records`, needsZstd, async () => {
    const plain = await parseRollouts({ 'rollout-a.jsonl': jsonl(rollout('marker', '')) });
    const marked = await parseRollouts({
      'rollout-a.jsonl.zst': zlib.zstdCompressSync(Buffer.from(jsonl(rollout('marker', separator)))),
    });
    assert.deepEqual(view(marked), view(plain));
    assert.equal(marked.sessions.length, 1);
  });
}

test('a separator in the first records does not cost the session its header or project', async () => {
  // The header is read on its own, from the first records only.
  const [meta, ...rest] = rollout('marker', '\u2028');
  const result = await parseRollouts({ 'rollout-a.jsonl': jsonl([meta, ...rest]) });
  assert.equal(result.buckets[0].project, 'proj');
  assert.deepEqual(result.warnings || [], []);
});

test('a record cut at a chunk boundary still parses (multi-byte text included)', async () => {
  // Large enough to cross the stream's 64 KiB chunk size several times.
  const filler = '压缩后的对话 ✓\u2028'.repeat(9000);
  const records = [
    sessionMeta(T0, 'lines-2'),
    { type: 'turn_context', timestamp: T0, payload: { model: 'gpt-5.2' } },
    agentMessage('2026-07-10T08:01:00.000Z', filler),
    tokenCount('2026-07-10T08:35:00.000Z', usage(300, 0, 30, 0), 330),
  ];
  const result = await parseRollouts({ 'rollout-a.jsonl': jsonl(records) });
  assert.equal(result.buckets.reduce((sum, bucket) => sum + bucket.inputTokens, 0), 300);
  assert.equal(result.sessions.length, 1);
  assert.deepEqual(result.warnings || [], []);
});
