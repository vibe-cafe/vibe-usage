import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import zlib from 'node:zlib';
import { parse } from '../src/parsers/codex.js';
import { codexCacheDir } from '../src/parsers/codex-cache.js';
import { ZstdDecodeError, zstdFileChunks, zstdFrames } from '../src/parsers/zstd-file.js';
import { countWarningCodes } from '../src/warning-codes.js';

// Codex Desktop compresses rollouts untouched for 7 days to `.jsonl.zst`
// (openai/codex codex-rs/rollout/src/compression.rs). Every fixture here is
// synthetic; compressed ones are made with node:zlib, which has zstd from
// Node 22.15 on, so those cases skip on older runtimes.

const previousCindyDirs = process.env.VIBE_USAGE_CINDY_DIRS;
process.env.VIBE_USAGE_CINDY_DIRS = join(tmpdir(), 'vibe-usage-cindy-disabled');
test.after(() => {
  if (previousCindyDirs === undefined) delete process.env.VIBE_USAGE_CINDY_DIRS;
  else process.env.VIBE_USAGE_CINDY_DIRS = previousCindyDirs;
});

const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function';
const needsZstd = HAS_ZSTD ? {} : { skip: 'node:zlib has no zstd before Node 22.15' };

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

function tokenCount(timestamp, last, cumulativeTotal) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { model: 'gpt-5.2', total_token_usage: { total_tokens: cumulativeTotal }, last_token_usage: last },
    },
  };
}

function taskStarted(timestamp, startedAt) {
  return { timestamp, type: 'event_msg', payload: { type: 'task_started', started_at: startedAt } };
}

function jsonl(records) {
  return `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
}

/** zstd as Codex writes it: one frame, or `frames` frames cut at arbitrary bytes. */
function zst(text, { frames = 1, skippableAfterFirst = false } = {}) {
  const bytes = Buffer.from(text);
  const parts = [];
  for (let i = 0; i < frames; i++) {
    const start = Math.floor((bytes.length * i) / frames);
    const end = Math.floor((bytes.length * (i + 1)) / frames);
    parts.push(zlib.zstdCompressSync(bytes.subarray(start, end)));
    if (i === 0 && skippableAfterFirst) parts.push(skippableFrame(Buffer.from('not data')));
  }
  return Buffer.concat(parts);
}

function skippableFrame(payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0x184d2a5e, 0);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

const DAY_DIR = join('sessions', '2026', '07', '10');

function writeRollouts(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name.includes('/') ? name : join(DAY_DIR, name));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
}

async function withCodexHome(fn) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codex-zst-'));
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
    buckets: [...result.buckets].sort((a, b) => `${a.bucketStart}${a.model}`.localeCompare(`${b.bucketStart}${b.model}`)),
    sessions: [...result.sessions].sort((a, b) => a.sessionHash.localeCompare(b.sessionHash)),
  };
}

function totalInput(result) {
  return result.buckets.reduce((sum, bucket) => sum + bucket.inputTokens, 0);
}

const T0 = '2026-07-10T08:00:00.000Z';
const ordinary = [
  sessionMeta(T0, 'ordinary-1'),
  { type: 'turn_context', timestamp: T0, payload: { model: 'gpt-5.2', service_tier: 'priority' } },
  tokenCount('2026-07-10T08:05:00.000Z', usage(100, 40, 10, 2), 110),
  tokenCount('2026-07-10T08:40:00.000Z', usage(200, 50, 20, 5), 330),
  // Multi-byte text inside a record must survive frame and chunk boundaries.
  { timestamp: '2026-07-10T08:41:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: '压缩后的对话 ✓'.repeat(500) } },
  tokenCount('2026-07-10T09:10:00.000Z', usage(300, 0, 30, 0), 660),
];

test('a compressed rollout counts exactly like the plain file it was', needsZstd, async () => {
  const plain = await parseRollouts({ 'rollout-a.jsonl': jsonl(ordinary) });
  const compressed = await parseRollouts({ 'rollout-a.jsonl.zst': zst(jsonl(ordinary)) });
  assert.equal(totalInput(plain), 510);
  assert.deepEqual(view(compressed), view(plain));
  assert.equal(compressed.skipped, undefined);
  assert.deepEqual(compressed.warnings || [], []);
});

test('every frame of a multi-frame file is read, across a skippable frame', needsZstd, async () => {
  // Node 22's decoder stops after the first frame without an error; the
  // frames are located and decoded one by one instead.
  const data = zst(jsonl(ordinary), { frames: 3, skippableAfterFirst: true });
  const plain = await parseRollouts({ 'rollout-a.jsonl': jsonl(ordinary) });
  const compressed = await parseRollouts({ 'rollout-a.jsonl.zst': data });
  assert.deepEqual(view(compressed), view(plain));

  const dir = mkdtempSync(join(tmpdir(), 'vibe-usage-zst-frames-'));
  try {
    const path = join(dir, 'x.jsonl.zst');
    writeFileSync(path, data);
    assert.equal(zstdFrames(path, data.length).length, 3);
    const counter = { bytes: 0 };
    const chunks = [];
    for await (const chunk of zstdFileChunks(path, data.length, counter)) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), jsonl(ordinary));
    assert.equal(counter.bytes, Buffer.byteLength(jsonl(ordinary)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a plain rollout wins over its compressed sibling and is counted once', needsZstd, async () => {
  // Codex publishes the new form before deleting the old one, in both
  // directions, and reads the plain file when both exist. A restored plain
  // file may already have records appended.
  const appended = [...ordinary, tokenCount('2026-07-10T09:20:00.000Z', usage(7, 0, 1, 0), 668)];
  const plainOnly = await parseRollouts({ 'rollout-a.jsonl': jsonl(appended) });
  const both = await parseRollouts({
    'rollout-a.jsonl': jsonl(appended),
    'rollout-a.jsonl.zst': zst(jsonl(ordinary)),
  });
  assert.equal(totalInput(plainOnly), 517);
  assert.deepEqual(view(both), view(plainOnly));

  const identical = await parseRollouts({
    'rollout-a.jsonl': jsonl(ordinary),
    'rollout-a.jsonl.zst': zst(jsonl(ordinary)),
  });
  assert.equal(totalInput(identical), 510);
  assert.equal(identical.sessions.length, 1);
});

// A fork and a sub-agent both replay the parent's history at the top of their
// own rollout. Without the parent the copies count again; the parent is
// typically the older conversation, i.e. the one Codex has compressed.
const PARENT_START = '2026-07-10T08:00:00.000Z';
const parentRecords = [
  sessionMeta(PARENT_START, 'parent-1'),
  tokenCount('2026-07-10T08:05:00.000Z', usage(1000, 0, 10, 0), 1010),
  tokenCount('2026-07-10T08:20:00.000Z', usage(2000, 0, 20, 0), 3030),
];
const FORK_START = '2026-07-17T09:00:00.000Z';
const forkRecords = [
  sessionMeta(FORK_START, 'fork-1', { forked_from_id: 'parent-1' }),
  { ...parentRecords[1], timestamp: FORK_START },
  { ...parentRecords[2], timestamp: FORK_START },
  tokenCount('2026-07-17T09:01:00.000Z', usage(5, 0, 1, 0), 3036),
];
const SUBAGENT_START = '2026-07-17T10:00:00.000Z';
const subagentRecords = [
  sessionMeta(SUBAGENT_START, 'sub-1', { thread_source: 'subagent', parent_thread_id: 'parent-1' }),
  sessionMeta(PARENT_START, 'parent-1'),
  { ...parentRecords[1], timestamp: SUBAGENT_START },
  { ...parentRecords[2], timestamp: SUBAGENT_START },
  taskStarted(SUBAGENT_START, Date.parse(SUBAGENT_START) / 1000),
  tokenCount('2026-07-17T10:01:00.000Z', usage(7, 0, 1, 0), 3044),
];

test('forks and sub-agents of a compressed parent skip the copied history', needsZstd, async () => {
  const children = { 'rollout-fork.jsonl': jsonl(forkRecords), 'rollout-sub.jsonl': jsonl(subagentRecords) };
  const allPlain = await parseRollouts({ 'rollout-parent.jsonl': jsonl(parentRecords), ...children });
  const parentCompressed = await parseRollouts({ 'rollout-parent.jsonl.zst': zst(jsonl(parentRecords)), ...children });
  const allCompressed = await parseRollouts({
    'rollout-parent.jsonl.zst': zst(jsonl(parentRecords)),
    'rollout-fork.jsonl.zst': zst(jsonl(forkRecords)),
    'rollout-sub.jsonl.zst': zst(jsonl(subagentRecords)),
  });
  const parentInvisible = await parseRollouts(children);

  const forkWindow = result => totalInput({
    buckets: result.buckets.filter(bucket => Date.parse(bucket.bucketStart) === Date.parse('2026-07-17T09:00:00.000Z')),
  });
  assert.equal(totalInput(allPlain), 3000 + 5 + 7);
  assert.equal(forkWindow(allPlain), 5);
  assert.deepEqual(view(parentCompressed), view(allPlain));
  assert.deepEqual(view(allCompressed), view(allPlain));
  // What every earlier release uploaded once the parent was compressed: the
  // parent's history again, in the fork's window, on top of what the server
  // already holds from when the parent was a plain file.
  assert.equal(forkWindow(parentInvisible), 3000 + 5);
});

test('continuation segments mixing plain and compressed files merge as before', needsZstd, async () => {
  const t = '2026-09-06T00:00:00.000Z';
  const header = [sessionMeta(t, 'segments'), { type: 'turn_context', timestamp: t, payload: { model: 'test-model' } }];
  const records = [
    tokenCount('2026-09-06T00:01:00.000Z', usage(10, 0, 0, 0), 10),
    tokenCount('2026-09-06T00:02:00.000Z', usage(10, 0, 0, 0), 20),
    tokenCount('2026-09-06T00:03:00.000Z', usage(10, 0, 0, 0), 30),
  ];
  const a = jsonl([...header, ...records.slice(0, 2)]);
  const b = jsonl([...header, records[2]]);
  const plain = await parseRollouts({ 'a.jsonl': a, 'b.jsonl': b });
  const mixed = await parseRollouts({ 'a.jsonl.zst': zst(a), 'b.jsonl': b });
  // The same session archived compressed while a live plain copy remains.
  const archived = await parseRollouts({ 'a.jsonl': a, 'archived_sessions/a.jsonl.zst': zst(a), 'b.jsonl': b });
  assert.equal(totalInput(plain), 30);
  assert.equal(plain.sessions.length, 1);
  assert.deepEqual(view(mixed), view(plain));
  assert.deepEqual(view(archived), view(plain));
});

function damaged() {
  const good = zst(jsonl(ordinary));
  const garbageBlock = Buffer.from(good);
  // Keep the frame structure, scramble the compressed payload.
  for (let i = 12; i < garbageBlock.length - 4; i++) garbageBlock[i] = (i * 151 + 7) & 0xff;
  return {
    truncated: good.subarray(0, good.length - 9),
    trailingGarbage: Buffer.concat([good, Buffer.from('not a zstd frame')]),
    scrambled: garbageBlock,
    empty: Buffer.from([0x28, 0xb5, 0x2f]),
  };
}

test('a compressed rollout that cannot be decoded skips Codex instead of uploading part of it', needsZstd, async () => {
  for (const [kind, bytes] of Object.entries(damaged())) {
    const result = await parseRollouts({
      'rollout-good.jsonl': jsonl(parentRecords),
      'rollout-bad.jsonl.zst': bytes,
    });
    assert.equal(result.skipped, true, kind);
    assert.deepEqual(result.buckets, [], kind);
    assert.deepEqual(result.sessions, [], kind);
    assert.equal(result.warnings.length, 1, kind);
    assert.match(result.warnings[0], /压缩记录解压失败.*rollout-bad\.jsonl\.zst/, kind);
    assert.deepEqual(countWarningCodes(result.warnings), { unsupported_format: 1 }, kind);
  }
});

/** A valid frame whose header declares one byte more than it holds. */
function wrongSizeFrame(text) {
  const frame = Buffer.from(zlib.zstdCompressSync(Buffer.from(text)));
  const descriptor = frame[4];
  assert.ok(descriptor & 0x20, 'one-shot compression writes a single-segment frame with its size');
  const sizeBytes = descriptor >>> 6 === 0 ? 1 : 1 << (descriptor >>> 6);
  if (sizeBytes === 2) frame.writeUInt16LE(frame.readUInt16LE(5) + 1, 5);
  else if (sizeBytes === 4) frame.writeUInt32LE(frame.readUInt32LE(5) + 1, 5);
  else frame[5] += 1;
  return frame;
}

test('damage found after the header skips Codex in the index and usage passes too', needsZstd, async () => {
  // Every frame is well formed, so the header pass reads the first records
  // and stops; the second frame fails only when the whole file is read: by the
  // replay index (a fork's parent, a duplicate session id) or the usage pass.
  const [meta, ...rest] = parentRecords;
  const padding = { timestamp: PARENT_START, type: 'event_msg', payload: { type: 'agent_message', message: 'p'.repeat(2 * 1024 * 1024) } };
  const lateDamage = Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(jsonl([meta, padding]))),
    wrongSizeFrame(jsonl(rest)),
  ]);
  for (const [pass, files] of [
    ['index (parent)', { 'rollout-parent.jsonl.zst': lateDamage, 'rollout-fork.jsonl': jsonl(forkRecords) }],
    ['index (duplicate id)', { 'rollout-parent.jsonl.zst': lateDamage, 'archived_sessions/rollout-parent.jsonl': jsonl(parentRecords) }],
    ['usage', { 'rollout-only.jsonl.zst': lateDamage }],
  ]) {
    const result = await parseRollouts(files);
    assert.equal(result.skipped, true, pass);
    assert.deepEqual(result.buckets, [], pass);
    assert.equal(result.cache.headerHits + result.cache.filesRead > 0, true, pass);
    assert.deepEqual(countWarningCodes(result.warnings), { unsupported_format: 1 }, pass);
  }
});

test('frame and size checks reject what Node 22 would decode silently', needsZstd, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-usage-zst-checks-'));
  const read = async (bytes) => {
    const path = join(dir, `f-${Math.random().toString(36).slice(2)}.jsonl.zst`);
    writeFileSync(path, bytes);
    const chunks = [];
    for await (const chunk of zstdFileChunks(path, bytes.length)) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  try {
    const text = jsonl(ordinary);
    const frame = zlib.zstdCompressSync(Buffer.from(text));
    assert.equal((await read(frame)).toString(), text);
    // A truncated frame: Node 22 returns its complete blocks without an error.
    await assert.rejects(read(frame.subarray(0, frame.length - 3)), ZstdDecodeError);
    // A second frame cut short.
    await assert.rejects(read(Buffer.concat([frame, frame.subarray(0, 20)])), ZstdDecodeError);
    // A declared content size the data does not match.
    await assert.rejects(read(wrongSizeFrame(text)), ZstdDecodeError);
    await assert.rejects(read(Buffer.from('plain text, not zstd')), ZstdDecodeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a zstd decoder compressed rollouts stay unread, are reported, and the rest syncs', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(zlib, 'createZstdDecompress');
  if (descriptor) Object.defineProperty(zlib, 'createZstdDecompress', { ...descriptor, value: undefined });
  try {
    const result = await parseRollouts({
      'rollout-plain.jsonl': jsonl(parentRecords),
      // Never opened when there is no decoder, so any bytes do.
      'rollout-old-1.jsonl.zst': HAS_ZSTD ? zst(jsonl(ordinary)) : Buffer.from('x'),
      'rollout-old-2.jsonl.zst': HAS_ZSTD ? zst(jsonl(ordinary)) : Buffer.from('x'),
    });
    assert.equal(result.skipped, undefined);
    assert.equal(totalInput(result), 3000);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /2 个压缩的旧对话/);
    assert.deepEqual(countWarningCodes(result.warnings), { decoder_unavailable: 1 });
  } finally {
    if (descriptor) Object.defineProperty(zlib, 'createZstdDecompress', descriptor);
  }
});

test('compressed rollouts are cached as whole files and follow compression and restore', needsZstd, async () => {
  await withCodexHome(async root => {
    const dir = join(root, DAY_DIR);
    const plainPath = join(dir, 'rollout-a.jsonl');
    const zstPath = `${plainPath}.zst`;
    const cache = codexCacheDir(root);

    writeRollouts(root, { 'rollout-a.jsonl': jsonl(ordinary) });
    const asPlain = await parse();

    // Codex compresses the cold file: the summary is rebuilt once, from the
    // compressed bytes, and never as an append tail.
    rmSync(plainPath);
    writeFileSync(zstPath, zst(jsonl(ordinary)));
    const cold = await parse();
    assert.deepEqual(view(cold), view(asPlain));
    assert.equal(cold.cache.filesRead, 2); // header + usage pass of the compressed file
    const warm = await parse();
    assert.deepEqual(view(warm), view(asPlain));
    assert.equal(warm.cache.filesRead, 0);
    assert.equal(warm.cache.resultHits, 1);
    assert.equal(readdirSync(cache).filter(name => name.endsWith('.tail.json')).length, 1,
      'only the plain file ever had an append tail');

    // Reopening the conversation restores the plain file and appends to it.
    rmSync(zstPath);
    const appended = [...ordinary, tokenCount('2026-07-10T09:20:00.000Z', usage(7, 0, 1, 0), 668)];
    writeFileSync(plainPath, jsonl(appended));
    const restored = await parse();
    assert.equal(totalInput(restored), 517);
    assert.deepEqual(restored.sessions.map(s => s.sessionHash), asPlain.sessions.map(s => s.sessionHash));
  });
});

test('a compressed rollout without a session id keeps the session identity of its plain path', needsZstd, async () => {
  const records = [
    { timestamp: T0, type: 'turn_context', payload: { model: 'gpt-5.2' } },
    tokenCount('2026-07-10T08:05:00.000Z', usage(100, 0, 10, 0), 110),
  ];
  await withCodexHome(async root => {
    const plainPath = join(root, DAY_DIR, 'rollout-noid.jsonl');
    writeRollouts(root, { 'rollout-noid.jsonl': jsonl(records) });
    const plain = await parse();
    rmSync(plainPath);
    writeFileSync(`${plainPath}.zst`, zst(jsonl(records)));
    const compressed = await parse();
    assert.equal(plain.sessions.length, 1);
    assert.deepEqual(view(compressed), view(plain));
  });
});

test('the rolling audit is bounded by a compressed rollout\'s text, not its file size', needsZstd, async () => {
  await withCodexHome(async root => {
    const text = jsonl(ordinary);
    writeRollouts(root, { 'rollout-a.jsonl.zst': zst(text) });
    const saved = {
      interval: process.env.VIBE_USAGE_CODEX_AUDIT_INTERVAL_MS,
      max: process.env.VIBE_USAGE_CODEX_AUDIT_MAX_BYTES,
    };
    try {
      await parse();
      process.env.VIBE_USAGE_CODEX_AUDIT_INTERVAL_MS = '0';
      // Larger than the compressed file, smaller than its text: not audited.
      process.env.VIBE_USAGE_CODEX_AUDIT_MAX_BYTES = String(Buffer.byteLength(text) - 1);
      assert.equal((await parse()).cache.audited, 0);
      process.env.VIBE_USAGE_CODEX_AUDIT_MAX_BYTES = String(Buffer.byteLength(text));
      const audited = await parse();
      assert.equal(audited.cache.audited, 1);
      assert.equal(totalInput(audited), 510);
    } finally {
      for (const [key, value] of [['VIBE_USAGE_CODEX_AUDIT_INTERVAL_MS', saved.interval], ['VIBE_USAGE_CODEX_AUDIT_MAX_BYTES', saved.max]]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
