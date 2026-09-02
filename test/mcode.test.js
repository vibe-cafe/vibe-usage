import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, resolveMcodeDbPath } from '../src/parsers/mcode.js';
import { parsers } from '../src/parsers/index.js';
import { TOOLS } from '../src/tools.js';

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function fixtureDb(schema, rows = '') {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-mcode-'));
  const path = join(root, 'runtime-state.sqlite');
  execFileSync('sqlite3', [path, `${schema}${rows}`]);
  return { root, path };
}

const schema = `
CREATE TABLE local_runtime_sessions (
 session_id TEXT PRIMARY KEY, workspace_dir TEXT, project_workspace_dir TEXT
);
CREATE TABLE local_runtime_token_usage (
 id INTEGER PRIMARY KEY, session_id TEXT, agent_name TEXT, framework_type TEXT,
 turn_id TEXT, model TEXT, ts INTEGER, input_tokens INTEGER, output_tokens INTEGER,
 reasoning_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
 cost_usd REAL, raw TEXT
);
`;

function value(v) {
  if (v === null || v === undefined) return 'NULL';
  return typeof v === 'string' ? sql(v) : String(v);
}
function token(session, ts, input, output, reasoning, read, write, model = 'mcode-model') {
  return `INSERT INTO local_runtime_token_usage VALUES (NULL,${sql(session)},'agent','pi','turn',${sql(model)},${value(ts)},${value(input)},${value(output)},${value(reasoning)},${value(read)},${value(write)},0,NULL);`;
}

async function withDb(path, fn) {
  const previous = process.env.VIBE_USAGE_MCODE_DB;
  process.env.VIBE_USAGE_MCODE_DB = path;
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env.VIBE_USAGE_MCODE_DB;
    else process.env.VIBE_USAGE_MCODE_DB = previous;
  }
}

test('mcode is registered and discovers env overrides', () => {
  assert.equal(typeof parsers.mcode, 'function');
  assert.equal(TOOLS.find(tool => tool.id === 'mcode')?.name, 'MiniMax Code');
  assert.equal(resolveMcodeDbPath({ VIBE_USAGE_MCODE_DB: '/tmp/mcode.db' }), '/tmp/mcode.db');
  assert.equal(resolveMcodeDbPath({ MCODE_HOME: '/tmp/minimax' }), '/tmp/minimax/v2/sqlite/runtime-state.sqlite');
});

test('mcode aggregates milliseconds, basename, cache and separate reasoning', async () => {
  const db = fixtureDb(schema, `
    INSERT INTO local_runtime_sessions VALUES ('s1','/tmp/s1/workspace','/fixtures/project-a');
    INSERT INTO local_runtime_sessions VALUES ('s2',NULL,NULL);
    ${token('s1', 1787935277463, 10, 9, 3, 4, 5)}
    ${token('s1', 1787935285209, 2, 4, 0, 1, 0)}
    ${token('s2', 1787935285209, null, null, null, null, null)}
  `);
  try {
    const result = await withDb(db.path, parse);
    assert.equal(result.skipped, undefined);
    assert.equal(result.buckets.length, 1);
    const bucket = result.buckets[0];
    assert.equal(bucket.project, 'project-a');
    assert.equal(bucket.inputTokens, 17);
    assert.equal(bucket.cachedInputTokens, 5);
    assert.equal(bucket.outputTokens, 13);
    assert.equal(bucket.reasoningOutputTokens, 3);
    assert.equal(bucket.totalTokens, 33);
    assert.deepEqual(result.sessions, []);
  } finally { rmSync(db.root, { recursive: true, force: true }); }
});

test('mcode clamps malformed negative/reasoning values and handles seconds', async () => {
  const db = fixtureDb(schema, `
    INSERT INTO local_runtime_sessions VALUES ('s1','/tmp/project-b/',NULL);
    ${token('s1', 1787935200, -3, 2, 9, 'bad', 1)}
  `);
  try {
    const result = await withDb(db.path, parse);
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0].project, 'project-b');
    assert.equal(result.buckets[0].inputTokens, 1);
    assert.equal(result.buckets[0].cachedInputTokens, 0);
    assert.equal(result.buckets[0].outputTokens, 2);
    assert.equal(result.buckets[0].reasoningOutputTokens, 9);
  } finally { rmSync(db.root, { recursive: true, force: true }); }
});

test('mcode returns skipped for missing or incompatible databases', async () => {
  const missing = await withDb('/tmp/does-not-exist-mcode.sqlite', parse);
  assert.deepEqual(missing, { buckets: [], sessions: [] });
  const db = fixtureDb(`CREATE TABLE local_runtime_token_usage (session_id TEXT);`);
  try {
    const result = await withDb(db.path, parse);
    assert.equal(result.skipped, true);
    assert.deepEqual(result.buckets, []);
  } finally { rmSync(db.root, { recursive: true, force: true }); }
});

test('mcode query contains only the approved columns', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/parsers/mcode.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /SELECT\s+\*/i);
  assert.doesNotMatch(source, /SELECT[^;]*(?:raw|data_json|record_json|extra_data_json)/is);
  assert.match(source, /LEFT JOIN local_runtime_sessions/);
});
