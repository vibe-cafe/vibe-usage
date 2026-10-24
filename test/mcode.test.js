import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse, resolveMcodeDbPath, resolveMcodeDbPaths } from '../src/parsers/mcode.js';
import { parsers } from '../src/parsers/index.js';
import { TOOLS } from '../src/tools.js';

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function writeDb(path, sqlText) {
  mkdirSync(dirname(path), { recursive: true });
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    // Node 20 exercises the sqlite3 CLI fallback used by queryDbJson().
  }
  if (DatabaseSync) {
    const db = new DatabaseSync(path);
    try {
      db.exec(sqlText);
    } finally {
      db.close();
    }
  } else {
    execFileSync('sqlite3', [path, sqlText]);
  }
}

async function fixtureDb(schema, rows = '') {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-mcode-'));
  const path = join(root, 'runtime-state.sqlite');
  await writeDb(path, `${schema}${rows}`);
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
function token(session, ts, input, output, reasoning, read, write, model = 'mcode-model', turn = 'turn') {
  return `INSERT INTO local_runtime_token_usage VALUES (NULL,${sql(session)},'agent','pi',${sql(turn)},${sql(model)},${value(ts)},${value(input)},${value(output)},${value(reasoning)},${value(read)},${value(write)},0,NULL);`;
}

function sessionHash(sessionId) {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

async function withDb(path, fn) {
  const previous = process.env.VIBE_USAGE_MCODE_DB;
  process.env.VIBE_USAGE_MCODE_DB = path;
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env.VIBE_USAGE_MCODE_DB;
    else process.env.VIBE_USAGE_MCODE_DB = previous;
  }
}

// parse() resolves homedir() itself, so multi-store discovery runs in a child
// process with a fake home — os.homedir() ignores HOME on Windows and reads
// USERPROFILE instead, hence both. Ambient locator variables are dropped so a
// developer machine's real stores cannot leak into the fixture.
function parseInHome(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of ['VIBE_USAGE_MCODE_DB', 'MCODE_HOME', 'MINIMAX_DATA_DIR', 'MAVIS_DATA_DIR']) {
    delete env[key];
  }
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    'import { parse } from "./src/parsers/mcode.js";console.log(JSON.stringify(await parse()));',
  ], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8' }));
}

test('mcode is registered and discovers env overrides', () => {
  assert.equal(typeof parsers.mcode, 'function');
  assert.equal(TOOLS.find(tool => tool.id === 'mcode')?.name, 'MiniMax Code');
  assert.equal(resolveMcodeDbPath({ VIBE_USAGE_MCODE_DB: '/tmp/mcode.db' }), '/tmp/mcode.db');
  const home = join(tmpdir(), 'minimax');
  assert.equal(resolveMcodeDbPath({ MCODE_HOME: home }), join(home, 'v2', 'sqlite', 'runtime-state.sqlite'));
  // The mcode CLI itself relocates the whole data root with these two variables.
  assert.equal(
    resolveMcodeDbPath({ MINIMAX_DATA_DIR: home }),
    join(home, 'v2', 'sqlite', 'runtime-state.sqlite'),
  );
  assert.equal(
    resolveMcodeDbPath({ MAVIS_DATA_DIR: home }),
    join(home, 'v2', 'sqlite', 'runtime-state.sqlite'),
  );
  // Fixture override beats the CLI's own variables, which keep their order.
  assert.equal(
    resolveMcodeDbPath({ MCODE_HOME: '/tmp/mcode-home', MINIMAX_DATA_DIR: home }),
    join('/tmp/mcode-home', 'v2', 'sqlite', 'runtime-state.sqlite'),
  );
  assert.throws(
    () => resolveMcodeDbPath({ MINIMAX_DATA_DIR: 'relative/minimax' }),
    /MINIMAX_DATA_DIR must be an absolute path/,
  );
  assert.throws(
    () => resolveMcodeDbPaths({ MAVIS_DATA_DIR: 'relative/mavis' }),
    /MAVIS_DATA_DIR must be an absolute path/,
  );
});

test('mcode scans profile, pre-npm and pre-rename stores once each', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vibe-usage-mcode-home-'));
  const rel = join('v2', 'sqlite', 'runtime-state.sqlite');
  const primary = join(home, '.minimax', rel);
  const legacy = join(home, '.minimax-code', rel);
  const profile = join(home, '.minimax-work', rel);
  const row = token('s1', 1787935277463, 10, 2, 0, 0, 0);
  try {
    await writeDb(primary, `${schema}INSERT INTO local_runtime_sessions VALUES ('s1','/work/primary',NULL);${row}`);
    // A pre-npm source-build store keeps its own history…
    await writeDb(
      legacy,
      `${schema}INSERT INTO local_runtime_sessions VALUES ('s1','/work/primary',NULL);` +
        `INSERT INTO local_runtime_sessions VALUES ('s9','/work/old',NULL);` +
        `${row}${token('s9', 1787931677463, 3, 1, 0, 0, 0)}`,
    );
    await writeDb(profile, `${schema}INSERT INTO local_runtime_sessions VALUES ('s2','/work/profile',NULL);${token('s2', 1787935277463, 5, 0, 0, 2, 0)}`);
    // …while the CLI's compat migration leaves ~/.mavis pointing at ~/.minimax.
    symlinkSync(join(home, '.minimax'), join(home, '.mavis'), 'dir');

    assert.deepEqual(resolveMcodeDbPaths({}, home), [primary, legacy, profile]);

    const result = parseInHome(home);

    assert.equal(result.skipped, undefined);
    assert.deepEqual(
      result.buckets.map(bucket => [bucket.project, bucket.inputTokens, bucket.cachedInputTokens, bucket.outputTokens]).sort(),
      [
        ['old', 3, 0, 1],
        ['primary', 10, 0, 2],
        ['profile', 5, 2, 0],
      ].sort(),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});


test('mcode aggregates milliseconds, basename, cache and separate reasoning', async () => {
  const db = await fixtureDb(schema, `
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
    // mcode now reports the session its token rows belong to.
    assert.equal(result.sessions.length, 1);
    const session = result.sessions[0];
    assert.equal(session.source, 'mcode');
    assert.equal(session.project, 'project-a');
    assert.equal(session.messageCount, 2);
    assert.equal(session.userMessageCount, 0);
    assert.equal(session.durationSeconds, 8);
    // Both rows share one turn id, so the whole span is active time.
    assert.equal(session.activeSeconds, 8);
  } finally { rmSync(db.root, { recursive: true, force: true }); }
});

test('mcode clamps malformed negative/reasoning values and handles seconds', async () => {
  const db = await fixtureDb(schema, `
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
  const db = await fixtureDb(`CREATE TABLE local_runtime_token_usage (session_id TEXT);`);
  try {
    const result = await withDb(db.path, parse);
    assert.equal(result.skipped, true);
    assert.deepEqual(result.buckets, []);
  } finally { rmSync(db.root, { recursive: true, force: true }); }
});

test('mcode keeps the live store when an extra store is incompatible', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vibe-usage-mcode-extra-'));
  const rel = join('v2', 'sqlite', 'runtime-state.sqlite');
  try {
    await writeDb(
      join(home, '.minimax', rel),
      `${schema}INSERT INTO local_runtime_sessions VALUES ('s1','/work/live',NULL);${token('s1', 1787935277463, 4, 2, 0, 0, 0)}`,
    );
    // A leftover profile store this build cannot read must surface as a
    // warning, not blank the store the CLI is actually writing to.
    await writeDb(join(home, '.minimax-broken', rel), 'CREATE TABLE local_runtime_token_usage (session_id TEXT);');

    const result = parseInHome(home);

    assert.equal(result.skipped, undefined);
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0].project, 'live');
    assert.equal(result.buckets[0].inputTokens, 4);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /结构不兼容/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('mcode query contains only the approved columns', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/parsers/mcode.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /SELECT\s+\*/i);
  assert.doesNotMatch(source, /SELECT[^;]*(?:raw|data_json|record_json|extra_data_json)/is);
  assert.match(source, /LEFT JOIN local_runtime_sessions/);
});

test('mcode reports one session per session id, timed from its usage rows', async () => {
  const db = await fixtureDb(
    `${schema}` +
      `INSERT INTO local_runtime_sessions VALUES ('s1','/work/alpha',NULL);` +
      `INSERT INTO local_runtime_sessions VALUES ('s2','/work/beta','/projects/beta');` +
      token('s1', 1787935277463, 10, 2, 0, 0, 0, 'mcode-model', 't1') +
      token('s1', 1787935287463, 10, 2, 0, 0, 0, 'mcode-model', 't1') +
      token('s1', 1787935907463, 10, 2, 0, 0, 0, 'mcode-model', 't2') +
      token('s2', 1787935277463, 5, 1, 0, 0, 0),
  );
  try {
    const result = await withDb(db.path, parse);
    assert.equal(result.sessions.length, 2);

    const s1 = result.sessions.find(s => s.sessionHash === sessionHash('s1'));
    assert.ok(s1, 'session for s1');
    assert.equal(s1.source, 'mcode');
    assert.equal(s1.project, 'alpha');
    assert.equal(s1.messageCount, 3);
    // The token ledger carries no user messages.
    assert.equal(s1.userMessageCount, 0);
    assert.deepEqual(s1.userPromptHours, new Array(24).fill(0));
    assert.equal(s1.firstMessageAt, new Date(1787935277463).toISOString());
    assert.equal(s1.lastMessageAt, new Date(1787935907463).toISOString());
    assert.equal(s1.durationSeconds, 630);
    // Only turn t1 spans more than one row; t2 is a single row.
    assert.equal(s1.activeSeconds, 10);

    // The project column wins over the workspace scratch dir.
    const s2 = result.sessions.find(s => s.sessionHash === sessionHash('s2'));
    assert.equal(s2.project, 'beta');
    assert.equal(s2.messageCount, 1);
    assert.equal(s2.activeSeconds, 0);
  } finally { rmSync(db.root, { recursive: true, force: true }); }
});

test('mcode keeps one session per session id across stores', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vibe-usage-mcode-sessions-'));
  const rel = join('v2', 'sqlite', 'runtime-state.sqlite');
  const primary = join(home, '.minimax', rel);
  const legacy = join(home, '.minimax-code', rel);
  const row = token('s1', 1787935277463, 10, 2, 0, 0, 0);
  try {
    await writeDb(primary, `${schema}INSERT INTO local_runtime_sessions VALUES ('s1','/work/alpha',NULL);${row}`);
    // A pre-npm store keeps a copy of the same session.
    await writeDb(
      legacy,
      `${schema}INSERT INTO local_runtime_sessions VALUES ('s1','/work/alpha',NULL);${row}`,
    );

    const result = parseInHome(home);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].messageCount, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('mcode still reports sessions when the store has no turn_id column', async () => {
  const withoutTurn = `
CREATE TABLE local_runtime_sessions (
 session_id TEXT PRIMARY KEY, workspace_dir TEXT, project_workspace_dir TEXT
);
CREATE TABLE local_runtime_token_usage (
 id INTEGER PRIMARY KEY, session_id TEXT, agent_name TEXT, framework_type TEXT,
 model TEXT, ts INTEGER, input_tokens INTEGER, output_tokens INTEGER,
 reasoning_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
 cost_usd REAL, raw TEXT
);
`;
  const db = await fixtureDb(
    withoutTurn +
      `INSERT INTO local_runtime_sessions VALUES ('s1','/work/alpha',NULL);` +
      `INSERT INTO local_runtime_token_usage VALUES (NULL,'s1','agent','pi','mcode-model',1787935277463,10,2,0,0,0,0,NULL);` +
      `INSERT INTO local_runtime_token_usage VALUES (NULL,'s1','agent','pi','mcode-model',1787935287463,10,2,0,0,0,0,NULL);`,
  );
  try {
    const result = await withDb(db.path, parse);
    assert.equal(result.buckets.length, 1);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].messageCount, 2);
    // Without a turn id every row is its own turn, so no span is active time.
    assert.equal(result.sessions[0].activeSeconds, 0);
    assert.equal(result.sessions[0].durationSeconds, 10);
  } finally { rmSync(db.root, { recursive: true, force: true }); }
});
