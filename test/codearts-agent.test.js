import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { findCodeartsAgentDbs, resolveCodeartsAgentRoots } from '../src/codearts-roots.js';
import { parse } from '../src/parsers/codearts-agent.js';
import { parsers } from '../src/parsers/index.js';
import { TOOLS } from '../src/tools.js';

const require = createRequire(import.meta.url);
const start = Date.parse('2026-09-17T01:00:00.000Z');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* Node 20 uses the CLI. */ }

const schema = `
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  directory TEXT NOT NULL
);
CREATE TABLE message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
);
`;

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function session(id, parentId, directory) {
  return `INSERT INTO session VALUES (${sql(id)}, ${parentId == null ? 'NULL' : sql(parentId)}, ${sql(directory)});`;
}

function message(id, sessionId, time, role, extra = {}) {
  const data = JSON.stringify({ role, time: { created: time }, ...extra });
  return `INSERT INTO message VALUES (${sql(id)}, ${sql(sessionId)}, ${Number(time)}, ${Number(time)}, ${sql(data)});`;
}

function createDb(root, rows = '', { filename = 'opencode.db' } = {}) {
  mkdirSync(root, { recursive: true });
  const path = join(root, filename);
  runSql(path, `${schema}${rows}`);
  return path;
}

function runSql(path, sqlText) {
  if (!DatabaseSync) {
    execFileSync('sqlite3', [path, sqlText]);
    return;
  }
  const db = new DatabaseSync(path);
  try { db.exec(sqlText); } finally { db.close(); }
}

async function withRoots(roots, run) {
  const previous = process.env.VIBE_USAGE_CODEARTS_AGENT_DIRS;
  process.env.VIBE_USAGE_CODEARTS_AGENT_DIRS = roots.join(delimiter);
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.VIBE_USAGE_CODEARTS_AGENT_DIRS;
    else process.env.VIBE_USAGE_CODEARTS_AGENT_DIRS = previous;
  }
}

test('CodeArts Agent is registered and resolves supported store layouts', () => {
  assert.equal(typeof parsers['codearts-agent'], 'function');
  assert.equal(TOOLS.find(tool => tool.id === 'codearts-agent')?.name, 'CodeArts Agent');
  assert.deepEqual(
    resolveCodeartsAgentRoots({}, '/home/test'),
    [join('/home/test', '.codeartsdoer', 'codearts-data')],
  );
  const overrideA = join(tmpdir(), 'codearts-a');
  const overrideB = join(tmpdir(), 'codearts-b');
  assert.deepEqual(
    resolveCodeartsAgentRoots({
      VIBE_USAGE_CODEARTS_AGENT_DIRS: `${overrideA}${delimiter}${overrideB}`,
    }, '/unused'),
    [overrideA, overrideB],
  );

  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codearts-agent-layout-'));
  try {
    const dataRoot = join(root, 'codearts-data');
    const db = createDb(dataRoot);
    assert.deepEqual(findCodeartsAgentDbs({
      env: { VIBE_USAGE_CODEARTS_AGENT_DIRS: [root, dataRoot, db].join(delimiter) },
    }), [realpathSync(db)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CodeArts Agent counts child calls but folds child timing into one human session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codearts-agent-'));
  try {
    createDb(root, `
      ${session('root', null, 'C:\\work\\root-project')}
      ${session('child', 'root', 'C:\\work\\root-project')}
      ${message('u1', 'root', start, 'user')}
      ${message('a1', 'root', start + 1_000, 'assistant', {
        modelID: 'GLM-5.2',
        path: { root: 'C:\\work\\root-project' },
        tokens: { input: 10, output: 3, reasoning: 2, cache: { read: 6, write: 2 } },
      })}
      ${message('child-prompt', 'child', start + 2_000, 'user')}
      ${message('child-reply', 'child', start + 3_000, 'assistant', {
        model: { modelID: 'GLM-5.2' },
        tokens: { input: 5, output: 4, reasoning: 3, cache: { read: 1, write: 0 } },
      })}
    `);

    const result = await withRoots([root], parse);
    assert.equal(result.skipped, undefined);
    assert.equal(result.buckets.length, 1);
    assert.deepEqual(result.buckets[0], {
      source: 'codearts-agent',
      model: 'GLM-5.2',
      project: 'root-project',
      bucketStart: '2026-09-17T01:00:00.000Z',
      inputTokens: 15,
      outputTokens: 7,
      cachedInputTokens: 7,
      reasoningOutputTokens: 5,
      cacheCreation5mTokens: 2,
      cacheCreation1hTokens: 0,
      totalTokens: 29,
    });
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].project, 'root-project');
    assert.equal(result.sessions[0].messageCount, 4);
    assert.equal(result.sessions[0].userMessageCount, 1);
    // Model time, one reply per assistant event from the event before it: the
    // root reply (0 → 1 s), the folded child prompt (1 → 2 s) and the child
    // reply (2 → 3 s).
    assert.equal(result.sessions[0].activeSeconds, 3);
    assert.equal(result.sessions[0].firstMessageAt, '2026-09-17T01:00:00.000Z');
    assert.equal(result.sessions[0].lastMessageAt, '2026-09-17T01:00:03.000Z');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CodeArts Agent terminates cyclic ancestry and treats orphans as roots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codearts-agent-'));
  try {
    createDb(root, `
      ${session('orphan', 'missing-parent', '/work/orphan')}
      ${session('cycle-a', 'cycle-b', '/work/cycle-a')}
      ${session('cycle-b', 'cycle-a', '/work/cycle-b')}
      ${message('orphan-user', 'orphan', start, 'user')}
      ${message('orphan-reply', 'orphan', start + 1_000, 'assistant', {
        modelID: 'model', tokens: { input: 3 },
      })}
      ${message('cycle-user', 'cycle-a', start + 2_000, 'user')}
      ${message('cycle-reply', 'cycle-b', start + 3_000, 'assistant', {
        modelID: 'model', tokens: { output: 2 },
      })}
    `);

    const result = await withRoots([root], parse);
    assert.equal(result.buckets.reduce((sum, item) => sum + item.inputTokens, 0), 3);
    assert.equal(result.buckets.reduce((sum, item) => sum + item.outputTokens, 0), 2);
    assert.deepEqual(
      result.sessions.map(item => item.project).sort(),
      ['cycle-a', 'orphan'],
    );
    assert.deepEqual(
      result.sessions.map(item => item.messageCount).sort(),
      [1, 2],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CodeArts Agent accepts model/timestamp variants and cache-only usage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codearts-agent-'));
  try {
    createDb(root, `
      ${session('s1', null, '/work/project')}
      ${message('u1', 's1', start, 'user')}
      INSERT INTO message VALUES ('a1', 's1', ${Math.floor((start + 1_000) / 1000)}, ${start + 1_000},
        '{"role":"assistant","modelId":"glm-5.3-flash","tokens":{"cache":{"write":9}}}');
      ${message('a2', 's1', start + 2_000, 'assistant', {
        model: { modelId: 'deepseek-v4-flash-0731' },
        tokens: { reasoning: 4 },
      })}
      ${message('zero', 's1', start + 3_000, 'assistant', {
        modelID: 'ignored-zero', tokens: { input: 0, output: 0 },
      })}
    `);

    const result = await withRoots([root], parse);
    const byModel = Object.fromEntries(result.buckets.map(bucket => [bucket.model, bucket]));
    assert.equal(byModel['glm-5.3-flash'].cacheCreation5mTokens, 9);
    assert.equal(byModel['glm-5.3-flash'].bucketStart, '2026-09-17T01:00:00.000Z');
    assert.equal(byModel['deepseek-v4-flash-0731'].reasoningOutputTokens, 4);
    assert.equal(byModel['ignored-zero'], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CodeArts Agent de-duplicates copied, richer and symlinked databases', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codearts-agent-'));
  try {
    const first = join(root, 'first');
    const second = join(root, 'second');
    const baseRows = `
      ${session('s1', null, '/work/project')}
      ${message('u1', 's1', start, 'user')}
    `;
    createDb(first, `${baseRows}${message('a1', 's1', start + 1_000, 'assistant', {
      modelID: 'model', tokens: { input: 1, output: 1 },
    })}`);
    createDb(second, `${baseRows}${message('a1', 's1', start + 1_000, 'assistant', {
      modelID: 'model', tokens: { input: 9, output: 2 },
    })}`);
    const alias = join(root, 'alias');
    symlinkSync(second, alias, 'dir');

    const result = await withRoots([first, second, alias], parse);
    assert.equal(findCodeartsAgentDbs({
      env: { VIBE_USAGE_CODEARTS_AGENT_DIRS: [second, alias].join(delimiter) },
    }).length, 1);
    assert.equal(result.buckets[0].inputTokens, 9);
    assert.equal(result.buckets[0].outputTokens, 2);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].messageCount, 2);
    assert.equal(result.sessions[0].userMessageCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CodeArts Agent reads an active WAL database without mutating the source', {
  skip: !DatabaseSync && 'requires node:sqlite to keep a live writer open',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codearts-agent-wal-'));
  const path = join(root, 'opencode.db');
  let db;
  try {
    db = new DatabaseSync(path);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; ${schema}
      ${session('s1', null, '/work/project')}
      ${message('u1', 's1', start, 'user')}
      ${message('a1', 's1', start + 1_000, 'assistant', {
        modelID: 'model', tokens: { input: 7, output: 3 },
      })}`);
    assert.equal(existsSync(`${path}-wal`), true);

    const result = await withRoots([root], parse);
    assert.equal(result.buckets[0].inputTokens, 7);
    assert.equal(existsSync(`${path}-wal`), true);
  } finally {
    try { db?.close(); } catch { /* best-effort fixture cleanup */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('CodeArts Agent preserves source state on corrupt or incompatible discovered stores', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codearts-agent-'));
  try {
    const valid = join(root, 'valid');
    const corrupt = join(root, 'corrupt');
    const incompatible = join(root, 'incompatible');
    createDb(valid, `${session('s1', null, '/work/project')}${message('u1', 's1', start, 'user')}`);
    mkdirSync(corrupt);
    writeFileSync(join(corrupt, 'opencode.db'), 'not sqlite');
    mkdirSync(incompatible);
    runSql(join(incompatible, 'opencode.db'), 'CREATE TABLE message (id TEXT);');

    for (const broken of [corrupt, incompatible]) {
      const result = await withRoots([valid, broken], parse);
      assert.equal(result.skipped, true);
      assert.deepEqual(result.buckets, []);
      assert.deepEqual(result.sessions, []);
      assert.ok(result.warnings.length > 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CodeArts Agent query selects only allow-listed metadata', async () => {
  const source = await import('node:fs/promises')
    .then(fs => fs.readFile(new URL('../src/parsers/codearts-agent.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /SELECT\s+\*/i);
  assert.doesNotMatch(source, /json_extract\(m\.data, '\$\.(?:content|tools|error|cost)'\)/);
  assert.doesNotMatch(source, /\b(?:part|account|event)\b\s+AS\s+/i);
  assert.match(source, /json_extract\(m\.data, '\$\.tokens\.cache\.read'\)/);
});

test('CodeArts Agent never surfaces prompt/tool content in its parsed output', async () => {
  // The source-text regex above only catches a query that *names* a banned
  // column. It cannot catch a query that renames its way past the regex
  // (e.g. `SELECT m.data AS payload`) and hands the whole JSON blob through.
  // This fixture plants a sentinel inside both a top-level field and a
  // nested `parts` array the way a real message body would carry it, then
  // asserts the sentinel never reaches the parsed result.
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codearts-agent-privacy-'));
  const CANARY = 'CANARY_PROMPT_TEXT_DO_NOT_LEAK';
  try {
    createDb(root, `
      ${session('s1', null, '/work/project')}
      ${message('u1', 's1', start, 'user', { content: CANARY })}
      ${message('a1', 's1', start + 1_000, 'assistant', {
        modelID: 'model',
        tokens: { input: 4, output: 2 },
        content: CANARY,
        parts: [{ type: 'text', text: CANARY }],
      })}
    `);

    const result = await withRoots([root], parse);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, new RegExp(CANARY));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
