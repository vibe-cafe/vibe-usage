// A SQLite store whose -wal still holds frames is never cached (OpenCode, the
// Qoder IDE store, Antigravity cascades). SQLite appends a transaction to the
// WAL before it publishes it in the wal-index, so a sync in between reads the
// old rows while every stat already shows the committed files; a result cached
// under that stat kept the old total until the store changed again
// (cross-review 2026-11-19: 10 tokens, 20 more committed, the cache kept 10).
//
// The window cannot be held open with a real SQLite, so each test pins what
// statSync reports for the store's files to "committed" and moves the content
// from the pre-commit rows (10) to the committed rows (10 + 20). With frames in
// the WAL the second sync must report 30. With an empty WAL (the app closed)
// the store stays cacheable: the second sync then returns the first result,
// which proves the hit (the content changes behind pinned stats only here).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* Node 20: no parser cache at all */ }
const skip = DatabaseSync ? false : 'node:sqlite unavailable: the parser cache is off';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'vibe-usage-sqlite-commit-')));
const isolated = {
  HOME: join(root, 'home'),
  USERPROFILE: join(root, 'home'),
  XDG_DATA_HOME: join(root, 'xdg'),
  VIBE_USAGE_CONFIG_DIR: join(root, 'vibe'),
  VIBE_USAGE_STATE_DIR: join(root, 'vibe'),
  VIBE_USAGE_QODER_PROJECTS: join(root, 'no-qoder-projects'),
  VIBE_USAGE_QODER_CN_PROJECTS: join(root, 'no-qoder-cn-projects'),
  VIBE_USAGE_QODER_CN_DB: join(root, 'no-qoder-cn.db'),
};
const touched = [...Object.keys(isolated), 'VIBE_USAGE_CACHE_DIR', 'VIBE_USAGE_PARSER_CACHE',
  'VIBE_USAGE_OPENCODE_DIRS', 'VIBE_USAGE_QODER_DB', 'VIBE_USAGE_ANTIGRAVITY_DIRS'];
const previous = Object.fromEntries(touched.map(key => [key, process.env[key]]));
Object.assign(process.env, isolated);
delete process.env.VIBE_USAGE_PARSER_CACHE;
const { parse: parseOpenCode } = await import('../src/parsers/opencode.js');
const { parseQoder } = await import('../src/parsers/qoder.js');
const { parse: parseAntigravity } = await import('../src/parsers/antigravity.js');
after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const T0 = 1790000000000;
const inputTokens = result => result.buckets.reduce((n, b) => n + b.inputTokens, 0);

function writeDb(path, sql, rows = []) {
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(sql.schema);
    const insert = db.prepare(sql.insert);
    for (const row of rows) insert.run(...row);
  } finally {
    db.close();
  }
}

// ── store builders: `calls` is a list of input-token counts ──────────────────
const opencode = {
  file: 'opencode.db',
  setup: dir => { process.env.VIBE_USAGE_OPENCODE_DIRS = dir; },
  parse: () => parseOpenCode(),
  write: (path, calls) => writeDb(path, {
    schema: 'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)',
    insert: 'INSERT INTO message VALUES (?, ?, ?)',
  }, [
    ['m0', 'ses_1', JSON.stringify({ role: 'user', time: { created: T0 }, path: { root: '/w/app' } })],
    ...calls.map((input, i) => [`m${i + 1}`, 'ses_1', JSON.stringify({ role: 'assistant',
      time: { created: T0 + (i + 1) * 1000 }, modelID: 'test-model', path: { root: '/w/app' },
      tokens: { input, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } })]),
  ]),
};

const qoder = {
  file: 'local.db',
  setup: dir => { process.env.VIBE_USAGE_QODER_DB = join(dir, 'local.db'); },
  parse: () => parseQoder(),
  write: (path, calls) => writeDb(path, {
    schema: `CREATE TABLE chat_message (id varchar(64) primary key, session_id VARCHAR(64), request_id VARCHAR(64),
        role VARCHAR(64), content text, summary text, summary_modified INTEGER, summary_trigger INTEGER DEFAULT 0,
        tool_result text, token_info text, model_info text, extra text DEFAULT '', gmt_create INTEGER);
      CREATE TABLE chat_session (session_id varchar(64) primary key, user_id VARCHAR(64), user_name varchar(64),
        session_title varchar(256), project_id varchar(64), project_uri varchar(512), project_name varchar(64),
        gmt_create INTEGER, gmt_modified INTEGER, preferred_model_info TEXT DEFAULT '');
      INSERT INTO chat_session (session_id, project_uri, project_name) VALUES ('s1', 'file:///w/ide', 'ide');`,
    insert: `INSERT INTO chat_message (id, session_id, request_id, role, content, token_info, model_info, extra, gmt_create)
      VALUES (?, 's1', ?, ?, '', ?, '{"model_key":"auto"}', '', ?)`,
  }, [
    ['u0', 'r0', 'user', '', T0],
    ...calls.map((input, i) => [`a${i + 1}`, `r${i + 1}`, 'assistant',
      JSON.stringify({ prompt_tokens: input, completion_tokens: 1, cached_tokens: 0 }), T0 + (i + 1) * 1000]),
  ]),
};

// Minimal protobuf encoder for an Antigravity GeneratorMetadata blob (see test/antigravity.test.js).
function varint(n) {
  const bytes = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return Buffer.from(bytes);
}
const tag = (num, wire) => varint((num << 3) | wire);
const vfield = (num, val) => Buffer.concat([tag(num, 0), varint(val)]);
const lfield = (num, buf) => Buffer.concat([tag(num, 2), varint(buf.length), buf]);
const sfield = (num, str) => lfield(num, Buffer.from(str, 'utf-8'));
const genBlob = (input, responseId, seconds) => lfield(1, Buffer.concat([
  lfield(4, Buffer.concat([vfield(2, input), vfield(3, 1), sfield(11, responseId)])),
  lfield(9, lfield(4, vfield(1, seconds))),
  sfield(21, 'fixture-model'),
]));

const antigravity = {
  file: 'cascade.db',
  setup: dir => { process.env.VIBE_USAGE_ANTIGRAVITY_DIRS = dir; },
  parse: () => parseAntigravity(),
  write: (path, calls) => writeDb(path, {
    schema: 'CREATE TABLE steps (idx INTEGER, metadata BLOB); CREATE TABLE gen_metadata (idx INTEGER, data BLOB)',
    insert: 'INSERT INTO gen_metadata (idx, data) VALUES (?, ?)',
  }, calls.map((input, i) => [i + 1, genBlob(input, `RESP_${i + 1}`, T0 / 1000 + i + 1)])),
};

// Pin what statSync reports for these paths (null = the file does not exist).
function pinStats(pins) {
  const real = fs.statSync;
  fs.statSync = function pinnedStatSync(path, ...rest) {
    const key = String(path);
    if (!pins.has(key)) return real.call(this, path, ...rest);
    const pinned = pins.get(key);
    return pinned ?? real.call(this, join(root, 'no-such-file'), ...rest);
  };
  syncBuiltinESMExports();
  return () => {
    fs.statSync = real;
    syncBuiltinESMExports();
  };
}

async function commitRace(source, name, { walFrames }) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  process.env.VIBE_USAGE_CACHE_DIR = join(dir, 'cache');
  source.setup(dir);
  const dbPath = join(dir, source.file);
  // The stat every sync sees: the committed main file and a -wal that still
  // holds the frames (walFrames) or was truncated (an idle store).
  writeFileSync(join(dir, 'committed-main'), 'main file after the commit');
  writeFileSync(join(dir, 'committed-wal'), walFrames ? 'frames not yet in the wal-index' : '');
  const restore = pinStats(new Map([
    [dbPath, statSync(join(dir, 'committed-main'))],
    [`${dbPath}-wal`, statSync(join(dir, 'committed-wal'))],
    [`${dbPath}-journal`, null],
  ]));
  try {
    source.write(dbPath, [10]); // what a sync inside the commit window reads
    const during = await source.parse();
    source.write(dbPath, [10, 20]); // the published transaction
    const afterCommit = await source.parse();
    return { during, afterCommit };
  } finally {
    restore();
  }
}

for (const [label, source] of [['OpenCode', opencode], ['Qoder IDE', qoder], ['Antigravity', antigravity]]) {
  test(`${label}: a read inside a WAL commit is not cached, so the next sync sees 10 + 20`, { skip }, async () => {
    const { during, afterCommit } = await commitRace(source, `${label}-open-wal`, { walFrames: true });
    assert.equal(inputTokens(during), 10);
    assert.equal(afterCommit.skipped || undefined, undefined);
    assert.equal(inputTokens(afterCommit), 30);
  });

  test(`${label}: an idle store (empty WAL) is still served from the cache`, { skip }, async () => {
    const { during, afterCommit } = await commitRace(source, `${label}-idle`, { walFrames: false });
    assert.equal(inputTokens(during), 10);
    assert.equal(inputTokens(afterCommit), 10, 'second sync hit the cache entry of the first');
  });
}
