import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

function sessionRecord(id, cwd, version = 0, extra = {}) {
  const header = { type: 'session', version, id, createdAt: 1700000000000, delegationDepth: 0, ...extra };
  if (cwd !== undefined) header.cwd = cwd;
  return header;
}

function withSeq(records, start = 0) {
  return records.map((record, index) => ({ ...record, seq: start + index }));
}

function endSeedRecord(seq = 900) {
  return { type: 'session/end-seed', seq, time: 1700000000000, data: {} };
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

function writeSession(root, projectKey, sessionId, records, plain = false, version = 0) {
  const dir = join(root, projectKey, sessionId);
  mkdirSync(dir, { recursive: true });
  const name = `session${version === 0 ? '' : `.v${version}`}.jsonl${plain ? '' : '.zstd'}`;
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
  // resolve() normalizes the drive-root form on Windows (D:\custom\dsh).
  assert.equal(getDshHome({ DSH_HOME: '/custom/dsh' }), resolve('/custom/dsh'));
  assert.equal(getDshHome({ DSH_HOME: '~' }), join(homedir()));
  assert.equal(getDshHome({ DSH_HOME: '~/data' }), join(homedir(), 'data'));
  assert.equal(getDshHome({ DSH_HOME: 'relative-dsh' }), resolve('relative-dsh'));
  assert.equal(getDshHome({}), join(homedir(), '.dsh'));
});

test('tool detection follows the sessions fixture override', async () => {
  await withDshSessions(async (sessions) => {
    mkdirSync(sessions);
    assert.equal(detectInstalledTools().some((tool) => tool.id === 'dsh'), true);
  });
});

test('splitZstdFrames walks complete frames and ignores only an incomplete tail', () => {
  // Two concatenated zstd frames (session header + user message), embedded so
  // the scanner is testable on Node 20 where node:zlib zstd does not exist.
  const encoded = Buffer.from(
    'KLUv/QRYVQEAFAJ7InR5cGUiOiJzZXNzaW9uIiwidmVyOjAsImlkLXgifQoCAD63aFua9+P91Ci1L/0EWNEBAHsidHlwZSI6InVzZXIvbWVzc2FnZSIsImRhdGEiOnsic291cmNlIjp7ImtpbmQiOiJ1c2VyIn19fQqIx3MQR0FSQkFHRQ==',
    'base64',
  );
  const complete = encoded.subarray(0, -7); // strip the embedded "GARBAGE"
  const buffer = Buffer.concat([complete, complete.subarray(0, 2)]);
  const frames = splitZstdFrames(buffer);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].start, 0);
  assert.equal(frames[0].end, frames[1].start);
  assert.equal(frames[1].end, complete.length);
  assert.throws(
    () => splitZstdFrames(Buffer.concat([complete, Buffer.from('GARB')])),
    /invalid Zstandard frame magic/,
  );
  if (hasBuiltinZstd) {
    const text = Buffer.concat(
      frames.map(({ start, end }) => zlib.zstdDecompressSync(buffer.subarray(start, end))),
    ).toString('utf8');
    assert.match(text, /"type":"session"/);
    assert.match(text, /"type":"user\/message"/);
  }
});

test('splitZstdFrames handles RLE blocks and preserves frames around skippable data', () => {
  // A valid single-segment frame whose sole block expands one "A" byte to five.
  const rleFrame = Buffer.from('28b52ffd20052b000041', 'hex');
  const skippable = Buffer.alloc(11);
  skippable.writeUInt32LE(0x184d2a50, 0);
  skippable.writeUInt32LE(3, 4);
  skippable.fill(0x7a, 8);

  const buffer = Buffer.concat([rleFrame, skippable, rleFrame]);
  const frames = splitZstdFrames(buffer);
  assert.deepEqual(frames, [
    { start: 0, end: 10 },
    { start: 21, end: 31 },
  ]);
  if (hasBuiltinZstd) {
    assert.deepEqual(
      frames.map(({ start, end }) =>
        zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
      ),
      ['AAAAA', 'AAAAA'],
    );
  }
});

test('DSH buckets map uncached input, cache reads, and split reasoning from output', { skip: !hasBuiltinZstd }, async () => {
  await withDshSessions(async (sessions) => {
    writeSession(sessions, 'proj-a', 'session-1', [
      sessionRecord('session-1', '/home/me/proj-a'),
      userRecord(1700000100000),
      assistantRecord(1700000120000, 'deepseek-v4-pro', {
        inputTokens: 100, outputTokens: 30, cacheReadTokens: 400,
        cacheWriteTokens: 20, reasoningTokens: 10,
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
        inputTokens: 170,
        outputTokens: 30,
        cachedInputTokens: 400,
        reasoningOutputTokens: 15,
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
        totalTokens: 215,
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

test('DSH counts all records of a session without a parent, regardless of end-seed markers', { skip: !hasBuiltinZstd }, async () => {
  // Regression: DSH (dev preview) appends session/end-seed at resume boundaries
  // and at the END of a file when the session becomes a seed. Those markers are
  // NOT replay boundaries — a session without a parentSession has no replayed
  // history, so every record must be counted. The old "skip everything before
  // the last end-seed" rule discarded this file entirely.
  await withDshSessions(async (sessions) => {
    writeSession(sessions, 'proj-c', 'session-3', [
      sessionRecord('session-3', '/home/me/proj-c'),
      userRecord(1699990000000),
      assistantRecord(1699990010000, 'model-a', { inputTokens: 999, outputTokens: 99, cacheReadTokens: 9999, reasoningTokens: 9 }),
      endSeedRecord(),
      userRecord(1700000100000),
      assistantRecord(1700000120000, 'model-a', { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, reasoningTokens: 1 }),
      endSeedRecord(), // trailing marker (session became a seed) — must not skip anything
    ]);

    const result = await parse();
    assert.deepEqual(
      result.buckets.map((bucket) => bucket.inputTokens).sort((a, b) => a - b),
      [10, 999],
    );
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].messageCount, 4);
    assert.equal(result.sessions[0].userMessageCount, 2);
    assert.equal(result.sessions[0].firstMessageAt, '2023-11-14T19:26:40.000Z');
  });
});

test('DSH skips a fork seed using the header seedLength boundary', { skip: !hasBuiltinZstd }, async () => {
  await withDshSessions(async (sessions) => {
    const parentMessages = withSeq([
      userRecord(1700000100000),
      assistantRecord(1700000120000, 'model-a', { inputTokens: 111, outputTokens: 11, cacheReadTokens: 1111, reasoningTokens: 1 }),
      userRecord(1700000130000),
      assistantRecord(1700000140000, 'model-a', { inputTokens: 222, outputTokens: 22, cacheReadTokens: 2222, reasoningTokens: 2 }),
    ]);
    writeSession(sessions, 'proj-p', 'parent-1', [
      sessionRecord('parent-1', '/home/me/parent'),
      ...parentMessages,
    ]);

    const seedLength = parentMessages.length;
    writeSession(sessions, 'proj-c', 'child-1', [
      sessionRecord('child-1', '/home/me/child', 0, {
        parentSession: 'parent-1',
        seedLength,
        createdAt: 1700000200000,
      }),
      ...parentMessages,
      endSeedRecord(seedLength),
      ...withSeq([
        userRecord(1700000210000),
        assistantRecord(1700000230000, 'model-a', { inputTokens: 333, outputTokens: 33, cacheReadTokens: 0, reasoningTokens: 3 }),
      ], seedLength + 1),
    ]);

    const result = await parse();
    assert.deepEqual(
      result.buckets
        .filter((bucket) => bucket.project === 'child')
        .map((bucket) => [bucket.inputTokens, bucket.reasoningOutputTokens]),
      [[333, 3]],
    );
    const childSession = result.sessions.find((session) => session.project === 'child');
    assert.ok(childSession);
    assert.equal(childSession.messageCount, 2);
    assert.equal(childSession.userMessageCount, 1);
  });
});

test('DSH de-duplicates a fork seed before newer in-flight parent messages', { skip: !hasBuiltinZstd }, async () => {
  await withDshSessions(async (sessions) => {
    const completedMessages = withSeq([
      userRecord(1700000100000),
      assistantRecord(1700000120000, 'model-a', { inputTokens: 111, outputTokens: 11, cacheReadTokens: 0, reasoningTokens: 1 }),
      userRecord(1700000130000),
      assistantRecord(1700000140000, 'model-a', { inputTokens: 222, outputTokens: 22, cacheReadTokens: 0, reasoningTokens: 2 }),
    ]);
    const inFlightMessages = withSeq([
      userRecord(1700000150000),
      assistantRecord(1700000160000, 'model-a', { inputTokens: 444, outputTokens: 44, cacheReadTokens: 0, reasoningTokens: 4 }),
    ], completedMessages.length);
    writeSession(sessions, 'proj-p', 'parent-2', [
      sessionRecord('parent-2', '/home/me/parent'),
      ...completedMessages,
      ...inFlightMessages,
    ]);

    const seedLength = completedMessages.length;
    writeSession(sessions, 'proj-c', 'child-2', [
      sessionRecord('child-2', '/home/me/child', 0, {
        parentSession: 'parent-2',
        seedLength,
        createdAt: 1700000190000,
      }),
      ...completedMessages,
      endSeedRecord(seedLength),
      ...withSeq([
        userRecord(1700000200000),
        assistantRecord(1700000220000, 'model-a', { inputTokens: 555, outputTokens: 55, cacheReadTokens: 0, reasoningTokens: 5 }),
      ], seedLength + 1),
    ]);

    const result = await parse();
    assert.deepEqual(
      result.buckets.filter((bucket) => bucket.project === 'child').map((bucket) => bucket.inputTokens),
      [555],
    );
  });
});

test('DSH counts a subagent session in full when its content does not match the parent', { skip: !hasBuiltinZstd }, async () => {
  await withDshSessions(async (sessions) => {
    writeSession(sessions, 'proj-p', 'parent-3', [
      sessionRecord('parent-3', '/home/me/parent'),
      userRecord(1700000100000),
      assistantRecord(1700000120000, 'model-a', { inputTokens: 111, outputTokens: 11, cacheReadTokens: 0, reasoningTokens: 1 }),
    ]);
    // A subagent starts fresh: parentSession is set but no history is replayed.
    writeSession(sessions, 'proj-s', 'sub-1', [
      sessionRecord('sub-1', '/home/me/sub', 0, { parentSession: 'parent-3', createdAt: 1700000200000 }),
      userRecord(1700000210000),
      assistantRecord(1700000230000, 'model-b', { inputTokens: 222, outputTokens: 22, cacheReadTokens: 0, reasoningTokens: 2 }),
    ]);

    const result = await parse();
    // Parent's own turn (111) is counted from its own file; the subagent's
    // fresh content (222) matches nothing in the parent and counts in full.
    assert.deepEqual(
      result.buckets.filter((bucket) => bucket.project === 'sub').map((bucket) => bucket.inputTokens),
      [222],
    );
  });
});

test('DSH counts a fork seed in full when its parent is missing (fail open)', { skip: !hasBuiltinZstd }, async () => {
  await withDshSessions(async (sessions) => {
    const inheritedMessages = withSeq([
      userRecord(1700000210000),
      assistantRecord(1700000230000, 'model-a', { inputTokens: 777, outputTokens: 77, cacheReadTokens: 0, reasoningTokens: 7 }),
    ]);
    writeSession(sessions, 'proj-c', 'child-3', [
      sessionRecord('child-3', '/home/me/child', 0, {
        parentSession: 'ghost-parent',
        seedLength: inheritedMessages.length,
        createdAt: 1700000200000,
      }),
      ...inheritedMessages,
    ]);

    const result = await parse();
    assert.deepEqual(result.buckets.map((bucket) => bucket.inputTokens), [777]);
  });
});

test('DSH skips a one-turn fork seed without a heuristic minimum', { skip: !hasBuiltinZstd }, async () => {
  await withDshSessions(async (sessions) => {
    const parentMessages = withSeq([
      userRecord(1700000100000),
      assistantRecord(1700000120000, 'model-a', { inputTokens: 222, outputTokens: 22, cacheReadTokens: 0, reasoningTokens: 2 }),
    ]);
    writeSession(sessions, 'proj-p', 'parent-4', [
      sessionRecord('parent-4', '/home/me/parent'),
      ...parentMessages,
    ]);

    const seedLength = parentMessages.length;
    writeSession(sessions, 'proj-c', 'child-4', [
      sessionRecord('child-4', '/home/me/child', 0, {
        parentSession: 'parent-4',
        seedLength,
        createdAt: 1700000150000,
      }),
      ...parentMessages,
      endSeedRecord(seedLength),
      ...withSeq([
        userRecord(1700000160000),
        assistantRecord(1700000180000, 'model-a', { inputTokens: 333, outputTokens: 33, cacheReadTokens: 0, reasoningTokens: 3 }),
      ], seedLength + 1),
    ]);

    const result = await parse();
    assert.deepEqual(
      result.buckets.filter((bucket) => bucket.project === 'child').map((bucket) => bucket.inputTokens),
      [333],
    );
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

test('DSH reads plain .jsonl session logs as well', async () => {
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

test('DSH marks nested project read failures as skipped', { skip: process.platform === 'win32' }, async (t) => {
  await withDshSessions(async (sessions) => {
    writeSession(sessions, 'readable', 'session-readable', [
      sessionRecord('session-readable', '/home/me/readable'),
      userRecord(1700000100000),
      assistantRecord(1700000120000, 'model-a', {
        inputTokens: 11, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0,
      }),
    ], true);

    const blocked = join(sessions, 'blocked');
    mkdirSync(blocked, { recursive: true });
    chmodSync(blocked, 0o000);
    try {
      try {
        readdirSync(blocked);
        t.skip('filesystem permissions are not enforced for this user');
        return;
      } catch (error) {
        assert.equal(error.code, 'EACCES');
      }

      const result = await parse();
      assert.equal(result.skipped, true);
      assert.equal(result.buckets.length, 1);
      assert.ok(result.warnings.some((warning) => warning.includes('blocked')));
    } finally {
      chmodSync(blocked, 0o700);
    }
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

test('DSH skips logs with an unknown session format version', async () => {
  await withDshSessions(async (sessions) => {
    writeSession(sessions, 'proj-g', 'session-9', [
      sessionRecord('session-9', '/home/me/proj-g', 99),
      userRecord(1700000100000),
      assistantRecord(1700000120000, 'model-a', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0 }),
    ], true);

    const result = await parse();
    assert.equal(result.skipped, true);
    assert.deepEqual(result.buckets, []);
    assert.ok(result.warnings.some((warning) => /format version 99/.test(warning)));
  });
});

function versionedHeader(id, version, extra = {}) {
  return sessionRecord(id, `/home/me/${id}`, version, {
    ...(version >= 2 ? { isSeeded: false } : {}),
    ...extra,
  });
}

function identifiedTurn(prefix, inputTokens = 100, time = 1700000100000) {
  const user = userRecord(time);
  user.data.id = `${prefix}-user`;
  const assistant = assistantRecord(time + 20000, 'deepseek-v4-pro', {
    inputTokens, cacheWriteTokens: 7, cacheReadTokens: 200, outputTokens: 50, reasoningTokens: 20,
  });
  assistant.data.message.id = `${prefix}-assistant`;
  return [user, assistant];
}

for (const version of [1, 2, 3]) {
  for (const plain of [true, false]) {
    test(`DSH reads V${version} ${plain ? 'plain' : 'multi-frame zstd'} logs`, { skip: !plain && !hasBuiltinZstd }, async () => {
      await withDshSessions(async (sessions) => {
        writeSession(sessions, 'project', 'modern', [
          versionedHeader('modern', version),
          ...withSeq(identifiedTurn('turn')),
          // Embedded stream usage and failed attempts are not extra messages.
          { type: 'assistant/attempt', seq: 2, time: 1700000130000, data: { stream: [] } },
        ], plain, version);
        const result = await parse();
        assert.equal(result.skipped, undefined);
        assert.deepEqual(result.buckets.map(b => [b.inputTokens, b.outputTokens, b.cachedInputTokens, b.reasoningOutputTokens]), [[107, 30, 200, 20]]);
        assert.equal(result.sessions.length, 1);
        assert.equal(result.sessions[0].messageCount, 2);
      });
    });
  }
}

test('DSH selects the newest generation once, ignores temporary names, and follows live appends', async () => {
  await withDshSessions(async (sessions) => {
    const historical = withSeq(identifiedTurn('old'));
    for (const version of [0, 1, 2, 3]) {
      const dir = writeSession(sessions, 'project', 'same-id', [
        versionedHeader('same-id', version), ...historical,
      ], true, version);
      // Noncanonical files must not mask the actual current log.
      for (const name of ['session.v99.jsonl.tmp', 'session.v03.jsonl', 'session.v0.jsonl']) {
        writeFileSync(join(dir, name), 'not a session');
      }
    }
    const before = await parse();
    assert.equal(before.buckets[0].inputTokens, 107);
    assert.equal(before.sessions.length, 1);
    writeSession(sessions, 'project', 'same-id', [
      versionedHeader('same-id', 3), ...historical,
      ...withSeq(identifiedTurn('new', 300, 1700000200000), 2),
    ], true, 3);
    const after = await parse();
    assert.equal(after.skipped, undefined);
    assert.equal(after.buckets[0].inputTokens, 414);
    assert.equal(after.sessions[0].messageCount, 4);
    assert.equal(after.sessions[0].sessionHash, before.sessions[0].sessionHash);
  });
});

test('DSH prefers the newest format across copied project dirs even when the older log is larger', async () => {
  await withDshSessions(async (sessions) => {
    writeSession(sessions, 'old-project', 'same-id', [
      versionedHeader('same-id', 1),
      ...withSeq(identifiedTurn('old', 900)),
      { type: 'assistant/chunk', data: { padding: 'x'.repeat(2000) } },
    ], true, 1);
    writeSession(sessions, 'new-project', 'same-id', [
      versionedHeader('same-id', 3), ...withSeq(identifiedTurn('current', 100)),
    ], true, 3);
    const result = await parse();
    assert.equal(result.buckets[0].inputTokens, 107);
    assert.equal(result.sessions.length, 1);
  });
});

for (const version of [1, 2, 3]) {
  test(`DSH V${version} skips only the proven inherited prefix, retaining resumed local turns`, async () => {
    await withDshSessions(async (sessions) => {
      const inherited = withSeq(identifiedTurn('parent', 100));
      const local = withSeq(identifiedTurn('child', 300, 1700000200000), 3);
      writeSession(sessions, 'project', 'parent', [
        versionedHeader('parent', version), ...inherited,
      ], true, version);
      writeSession(sessions, 'project', 'child', [
        versionedHeader('child', version, {
          parentSession: 'parent', ...(version === 1 ? { seedLength: 2 } : { isSeeded: true }),
        }),
        ...inherited,
        { ...endSeedRecord(2), data: version === 1 ? {} : { inherited: true } },
        ...local,
        endSeedRecord(5),
      ], true, version);
      const result = await parse();
      assert.equal(result.skipped, undefined);
      const child = result.buckets.find(b => b.project === 'child');
      assert.equal(child.inputTokens, 307);
      assert.equal(result.sessions.find(s => s.project === 'child').messageCount, 2);
    });
  });
}

test('DSH V3 uses the last inherited marker for a fork of an already seeded session', async () => {
  await withDshSessions(async (sessions) => {
    const parentRows = [
      ...withSeq(identifiedTurn('grandparent', 100)),
      { ...endSeedRecord(2), data: { inherited: true } },
      ...withSeq(identifiedTurn('parent', 200, 1700000200000), 3),
    ];
    writeSession(sessions, 'project', 'parent', [
      versionedHeader('parent', 3, { isSeeded: true, parentSession: 'missing-grandparent' }), ...parentRows,
    ], true, 3);
    writeSession(sessions, 'project', 'child', [
      versionedHeader('child', 3, { isSeeded: true, parentSession: 'parent' }), ...parentRows,
      { ...endSeedRecord(5), data: { inherited: true } },
      ...withSeq(identifiedTurn('child', 300, 1700000300000), 6),
      endSeedRecord(8),
    ], true, 3);
    const result = await parse();
    assert.equal(result.skipped, undefined);
    assert.equal(result.buckets.find(b => b.project === 'parent').inputTokens, 314);
    assert.equal(result.buckets.find(b => b.project === 'child').inputTokens, 307);
  });
});

for (const [parentVersion, childVersion] of [[2, 3], [3, 2], [1, 3]]) {
  test(`DSH matches inherited message ids across V${parentVersion}/V${childVersion} sequence renumbering`, async () => {
    await withDshSessions(async (sessions) => {
      const inherited = identifiedTurn('parent', 100);
      writeSession(sessions, 'project', 'parent', [
        versionedHeader('parent', parentVersion), ...withSeq(inherited, 10),
      ], true, parentVersion);
      writeSession(sessions, 'project', 'child', [
        versionedHeader('child', childVersion, { parentSession: 'parent', isSeeded: true }),
        ...withSeq(inherited, 20),
        { ...endSeedRecord(22), data: { inherited: true } },
        ...withSeq(identifiedTurn('child', 300, 1700000200000), 23),
      ], true, childVersion);
      const result = await parse();
      assert.equal(result.skipped, undefined);
      assert.equal(result.buckets.find(b => b.project === 'child').inputTokens, 307);
    });
  });
}

test('DSH retains a mixed-version seed when message identity cannot prove the parent copy', async () => {
  await withDshSessions(async (sessions) => {
    writeSession(sessions, 'project', 'parent', [
      versionedHeader('parent', 2), ...withSeq(identifiedTurn('parent', 100)),
    ], true, 2);
    writeSession(sessions, 'project', 'child', [
      versionedHeader('child', 3, { parentSession: 'parent', isSeeded: true }),
      ...withSeq(identifiedTurn('different-ids', 100)),
      { ...endSeedRecord(2), data: { inherited: true } },
    ], true, 3);
    const result = await parse();
    assert.equal(result.buckets.find(b => b.project === 'child').inputTokens, 107);
  });
});

for (const extra of [{ isSeeded: false }, { isSeeded: true, parentSession: 'missing' }]) {
  test(`DSH V3 counts ${extra.isSeeded ? 'missing-parent inherited' : 'unseeded'} history in full`, async () => {
    await withDshSessions(async (sessions) => {
      writeSession(sessions, 'project', 'child', [
        versionedHeader('child', 3, extra), ...withSeq(identifiedTurn('turn', 100)),
        ...(extra.isSeeded ? [{ ...endSeedRecord(2), data: { inherited: true } }] : []),
        endSeedRecord(3),
      ], true, 3);
      const result = await parse();
      assert.equal(result.skipped, undefined);
      assert.equal(result.buckets[0].inputTokens, 107);
    });
  });
}

for (const problem of ['future-version', 'corrupt', 'header-mismatch', 'missing-seed-marker']) {
  test(`DSH reports ${problem} in the highest generation without falling back to stale data`, async () => {
    await withDshSessions(async (sessions) => {
      writeSession(sessions, 'project', 'stale', [
        versionedHeader('stale', 0), ...withSeq(identifiedTurn('old', 100)),
      ], true);
      const dir = writeSession(sessions, 'project', 'stale', [
        versionedHeader('stale', problem === 'header-mismatch' ? 2 : 3, {
          isSeeded: problem === 'missing-seed-marker',
        }), ...withSeq(identifiedTurn('new', 300)),
      ], true, problem === 'future-version' ? 10 : 3);
      if (problem === 'corrupt') writeFileSync(join(dir, 'session.v3.jsonl'), 'broken');
      writeSession(sessions, 'project', 'healthy', [
        versionedHeader('healthy', 3), ...withSeq(identifiedTurn('healthy', 200)),
      ], true, 3);
      const result = await parse();
      assert.equal(result.skipped, true);
      assert.ok(result.warnings.some(w => w.includes('stale')));
      assert.deepEqual(result.buckets.map(b => b.project), ['healthy']);
    });
  });
}
