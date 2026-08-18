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

// Replay fixtures copy the parent's message records verbatim (DSH rewrites
// seq/time on copies; the parser fingerprints content minus seq/time).
function replayOf(records) {
  return records.filter((record) => record.type === 'user/message' || record.type === 'assistant/message');
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

test('DSH skips a fork file\'s verified parent replay and counts only its own work', { skip: !hasBuiltinZstd }, async () => {
  await withDshSessions(async (sessions) => {
    // Parent: two real turns.
    const parentRecords = [
      sessionRecord('parent-1', '/home/me/parent'),
      userRecord(1700000100000),
      assistantRecord(1700000120000, 'model-a', { inputTokens: 111, outputTokens: 11, cacheReadTokens: 1111, reasoningTokens: 1 }),
      userRecord(1700000130000),
      assistantRecord(1700000140000, 'model-a', { inputTokens: 222, outputTokens: 22, cacheReadTokens: 2222, reasoningTokens: 2 }),
    ];
    writeSession(sessions, 'proj-p', 'parent-1', parentRecords);
    // Fork: replays the parent's message records verbatim, then its own turn.
    writeSession(sessions, 'proj-c', 'child-1', [
      sessionRecord('child-1', '/home/me/child', 0, { parentSession: 'parent-1', createdAt: 1700000200000 }),
      ...replayOf(parentRecords),
      userRecord(1700000210000),
      assistantRecord(1700000230000, 'model-a', { inputTokens: 333, outputTokens: 33, cacheReadTokens: 0, reasoningTokens: 3 }),
    ]);

    const result = await parse();
    // The parent's own work is counted from its own file; the child's replayed
    // 111/222 are skipped, and only the child's own work survives.
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

test('DSH skips a last-N-turn fork replay matched as a parent suffix', { skip: !hasBuiltinZstd }, async () => {
  await withDshSessions(async (sessions) => {
    const parentRecords = [
      sessionRecord('parent-2', '/home/me/parent'),
      userRecord(1700000100000),
      assistantRecord(1700000120000, 'model-a', { inputTokens: 111, outputTokens: 11, cacheReadTokens: 0, reasoningTokens: 1 }),
      userRecord(1700000130000),
      assistantRecord(1700000140000, 'model-a', { inputTokens: 222, outputTokens: 22, cacheReadTokens: 0, reasoningTokens: 2 }),
      userRecord(1700000150000),
      assistantRecord(1700000160000, 'model-a', { inputTokens: 333, outputTokens: 33, cacheReadTokens: 0, reasoningTokens: 3 }),
      userRecord(1700000170000),
      assistantRecord(1700000180000, 'model-a', { inputTokens: 444, outputTokens: 44, cacheReadTokens: 0, reasoningTokens: 4 }),
    ];
    writeSession(sessions, 'proj-p', 'parent-2', parentRecords);
    // Fork copies only the last two turns (a suffix of the parent at spawn).
    const lastTwo = parentRecords.slice(-4);
    writeSession(sessions, 'proj-c', 'child-2', [
      sessionRecord('child-2', '/home/me/child', 0, { parentSession: 'parent-2', createdAt: 1700000190000 }),
      ...replayOf(lastTwo),
      userRecord(1700000200000),
      assistantRecord(1700000220000, 'model-a', { inputTokens: 555, outputTokens: 55, cacheReadTokens: 0, reasoningTokens: 5 }),
    ]);

    const result = await parse();
    // Parent (111+222+333+444=1110) counted from its own file; child's replay
    // (last two turns) skipped; only child's own 555 survives.
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

test('DSH counts a fork file in full when its parent is missing (fail open)', { skip: !hasBuiltinZstd }, async () => {
  await withDshSessions(async (sessions) => {
    writeSession(sessions, 'proj-c', 'child-3', [
      sessionRecord('child-3', '/home/me/child', 0, { parentSession: 'ghost-parent', createdAt: 1700000200000 }),
      userRecord(1700000210000),
      assistantRecord(1700000230000, 'model-a', { inputTokens: 777, outputTokens: 77, cacheReadTokens: 0, reasoningTokens: 7 }),
    ]);

    const result = await parse();
    // No parent file to verify against: the only copy must not be dropped.
    assert.deepEqual(
      result.buckets.map((bucket) => bucket.inputTokens),
      [777],
    );
  });
});

test('DSH does not skip a tiny sub-threshold replay (fail open, bias to over-count)', { skip: !hasBuiltinZstd }, async () => {
  await withDshSessions(async (sessions) => {
    writeSession(sessions, 'proj-p', 'parent-4', [
      sessionRecord('parent-4', '/home/me/parent'),
      userRecord(1700000100000),
      assistantRecord(1700000120000, 'model-a', { inputTokens: 111, outputTokens: 11, cacheReadTokens: 0, reasoningTokens: 1 }),
      userRecord(1700000130000),
      assistantRecord(1700000140000, 'model-a', { inputTokens: 222, outputTokens: 22, cacheReadTokens: 0, reasoningTokens: 2 }),
    ]);
    // Fork replays only ONE turn (2 messages < MIN_REPLAY_MESSAGES=3): the
    // match is treated as coincidence and everything counts.
    const oneTurn = [
      userRecord(1700000130000),
      assistantRecord(1700000140000, 'model-a', { inputTokens: 222, outputTokens: 22, cacheReadTokens: 0, reasoningTokens: 2 }),
    ];
    writeSession(sessions, 'proj-c', 'child-4', [
      sessionRecord('child-4', '/home/me/child', 0, { parentSession: 'parent-4', createdAt: 1700000150000 }),
      ...oneTurn,
      userRecord(1700000160000),
      assistantRecord(1700000180000, 'model-a', { inputTokens: 333, outputTokens: 33, cacheReadTokens: 0, reasoningTokens: 3 }),
    ]);

    const result = await parse();
    // The 2-message replay is below MIN_REPLAY_MESSAGES, so the child's 222 is
    // not skipped (fail open) and its own 333 counts too — 222+333 land in the
    // same half-hour bucket and merge to 555. Had the replay been skipped the
    // bucket would be 333.
    assert.deepEqual(
      result.buckets.filter((bucket) => bucket.project === 'child').map((bucket) => bucket.inputTokens),
      [555],
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
      sessionRecord('session-9', '/home/me/proj-g', 1),
      userRecord(1700000100000),
      assistantRecord(1700000120000, 'model-a', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0 }),
    ], true);

    const result = await parse();
    assert.equal(result.skipped, true);
    assert.deepEqual(result.buckets, []);
    assert.ok(result.warnings.some((warning) => /format version 1/.test(warning)));
  });
});
