import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { parse, splitZstdFrames } from '../src/parsers/dsh.js';
import { parsers } from '../src/parsers/index.js';
import { detectInstalledTools, getDshHome, TOOLS } from '../src/tools.js';

const hasBuiltinZstd = typeof zlib.zstdDecompressSync === 'function';

// DSH session logs are many small zstd frames concatenated. Node's zstd one-
// shot API decodes exactly one frame, so fixtures compress record-by-record.
function zstdFrames(records) {
  const frames = [];
  for (const record of records) {
    frames.push(zlib.zstdCompressSync(Buffer.from(JSON.stringify(record) + '\n')));
  }
  return Buffer.concat(frames);
}

function sessionRecord(id, cwd, version = 0) {
  const header = { type: 'session', version, id, createdAt: 1700000000000, delegationDepth: 0 };
  if (cwd !== undefined) header.cwd = cwd;
  return header;
}

function endSeedRecord() {
  return { type: 'session/end-seed', seq: 900, time: 1700000000000, data: {} };
}

function userRecord(time, kind = 'user') {
  return { type: 'user/message', seq: 1, time, data: { source: { kind } } };
}

function assistantRecord(time, model, usage) {
  return {
    type: 'assistant/message',
    seq: 2,
    time,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model } },
      usage,
    },
  };
}

function writeSession(root, projectKey, sessionId, records, plain = false) {
  const dir = join(root, projectKey, sessionId);
  mkdirSync(dir, { recursive: true });
  const name = plain ? 'session.jsonl' : 'session.jsonl.zstd';
  const payload = plain
    ? Buffer.from(records.map((record) => JSON.stringify(record) + '\n').join(''))
    : zstdFrames(records);
  writeFileSync(join(dir, name), payload);
  return dir;
}

async function withDshSessions(run) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-dsh-test-'));
  const sessions = join(root, 'sessions');
  const previous = process.env.VIBE_USAGE_DSH_SESSIONS;
  process.env.VIBE_USAGE_DSH_SESSIONS = sessions;
  try {
    return await run(sessions);
  } finally {
    if (previous === undefined) delete process.env.VIBE_USAGE_DSH_SESSIONS;
    else process.env.VIBE_USAGE_DSH_SESSIONS = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test('DSH is registered as a parser and detected tool', () => {
  assert.equal(typeof parsers.dsh, 'function');
  const tool = TOOLS.find((entry) => entry.id === 'dsh');
  assert.equal(tool?.name, 'DeepSeek Harness');
  assert.ok(tool?.dataDir.endsWith(join('.dsh', 'sessions')));
});

test('getDshHome honors DSH_HOME, tilde prefixes, and the default', () => {
  assert.equal(getDshHome({ DSH_HOME: '/custom/dsh' }), '/custom/dsh');
  assert.equal(getDshHome({ DSH_HOME: '~' }), join(homedir()));
  assert.equal(getDshHome({ DSH_HOME: '~/data' }), join(homedir(), 'data'));
  assert.equal(getDshHome({}), join(homedir(), '.dsh'));
});

test('tool detection follows the sessions fixture override', async () => {
  await withDshSessions(async (sessions) => {
    mkdirSync(sessions);
    assert.equal(detectInstalledTools().some((tool) => tool.id === 'dsh'), true);
  });
});

test('splitZstdFrames walks a multi-frame buffer and ignores a torn tail', () => {
  // Two concatenated zstd frames (session header + user message) plus a
  // 7-byte non-frame tail, embedded so the splitter is testable on Node 20
  // where zlib zstd does not exist.
  const buffer = Buffer.from(
    'KLUv/QRYVQEAFAJ7InR5cGUiOiJzZXNzaW9uIiwidmVyOjAsImlkLXgifQoCAD63aFua9+P91Ci1L/0EWNEBAHsidHlwZSI6InVzZXIvbWVzc2FnZSIsImRhdGEiOnsic291cmNlIjp7ImtpbmQiOiJ1c2VyIn19fQqIx3MQR0FSQkFHRQ==',
    'base64',
  );
  const ends = splitZstdFrames(buffer);
  assert.equal(ends.length, 2);
  assert.ok(ends[0] > 0 && ends[1] > ends[0]);
  assert.ok(ends[1] < buffer.length); // GARBAGE tail stays outside the frames
  if (hasBuiltinZstd) {
    const text = Buffer.concat(
      ends.map((end, i) => zlib.zstdDecompressSync(buffer.subarray(i === 0 ? 0 : ends[i - 1], end))),
    ).toString('utf8');
    assert.match(text, /"type":"session"/);
    assert.match(text, /"type":"user\/message"/);
  }
});

test('DSH buckets map uncached input, cache reads, and split reasoning from output', { skip: !hasBuiltinZstd }, async () => {
  await withDshSessions(async (sessions) => {
    writeSession(sessions, 'proj-a', 'session-1', [
      sessionRecord('session-1', '/home/me/proj-a'),
      userRecord(1700000100000),
      assistantRecord(1700000120000, 'deepseek-v4-pro', {
        inputTokens: 100, outputTokens: 30, cacheReadTokens: 400, reasoningTokens: 10,
      }),
      assistantRecord(1700000130000, 'deepseek-v4-pro', {
        inputTokens: 50, outputTokens: 15, cacheReadTokens: 0, reasoningTokens: 5,
      }),
    ]);

    const result = await parse();
    assert.equal(result.skipped, undefined);
    assert.deepEqual(result.buckets, [
      {
        source: 'dsh',
        model: 'deepseek-v4-pro',
        project: 'proj-a',
        bucketStart: '2023-11-14T22:00:00.000Z',
        inputTokens: 150,
        outputTokens: 30,
        cachedInputTokens: 400,
        reasoningOutputTokens: 15,
        totalTokens: 195,
      },
    ]);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].project, 'proj-a');
    assert.equal(result.sessions[0].messageCount, 3);
    assert.equal(result.sessions[0].userMessageCount, 1);
  });
});

test('DSH buckets split across half-hour windows and models', { skip: !hasBuiltinZstd }, async () => {
  await withDshSessions(async (sessions) => {
    writeSession(sessions, 'proj-b', 'session-2', [
      sessionRecord('session-2', '/home/me/proj-b'),
      userRecord(1700000100000),
      assistantRecord(1700000120000, 'model-one', { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, reasoningTokens: 0 }),
      assistantRecord(1700002800000, 'model-two', { inputTokens: 20, outputTokens: 4, cacheReadTokens: 1, reasoningTokens: 1 }),
      assistantRecord(1700000190000, undefined, { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, reasoningTokens: 0 }),
    ]);

    const result = await parse();
    const buckets = result.buckets.sort((a, b) => (a.bucketStart + a.model).localeCompare(b.bucketStart + b.model));
    assert.deepEqual(
      buckets.map((bucket) => [bucket.model, bucket.bucketStart, bucket.inputTokens, bucket.outputTokens]),
      [
        ['model-one', '2023-11-14T22:00:00.000Z', 10, 2],
        ['unknown', '2023-11-14T22:00:00.000Z', 7, 3],
        ['model-two', '2023-11-14T23:00:00.000Z', 20, 3],
      ],
    );
  });
});

test('DSH skips the seed replay before the last session/end-seed marker', { skip: !hasBuiltinZstd }, async () => {
  await withDshSessions(async (sessions) => {
    writeSession(sessions, 'proj-c', 'session-3', [
      sessionRecord('session-3', '/home/me/proj-c'),
      userRecord(1699990000000),
      assistantRecord(1699990010000, 'model-a', { inputTokens: 999, outputTokens: 99, cacheReadTokens: 9999, reasoningTokens: 9 }),
      endSeedRecord(),
      endSeedRecord(), // only the LAST marker matters; the first is inside the replay
      userRecord(1700000100000),
      assistantRecord(1700000120000, 'model-a', { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, reasoningTokens: 1 }),
    ]);

    const result = await parse();
    assert.deepEqual(
      result.buckets.map((bucket) => bucket.inputTokens),
      [10],
    );
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].messageCount, 2);
    assert.equal(result.sessions[0].userMessageCount, 1);
    assert.equal(result.sessions[0].firstMessageAt, '2023-11-14T22:15:00.000Z');
  });
});

test('DSH ignores plugin-sourced user messages and assistant-only sessions', { skip: !hasBuiltinZstd }, async () => {
  await withDshSessions(async (sessions) => {
    writeSession(sessions, 'proj-d', 'session-4', [
      sessionRecord('session-4', '/home/me/proj-d'),
      userRecord(1700000000000, 'plugin'),
      assistantRecord(1700000010000, 'model-a', { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0 }),
    ]);

    const result = await parse();
    assert.equal(result.buckets.length, 1);
    assert.deepEqual(result.sessions, []);
  });
});

test('DSH reads plain .jsonl session logs as well', { skip: !hasBuiltinZstd }, async () => {
  await withDshSessions(async (sessions) => {
    writeSession(sessions, 'proj-e', 'session-5', [
      sessionRecord('session-5', '/home/me/proj-e'),
      userRecord(1700000100000),
      assistantRecord(1700000120000, 'model-a', { inputTokens: 8, outputTokens: 2, cacheReadTokens: 0, reasoningTokens: 0 }),
    ], true);

    const result = await parse();
    assert.equal(result.skipped, undefined);
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0].inputTokens, 8);
  });
});

test('DSH deduplicates a session id across project dirs by keeping the larger copy', { skip: !hasBuiltinZstd }, async () => {
  await withDshSessions(async (sessions) => {
    writeSession(sessions, 'proj-old', 'session-6', [
      sessionRecord('session-6', '/home/me/proj-old'),
      userRecord(1700000100000),
      assistantRecord(1700000120000, 'model-a', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0 }),
    ]);
    writeSession(sessions, 'proj-new', 'session-6', [
      sessionRecord('session-6', '/home/me/proj-new'),
      userRecord(1700000100000),
      assistantRecord(1700000120000, 'model-a', { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, reasoningTokens: 2 }),
      assistantRecord(1700000130000, 'model-a', { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, reasoningTokens: 2 }),
    ]);

    const result = await parse();
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0].inputTokens, 200);
    assert.equal(result.buckets[0].project, 'proj-new');
    assert.equal(result.sessions.length, 1);
  });
});

test('DSH returns empty when the sessions directory is missing', async () => {
  await withDshSessions(async () => {
    assert.deepEqual(await parse(), { buckets: [], sessions: [] });
  });
});

test('DSH skips corrupt files and protects prior state', { skip: !hasBuiltinZstd }, async () => {
  await withDshSessions(async (sessions) => {
    writeSession(sessions, 'proj-f', 'session-7', [
      sessionRecord('session-7', '/home/me/proj-f'),
      userRecord(1700000100000),
      assistantRecord(1700000120000, 'model-a', { inputTokens: 11, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0 }),
    ]);
    // A second, corrupt session file must not take down the parse or prune state.
    const dir = join(sessions, 'proj-f', 'session-8');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xff, 0xff, 0xff]));

    const result = await parse();
    assert.equal(result.skipped, true);
    assert.equal(result.buckets.length, 1);
    assert.ok(result.warnings.some((warning) => warning.includes('session-8')));
  });
});

test('DSH skips logs with an unknown session format version', { skip: !hasBuiltinZstd }, async () => {
  await withDshSessions(async (sessions) => {
    writeSession(sessions, 'proj-g', 'session-9', [
      sessionRecord('session-9', '/home/me/proj-g', 1),
      userRecord(1700000100000),
      assistantRecord(1700000120000, 'model-a', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0 }),
    ]);

    const result = await parse();
    assert.equal(result.skipped, true);
    assert.deepEqual(result.buckets, []);
    assert.ok(result.warnings.some((warning) => /format version 1/.test(warning)));
  });
});
