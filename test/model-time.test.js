// Model time (approved 2026-11-25): what one reply counts, how a session's
// replies become `activeSeconds` and 5-minute cells, and how sync.js uploads
// the cells as rows of their own -- only when the server asks for them, and
// committed only when it acknowledges them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import {
  addModelTimeSpan,
  createModelTime,
  extractSessions,
  modelTimeFields,
  replyCapMs,
  replySpan,
  roundToHalfHour,
} from '../src/parsers/aggregate.js';
import { buildActivityRows } from '../src/sync.js';

const execFileAsync = promisify(execFile);
const T0 = Date.parse('2026-11-25T10:00:00.000Z');
const at = (seconds) => new Date(T0 + seconds * 1000);
const bucketOf = (seconds) => roundToHalfHour(at(seconds)).toISOString();

test('one reply counts from its request to its end, within 30 s + output / 20 per second', () => {
  assert.equal(replyCapMs(0), 30_000);
  assert.equal(replyCapMs(200), 40_000);
  assert.equal(replyCapMs(undefined), 120_000);
  assert.equal(replyCapMs(null), 120_000);

  const end = T0 + 100_000;
  // Short reply: the whole request-to-end span.
  assert.deepEqual(replySpan(T0 + 90_000, end, 400), [T0 + 90_000, end]);
  // A long wait before the reply (retry, queue): only the cap counts.
  assert.deepEqual(replySpan(T0, end, 400), [end - 50_000, end]);
  // Unknown output tokens: at most 2 minutes.
  assert.deepEqual(replySpan(T0 - 600_000, end, undefined), [end - 120_000, end]);
  // A known output of 0 (API error, interrupted call) counts nothing.
  assert.equal(replySpan(T0, end, 0), null);
  // No request time at all: the reply starts at its cap.
  assert.deepEqual(replySpan(null, end, 200), [end - 40_000, end]);
  // Spans of one session never overlap.
  assert.deepEqual(replySpan(T0 + 90_000, end, 400, T0 + 95_000), [T0 + 95_000, end]);
  assert.equal(replySpan(T0 + 90_000, end, 400, end), null);
});

test('spans are split into half-hour buckets and 5-minute cells', () => {
  const tally = createModelTime();
  // 4:30 → 5:30 crosses the first cell boundary; 29:40 → 30:20 crosses into
  // the next half-hour bucket.
  addModelTimeSpan(tally, at(270).getTime(), at(330).getTime());
  addModelTimeSpan(tally, at(1780).getTime(), at(1820).getTime());
  const { activeSeconds, activity } = modelTimeFields(tally);
  assert.equal(activeSeconds, 100);
  const byBucket = new Map(activity.map(([bucket, ...cells]) => [bucket, cells]));
  const total = [...byBucket.values()].flat().reduce((a, b) => a + b, 0);
  assert.equal(total, 100);
  // Whatever the local half-hour alignment, each piece lands in the cell that
  // holds its time.
  for (const [start, end] of [[270, 300], [300, 330], [1780, 1800], [1800, 1820]]) {
    const cells = byBucket.get(bucketOf(start));
    const cell = Math.floor((at(start) - Date.parse(bucketOf(start))) / 300_000);
    assert.ok(cells[cell] >= end - start, `cell ${cell} of ${bucketOf(start)} holds ${start}-${end}`);
  }
});

function events(sessionId, list) {
  return list.map(([seconds, role, outputTokens]) => ({
    sessionId,
    source: 'test',
    project: 'p',
    timestamp: at(seconds),
    role,
    ...(outputTokens === undefined ? {} : { outputTokens }),
  }));
}

test("'events' mode: each assistant event is a reply from the event before it; idle time between prompts is not", () => {
  const [session] = extractSessions(events('s', [
    [0, 'user'],
    [5, 'assistant'],       // reply 0 → 5
    [65, 'assistant'],      // tool result folded into an AI event: 5 → 65
    [3600, 'user'],         // an hour later
    [3610, 'assistant'],    // 3600 → 3610
  ]));
  assert.equal(session.activeSeconds, 5 + 60 + 10);
  assert.equal(session.durationSeconds, 3610);
  // The first event of a session has nothing to start from.
  const [opensWithReply] = extractSessions(events('t', [[0, 'assistant'], [3, 'assistant']]));
  assert.equal(opensWithReply.activeSeconds, 3);
});

test("'runs' mode (Claude Code): one reply per run of assistant lines, tokens summed, zero-output runs skipped", () => {
  const [session] = extractSessions(events('s', [
    [0, 'user'],
    [4, 'assistant', 600],  // reply: prompt → last line at 9 s (600 tokens: cap 60 s)
    [6, 'assistant', 0],
    [9, 'assistant', 0],
    [70, 'user'],           // tool result after 61 s of tool time
    [72, 'assistant', 0],   // an API error line: known zero output
    [500, 'user'],          // long tool run, then a long wait for the reply
    [800, 'assistant', 200], // capped at 30 s + 200 / 20 = 40 s
  ]), { replyMode: 'runs' });
  assert.equal(session.activeSeconds, 9 + 40);
  assert.equal(session.userMessageCount, 3);
  assert.equal(session.messageCount, 8);
});

test('upload rows add the cells of every session of one tool, project, machine and half-hour', () => {
  const b = bucketOf(0);
  const sessions = [
    { source: 'claude-code', project: 'app', hostname: 'mac', activity: [[b, 10, 0, 0, 0, 0, 5]] },
    { source: 'claude-code', project: 'app', hostname: 'mac', activity: [[b, 300, 20, 0, 0, 0, 0]] },
    { source: 'claude-code', project: 'other', hostname: 'mac', activity: [[b, 1, 0, 0, 0, 0, 0]] },
    // A source whose parser did not return a complete view adds nothing.
    { source: 'codex', project: 'app', hostname: 'mac', activity: [[b, 50, 0, 0, 0, 0, 0]] },
    { source: 'claude-code', project: 'app', hostname: 'mac' },
  ];
  const rows = buildActivityRows(sessions, new Set(['claude-code']));
  assert.deepEqual(rows, [
    { source: 'claude-code', project: 'app', hostname: 'mac', bucketStart: b, outputSeconds: [310, 20, 0, 0, 0, 5] },
    { source: 'claude-code', project: 'other', hostname: 'mac', bucketStart: b, outputSeconds: [1, 0, 0, 0, 0, 0] },
  ]);
});

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      resolve(JSON.parse((req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString('utf8')));
    });
  });
}

// Real runSync calls, each in a child process, sharing one config, one state
// and one stand-in server (the upload identity includes the server URL), whose
// settings answer and ingest reply each call chooses. The parser registry
// holds one fake Claude parser.
async function withStandIn(root, run) {
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const homeDir = join(root, 'home');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  let current = null;
  await withServer(async (req, res) => {
    if (req.method === 'GET' && req.url.split('?')[0] === '/api/usage/settings') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(current.settings));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/usage/ingest') {
      const body = await readBody(req);
      current.received.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ingested: body.buckets.length,
        sessions: body.sessions?.length ?? 0,
        ...(current.ackActivity ? { activity: body.activity?.length ?? 0 } : {}),
      }));
      return;
    }
    res.writeHead(404).end();
  }, async (apiUrl) => {
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      apiKey: 'vbu_model_time_test', apiUrl, hostname: 'model-time-test',
    }));
    const b = bucketOf(0);
    const command = `
      import { parsers } from './src/parsers/index.js';
      for (const source of Object.keys(parsers)) delete parsers[source];
      const session = (id, cells) => ({
        source: 'claude-code', project: id === 'a' ? 'app' : 'web', sessionHash: id,
        firstMessageAt: '${at(0).toISOString()}', lastMessageAt: '${at(60).toISOString()}',
        durationSeconds: 60, activeSeconds: cells.reduce((a, b) => a + b, 0),
        messageCount: 2, userMessageCount: 1, userPromptHours: [],
        activity: [['${b}', ...cells]],
      });
      parsers['claude-code'] = async () => ({
        buckets: [],
        sessions: [session('a', [10, 0, 0, 0, 0, 0]), session('b', [5, 7, 0, 0, 0, 0]), session('c', [1, 0, 0, 0, 0, 0])],
      });
      const { runSync } = await import('./src/sync.js');
      await runSync({ throws: true, quiet: true });
    `;
    const sync = async ({ settings, ackActivity }) => {
      current = { settings, ackActivity, received: [] };
      await execFileAsync(process.execPath, ['--input-type=module', '-e', command], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: homeDir,
          VIBE_USAGE_DEV: '0',
          VIBE_USAGE_CONFIG_DIR: configDir,
          VIBE_USAGE_STATE_DIR: stateDir,
        },
      });
      const state = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
      return { received: current.received, state };
    };
    await run(sync);
  });
}

test('sync uploads model-time rows when the server asks for them and commits them once acknowledged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-model-time-'));
  try {
    await withStandIn(root, async (sync) => {
      const first = await sync({ settings: { uploadProject: true, activity: true }, ackActivity: true });
      assert.equal(first.received.length, 1);
      const [body] = first.received;
      // Sessions b and c share a project ('web'): their cells add up.
      assert.deepEqual(body.activity, [
        { source: 'claude-code', project: 'app', hostname: 'model-time-test', bucketStart: bucketOf(0),
          outputSeconds: [10, 0, 0, 0, 0, 0] },
        { source: 'claude-code', project: 'web', hostname: 'model-time-test', bucketStart: bucketOf(0),
          outputSeconds: [6, 7, 0, 0, 0, 0] },
      ]);
      assert.equal(body.sessions.length, 3);
      for (const session of body.sessions) assert.equal('activity' in session, false);
      assert.equal(Object.keys(first.state.activity).length, 2);

      // Nothing changed: nothing is sent again.
      const second = await sync({ settings: { uploadProject: true, activity: true }, ackActivity: true });
      assert.equal(second.received.length, 0);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('without the server asking, or without an acknowledgement, rows are not sent or not committed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-model-time-off-'));
  try {
    await withStandIn(root, async (sync) => {
      const off = await sync({ settings: { uploadProject: true }, ackActivity: true });
      assert.equal(off.received.length, 1);
      assert.equal(off.received[0].activity, undefined);
      assert.equal(off.state.activity, undefined);

      // The server asks for them but answers like a release that does not know
      // them: they stay uncommitted, so a later sync sends them again.
      const unacknowledged = await sync({ settings: { uploadProject: true, activity: true }, ackActivity: false });
      assert.equal(unacknowledged.received.length, 1);
      assert.equal(unacknowledged.received[0].activity.length, 2);
      assert.equal(unacknowledged.state.activity, undefined);

      const acknowledged = await sync({ settings: { uploadProject: true, activity: true }, ackActivity: true });
      assert.equal(acknowledged.received.length, 1);
      assert.equal(acknowledged.received[0].activity.length, 2);
      assert.equal(acknowledged.received[0].sessions, undefined);
      assert.equal(Object.keys(acknowledged.state.activity).length, 2);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hidden project names merge the rows of different projects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-model-time-hidden-'));
  try {
    await withStandIn(root, async (sync) => {
      const { received } = await sync({ settings: { uploadProject: false, activity: true }, ackActivity: true });
      assert.deepEqual(received[0].activity.map(row => [row.project, row.outputSeconds]),
        [['unknown', [16, 7, 0, 0, 0, 0]]]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
