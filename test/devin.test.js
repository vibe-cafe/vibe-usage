import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, resolveDevinDbPath } from '../src/parsers/devin.js';
import { roundToHalfHour } from '../src/parsers/aggregate.js';
import { parsers } from '../src/parsers/index.js';
import { TOOLS } from '../src/tools.js';

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function fixtureDb(schema, rows = '') {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-devin-'));
  const path = join(root, 'sessions.db');
  execFileSync('sqlite3', [path, `${schema}${rows}`]);
  return { root, path };
}

const schema = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  working_directory TEXT NOT NULL,
  backend_type TEXT NOT NULL,
  model TEXT NOT NULL,
  agent_mode TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  title TEXT, main_chain_id INTEGER, shell_last_seen_index INTEGER DEFAULT 0,
  cogs_json TEXT, workspace_dirs TEXT, hidden INTEGER NOT NULL DEFAULT 0,
  metadata TEXT
);
CREATE TABLE message_nodes (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  node_id INTEGER NOT NULL,
  parent_node_id INTEGER,
  chat_message TEXT NOT NULL,
  created_at INTEGER NOT NULL, metadata TEXT
);
`;

function insertSession(id, dir, model = 'swe-2-high', hidden = 0) {
  return `INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode,
    created_at, last_activity_at, workspace_dirs, hidden, metadata)
    VALUES (${sql(id)}, ${sql(dir)}, 'windsurf', ${sql(model)}, 'accept-edits',
    1789525600, 1789526800, '[]', ${hidden}, '{"total_credit_cost":0,"total_acu_cost":1.5}');`;
}

function msg(session, node, role, createdSec, extra = {}) {
  const chat = {
    message_id: extra.messageId ?? `m-${session}-${node}`,
    role,
    content: 'body',
    metadata: {
      num_tokens: extra.numTokens ?? null,
      is_user_input: extra.isUserInput ?? null,
      request_id: extra.requestId ?? null,
      metrics: extra.metrics ?? null,
      finish_reason: null,
      created_at: extra.iso ?? null,
      generation_model: extra.generationModel ?? null,
      telemetry: { source: role, operation: 'inference' },
    },
  };
  return `INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
    VALUES (${sql(session)}, ${node}, NULL, ${sql(JSON.stringify(chat))}, ${createdSec});`;
}

function metrics(input, output, cacheRead, cacheCreation) {
  return {
    ttft_ms: 10, total_time_ms: 100, tpot_ms: 1, tokens_per_sec: 50,
    input_tokens: input, output_tokens: output,
    cache_read_tokens: cacheRead, cache_creation_tokens: cacheCreation,
  };
}

async function withDb(path, fn) {
  const previous = process.env.VIBE_USAGE_DEVIN_DB;
  process.env.VIBE_USAGE_DEVIN_DB = path;
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env.VIBE_USAGE_DEVIN_DB;
    else process.env.VIBE_USAGE_DEVIN_DB = previous;
  }
}

test('devin is registered and resolves env/XDG paths', () => {
  assert.equal(typeof parsers.devin, 'function');
  assert.equal(TOOLS.find(tool => tool.id === 'devin')?.name, 'Devin');
  assert.equal(
    resolveDevinDbPath({ VIBE_USAGE_DEVIN_DB: '/tmp/devin.db' }),
    '/tmp/devin.db',
  );
  assert.equal(
    resolveDevinDbPath({ XDG_DATA_HOME: '/tmp/xdg' }),
    '/tmp/xdg/devin/cli/sessions.db',
  );
  assert.equal(
    resolveDevinDbPath({}, '/home/u'),
    '/home/u/.local/share/devin/cli/sessions.db',
  );
});

test('devin aggregates metrics with cache creation folded into input', async () => {
  const db = fixtureDb(schema, `
    ${insertSession('s1', '/Users/x/Coding/proj-a')}
    ${msg('s1', 1, 'user', 1789525600, { isUserInput: 1, iso: '2026-09-16T02:27:00.000Z' })}
    ${msg('s1', 2, 'assistant', 1789525640, {
      iso: '2026-09-16T02:27:20.000Z',
      generationModel: 'claude-fable-5-1-medium',
      metrics: metrics(4, 203, 19126, 8804),
    })}
    ${msg('s1', 3, 'assistant', 1789525700, {
      iso: '2026-09-16T02:28:20.000Z',
      generationModel: 'claude-fable-5-1-medium',
      metrics: metrics(320, 103, 17533, null),
    })}
  `);
  try {
    const result = await withDb(db.path, parse);
    assert.equal(result.skipped, undefined);
    assert.equal(result.buckets.length, 1);
    const bucket = result.buckets[0];
    assert.equal(bucket.source, 'devin');
    assert.equal(bucket.project, 'proj-a');
    assert.equal(bucket.model, 'claude-fable-5-1-medium');
    assert.equal(bucket.inputTokens, 4 + 8804 + 320);
    assert.equal(bucket.outputTokens, 203 + 103);
    assert.equal(bucket.cachedInputTokens, 19126 + 17533);
    assert.equal(bucket.reasoningOutputTokens, 0);
    assert.equal(
      bucket.totalTokens,
      bucket.inputTokens + bucket.outputTokens + bucket.reasoningOutputTokens,
    );
  } finally { rmSync(db.root, { recursive: true, force: true }); }
});

test('devin deduplicates forest-copied message nodes by message_id', async () => {
  const shared = {
    messageId: 'dup-1',
    iso: '2026-09-16T02:27:20.000Z',
    metrics: metrics(10, 20, 30, 40),
  };
  const db = fixtureDb(schema, `
    ${insertSession('s1', '/p/proj')}
    ${msg('s1', 1, 'user', 1789525600, { isUserInput: 1, iso: '2026-09-16T02:26:00.000Z' })}
    ${msg('s1', 2, 'assistant', 1789525640, shared)}
    ${msg('s1', 3, 'assistant', 1789525640, shared)}
  `);
  try {
    const result = await withDb(db.path, parse);
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0].inputTokens, 50);
    assert.equal(result.buckets[0].outputTokens, 20);
    assert.equal(result.buckets[0].cachedInputTokens, 30);
    // The duplicated node must not double-count session messages either.
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].messageCount, 2);
    assert.equal(result.sessions[0].userMessageCount, 1);
  } finally { rmSync(db.root, { recursive: true, force: true }); }
});

test('devin splits models per message and falls back to the session model', async () => {
  const db = fixtureDb(schema, `
    ${insertSession('s1', '/p/proj', 'swe-2-high')}
    ${msg('s1', 1, 'user', 1789525600, { isUserInput: 1, iso: '2026-09-16T02:27:00.000Z' })}
    ${msg('s1', 2, 'assistant', 1789525640, {
      iso: '2026-09-16T02:27:20.000Z',
      generationModel: 'claude-opus-5-medium',
      metrics: metrics(1, 2, 0, 0),
    })}
    ${msg('s1', 3, 'assistant', 1789525700, {
      iso: '2026-09-16T02:28:20.000Z',
      metrics: metrics(3, 4, 0, 0),
    })}
  `);
  try {
    const result = await withDb(db.path, parse);
    const byModel = Object.fromEntries(result.buckets.map(b => [b.model, b]));
    assert.equal(byModel['claude-opus-5-medium'].outputTokens, 2);
    assert.equal(byModel['swe-2-high'].outputTokens, 4);
  } finally { rmSync(db.root, { recursive: true, force: true }); }
});

test('devin counts only is_user_input prompts and skips system/keepalive rows', async () => {
  const db = fixtureDb(schema, `
    ${insertSession('s1', '/p/proj')}
    ${msg('s1', 1, 'system', 1789525500, { iso: '2026-09-16T02:25:00.000Z' })}
    ${msg('s1', 2, 'user', 1789525600, { isUserInput: 1, iso: '2026-09-16T02:26:40.000Z' })}
    ${msg('s1', 3, 'assistant', 1789525640, {
      iso: '2026-09-16T02:27:20.000Z', metrics: metrics(5, 10, 0, 0),
    })}
    ${msg('s1', 4, 'tool', 1789525660, { iso: '2026-09-16T02:27:40.000Z' })}
    ${msg('s1', 5, 'user', 1789525800, {
      iso: '2026-09-16T02:30:00.000Z', isUserInput: null,
    })}
    ${msg('s1', 6, 'assistant', 1789525810, {
      iso: '2026-09-16T02:30:10.000Z', metrics: metrics(2, 3, 0, 0),
    })}
    ${insertSession('keepalive-only', '/p/idle')}
    ${msg('keepalive-only', 1, 'user', 1789526000, { isUserInput: null })}
    ${msg('keepalive-only', 2, 'assistant', 1789526010, {
      iso: '2026-09-16T02:33:30.000Z', metrics: metrics(7, 8, 0, 0),
    })}
  `);
  try {
    const result = await withDb(db.path, parse);
    // Keepalive-only session still contributes its real token usage. The
    // three assistant metrics land in three distinct (project × half-hour)
    // buckets: s1@02:00, s1@02:30 and keepalive-only@02:30.
    assert.equal(result.buckets.length, 3);
    assert.equal(result.sessions.length, 1);
    const session = result.sessions[0];
    assert.equal(session.source, 'devin');
    assert.equal(session.userMessageCount, 1);
    // system row excluded; user + 2 assistant + tool + keepalive-as-assistant
    assert.equal(session.messageCount, 5);
    assert.equal(session.firstMessageAt, '2026-09-16T02:26:40.000Z');
    assert.equal(session.lastMessageAt, '2026-09-16T02:30:10.000Z');
  } finally { rmSync(db.root, { recursive: true, force: true }); }
});

test('devin falls back to node created_at seconds when ISO is missing', async () => {
  const db = fixtureDb(schema, `
    ${insertSession('s1', '/p/proj')}
    ${msg('s1', 1, 'user', 1789525600, { isUserInput: 1 })}
    ${msg('s1', 2, 'assistant', 1789525640, { metrics: metrics(1, 1, 0, 0) })}
  `);
  try {
    const result = await withDb(db.path, parse);
    assert.equal(result.buckets.length, 1);
    assert.equal(
      result.buckets[0].bucketStart,
      roundToHalfHour(new Date(1789525640 * 1000)).toISOString(),
    );
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].firstMessageAt, new Date(1789525600 * 1000).toISOString());
  } finally { rmSync(db.root, { recursive: true, force: true }); }
});

test('devin returns skipped for missing or incompatible databases', async () => {
  const missing = await withDb('/tmp/does-not-exist-devin.db', parse);
  assert.deepEqual(missing, { buckets: [], sessions: [] });
  const db = fixtureDb(`CREATE TABLE message_nodes (session_id TEXT);`);
  try {
    const result = await withDb(db.path, parse);
    assert.equal(result.skipped, true);
    assert.deepEqual(result.buckets, []);
  } finally { rmSync(db.root, { recursive: true, force: true }); }
});

test('devin query selects only allow-listed fields', async () => {
  const source = await import('node:fs/promises')
    .then(fs => fs.readFile(new URL('../src/parsers/devin.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /SELECT\s+\*/i);
  // chat_message content, cogs_json and session billing metadata stay unread.
  assert.doesNotMatch(source, /SELECT[^;]*(?:cogs_json|s\.metadata|m\.metadata|content)/is);
  assert.match(source, /json_extract\(m\.chat_message, '\$\.metadata\.metrics\.input_tokens'\)/);
});
