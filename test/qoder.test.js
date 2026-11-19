import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { parseQoder, parseQoderCn } from '../src/parsers/qoder.js';
import { findQoderDataDirs, getQoderDbPath, getQoderProjectsDir } from '../src/qoder-roots.js';

const parserCacheDir = mkdtempSync(join(tmpdir(), 'vibe-parser-cache-test-'));
const previousParserCacheDir = process.env.VIBE_USAGE_CACHE_DIR;
process.env.VIBE_USAGE_CACHE_DIR = parserCacheDir;
test.after(() => {
  if (previousParserCacheDir === undefined) delete process.env.VIBE_USAGE_CACHE_DIR;
  else process.env.VIBE_USAGE_CACHE_DIR = previousParserCacheDir;
  rmSync(parserCacheDir, { recursive: true, force: true });
});

const require = createRequire(import.meta.url);

const ENV_KEYS = [
  'VIBE_USAGE_QODER_PROJECTS',
  'VIBE_USAGE_QODER_DB',
  'VIBE_USAGE_QODER_CN_PROJECTS',
  'VIBE_USAGE_QODER_CN_DB',
  'QODER_CONFIG_DIR',
  'QODERCN_CONFIG_DIR',
  'QODER_HOME',
  'QODER_CN_HOME',
];

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
}

const SESSION = 'c5def458-9572-4e68-97c8-aa9791ba9502';
const CWD = '/Users/jiangbian/Documents/projects/demo-app';

// Shapes copied from a real Qoder CLI 1.1.42 / desktop app 0.1.6 transcript
// (2026-09-04); prompt text removed.
function record(type, extra) {
  return JSON.stringify({
    type,
    sessionId: SESSION,
    cwd: CWD,
    userType: 'external',
    entrypoint: 'cli',
    version: '1.1.42',
    isSidechain: false,
    ...extra,
  });
}

// Credit-billed usage as Qoder writes it: every token field is 0.
function creditUsage(credits, billable = true) {
  return {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: 'standard',
    credits,
    original_credits: credits,
    billable,
    request_id: 'ff8ffcf2-e225-4590-a184-f21866407541',
    context_usage_ratio: 0.099925,
  };
}

function writeTranscript(projectsDir, { withTokens = false } = {}) {
  const slug = '-Users-jiangbian-Documents-projects-demo-app';
  const dir = join(projectsDir, slug);
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'workspace-directories', sessionId: SESSION, directories: [CWD] }),
    JSON.stringify({ type: 'runtime-config', sessionId: SESSION, model: 'efficient', timestamp: 1788453798496 }),
    record('user', {
      uuid: 'u1',
      timestamp: '2026-09-03T16:43:22.740Z',
      humanInput: { text: 'hi', mode: 'prompt' },
      origin: { kind: 'human' },
      message: { role: 'user', content: 'hi' },
    }),
    JSON.stringify({ type: 'attachment', sessionId: SESSION, timestamp: '2026-09-03T16:43:22.740Z', attachment: {} }),
    // One assistant message written as several lines; only the last carries usage.
    record('assistant', {
      uuid: 'a1',
      timestamp: '2026-09-03T16:43:25.697Z',
      message: { id: 'resp_1', role: 'assistant', model: 'efficient', content: [{ type: 'thinking' }] },
    }),
    record('assistant', {
      uuid: 'a2',
      timestamp: '2026-09-03T16:43:25.697Z',
      message: {
        id: 'resp_1',
        role: 'assistant',
        model: 'efficient',
        content: [{ type: 'text', text: 'ok' }],
        usage: withTokens
          ? { ...creditUsage(0.17894), input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 9500, output_tokens: 40 }
          : creditUsage(0.17894107142857144),
      },
    }),
    // Tool result comes back as a user-role record: not a human prompt.
    record('user', {
      uuid: 'u2',
      timestamp: '2026-09-03T16:43:26.000Z',
      toolUseResult: { isHardFailure: false },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
    }),
    record('user', {
      uuid: 'u3',
      timestamp: '2026-09-03T16:50:00.000Z',
      humanInput: { text: 'again', mode: 'prompt' },
      message: { role: 'user', content: 'again' },
    }),
    record('assistant', {
      uuid: 'a3',
      timestamp: '2026-09-03T16:50:03.000Z',
      message: { id: 'resp_2', role: 'assistant', model: 'auto', content: [{ type: 'text', text: 'ok' }], usage: creditUsage(4.2203, false) },
    }),
    JSON.stringify({ type: 'active-leaf', sessionId: SESSION, leafUuid: 'a3', timestamp: 1788455350190 }),
    'not json',
  ];
  writeFileSync(join(dir, `${SESSION}.jsonl`), lines.join('\n') + '\n');

  // Sub-agent transcript nested under <session>/subagents/.
  const subDir = join(dir, SESSION, 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, 'agent-x1.jsonl'), [
    record('assistant', {
      uuid: 's1',
      timestamp: '2026-09-03T16:50:20.000Z',
      message: { id: 'resp_sub', role: 'assistant', model: 'auto', content: [{ type: 'text', text: 'sub' }], usage: creditUsage(1.5) },
    }),
  ].join('\n') + '\n');
}

function sqliteAvailable() {
  try {
    const mod = require('node:sqlite');
    return Boolean(mod && mod.DatabaseSync);
  } catch {
    return false;
  }
}

function writeIdeDb(dbPath, { withSessionTable = true } = {}) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`create table if not exists chat_message (
    id varchar(64) primary key, session_id VARCHAR(64), request_id VARCHAR(64), role VARCHAR(64),
    content text, summary text, summary_modified INTEGER, summary_trigger INTEGER DEFAULT 0,
    tool_result text, token_info text, model_info text, extra text DEFAULT '', gmt_create INTEGER)`);
  if (withSessionTable) {
    db.exec(`create table if not exists chat_session (
      session_id varchar(64) primary key, user_id VARCHAR(64), user_name varchar(64), session_title varchar(256),
      project_id varchar(64), project_uri varchar(512), project_name varchar(64), gmt_create INTEGER,
      gmt_modified INTEGER, preferred_model_info TEXT DEFAULT '')`);
    db.prepare(`insert into chat_session (session_id, user_id, session_title, project_id, project_uri, project_name)
      values (?, ?, ?, ?, ?, ?)`).run('s1', 'u', 't', 'p', 'file:///Users/jiangbian/Documents/projects/ide%20demo', 'ide demo');
  }
  const insert = db.prepare(`insert into chat_message (id, session_id, request_id, role, content, token_info, model_info, extra, gmt_create)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // Rows copied from a real Qoder IDE 1.28.0 local.db (2026-09-04), content removed.
  insert.run('m1', 's1', 'r1', 'user', 'PROMPT TEXT MUST NOT BE READ', '', '', '{"agent_version":"7"}', 1788454775438);
  insert.run('m2', 's1', 'r1', 'assistant', 'REPLY TEXT', '{"prompt_tokens":16340,"completion_tokens":83,"cached_tokens":0,"max_input_tokens":200000}', '{"model_key":"auto"}', '{"agent_version":"7"}', 1788454777997);
  insert.run('m3', 's1', 'r1', 'tool', '', '', '', '{"agent_version":"7"}', 1788454778044);
  insert.run('m4', 's1', 'r1', 'assistant', 'REPLY TEXT', '{"prompt_tokens":18756,"completion_tokens":112,"cached_tokens":16334,"max_input_tokens":200000}', '{"model_key":"auto"}', '{"agent_version":"7"}', 1788454780945);
  // Placeholder assistant row without token info: timing only.
  insert.run('m5', 's1', 'r2', 'assistant', '', '', '{"model_key":"auto"}', '', 1788454790000);
  db.close();
}

test('qoder: credit-billed transcripts yield sessions but no token buckets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-qoder-test-'));
  try {
    const projectsDir = join(root, 'projects');
    writeTranscript(projectsDir);
    await withEnv({ VIBE_USAGE_QODER_PROJECTS: projectsDir, VIBE_USAGE_QODER_DB: join(root, 'missing.db') }, async () => {
      const result = await parseQoder();
      assert.equal(result.skipped, false);
      assert.deepEqual(result.warnings, []);
      // All token fields are 0 in Qoder transcripts and credits are not collected.
      assert.deepEqual(result.buckets, []);

      assert.equal(result.sessions.length, 1);
      const session = result.sessions[0];
      assert.equal(session.source, 'qoder');
      assert.equal(session.project, 'demo-app');
      // Two human prompts; the tool_result user record is not one.
      assert.equal(session.userMessageCount, 2);
      // 2 user + 3 assistant lines in the main file + 1 sub-agent assistant line.
      assert.equal(session.messageCount, 6);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('qoder: transcript token fields are counted when a build reports them, once per message id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-qoder-tokens-test-'));
  try {
    const projectsDir = join(root, 'projects');
    writeTranscript(projectsDir, { withTokens: true });
    await withEnv({ VIBE_USAGE_QODER_PROJECTS: projectsDir, VIBE_USAGE_QODER_DB: join(root, 'missing.db') }, async () => {
      const result = await parseQoder();
      assert.equal(result.buckets.length, 1);
      const b = result.buckets[0];
      assert.equal(b.source, 'qoder');
      // Routing tiers are namespaced so they never collide with a priced model id.
      assert.equal(b.model, 'qoder-efficient');
      assert.equal(b.project, 'demo-app');
      assert.equal(b.inputTokens, 1200 + 300);
      assert.equal(b.cachedInputTokens, 9500);
      assert.equal(b.outputTokens, 40);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('qoder-cn: same transcript shape under its own source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-qoder-cn-test-'));
  try {
    const projectsDir = join(root, 'projects');
    writeTranscript(projectsDir);
    await withEnv({ VIBE_USAGE_QODER_CN_PROJECTS: projectsDir, VIBE_USAGE_QODER_CN_DB: join(root, 'missing.db') }, async () => {
      const result = await parseQoderCn();
      assert.equal(result.sessions.length, 1);
      assert.ok(result.sessions.every(s => s.source === 'qoder-cn'));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('qoder: IDE local.db yields real tokens with cached input split out', { skip: !sqliteAvailable() && 'node:sqlite unavailable' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-qoder-ide-test-'));
  try {
    const dbPath = join(root, 'local.db');
    writeIdeDb(dbPath);
    await withEnv({ VIBE_USAGE_QODER_PROJECTS: join(root, 'no-projects'), VIBE_USAGE_QODER_DB: dbPath }, async () => {
      const result = await parseQoder();
      assert.equal(result.skipped, false);
      assert.equal(result.buckets.length, 1);
      const b = result.buckets[0];
      assert.equal(b.source, 'qoder');
      // `auto` bare would match the Cursor `auto` pricing entry; namespaced instead.
      assert.equal(b.model, 'qoder-auto');
      assert.equal(b.project, 'ide demo');
      assert.equal(b.inputTokens, (16340 - 0) + (18756 - 16334));
      assert.equal(b.cachedInputTokens, 0 + 16334);
      assert.equal(b.outputTokens, 83 + 112);
      assert.equal(result.sessions.length, 1);
      assert.equal(result.sessions[0].userMessageCount, 1);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('qoder: IDE local.db without chat_session table still parses', { skip: !sqliteAvailable() && 'node:sqlite unavailable' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-qoder-ide-old-test-'));
  try {
    const dbPath = join(root, 'local.db');
    writeIdeDb(dbPath, { withSessionTable: false });
    await withEnv({ VIBE_USAGE_QODER_PROJECTS: join(root, 'no-projects'), VIBE_USAGE_QODER_DB: dbPath }, async () => {
      const result = await parseQoder();
      assert.equal(result.buckets.length, 1);
      assert.equal(result.buckets[0].project, 'unknown');
      assert.equal(result.buckets[0].outputTokens, 195);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('qoder: an unreadable IDE db returns skipped instead of throwing', { skip: !sqliteAvailable() && 'node:sqlite unavailable' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-qoder-ide-bad-test-'));
  try {
    const dbPath = join(root, 'local.db');
    writeFileSync(dbPath, 'this is not a sqlite database');
    await withEnv({ VIBE_USAGE_QODER_PROJECTS: join(root, 'no-projects'), VIBE_USAGE_QODER_DB: dbPath }, async () => {
      const result = await parseQoder();
      assert.equal(result.skipped, true);
      assert.deepEqual(result.buckets, []);
      assert.ok(result.warnings.length >= 1);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('qoder roots: env overrides and detection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-qoder-roots-test-'));
  try {
    await withEnv({ QODER_CONFIG_DIR: join(root, 'cfg'), QODERCN_CONFIG_DIR: join(root, 'cfg-cn'), QODER_HOME: join(root, 'ide-home') }, async () => {
      assert.equal(getQoderProjectsDir('qoder'), join(root, 'cfg', 'projects'));
      assert.equal(getQoderProjectsDir('qoder-cn'), join(root, 'cfg-cn', 'projects'));
      assert.equal(getQoderDbPath('qoder'), join(root, 'ide-home', 'cache', 'db', 'local.db'));
      assert.deepEqual(findQoderDataDirs('qoder'), []);
      mkdirSync(join(root, 'cfg', 'projects'), { recursive: true });
      assert.deepEqual(findQoderDataDirs('qoder'), [join(root, 'cfg', 'projects')]);
    });
    await withEnv({}, async () => {
      // Defaults: ~/.qoder vs ~/.qoder-cn, Qoder vs QoderCN.
      assert.ok(getQoderProjectsDir('qoder').endsWith(join('.qoder', 'projects')));
      assert.ok(getQoderProjectsDir('qoder-cn').endsWith(join('.qoder-cn', 'projects')));
      assert.ok(getQoderDbPath('qoder').includes(join('Qoder', 'SharedClientCache')));
      assert.ok(getQoderDbPath('qoder-cn').includes(join('QoderCN', 'SharedClientCache')));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
