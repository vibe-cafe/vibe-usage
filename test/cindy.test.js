import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findCindyDbPaths,
  getCindyDataRoots,
} from '../src/cindy-roots.js';
import { detectInstalledTools } from '../src/tools.js';
import {
  dateFromCindyDay,
  mergeCindyHarnessUsage,
  readCindyHarnessUsage,
} from '../src/parsers/cindy-ledger.js';
import { parsers } from '../src/parsers/index.js';
import { parse as parsePi } from '../src/parsers/pi-coding-agent.js';

async function loadDatabaseSync(t) {
  try {
    return (await import('node:sqlite')).DatabaseSync;
  } catch {
    t.skip('node:sqlite is unavailable on this Node version');
    return null;
  }
}

function createUsageDb(DatabaseSync, dbPath, rows) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE daily_model_usage (
        day TEXT NOT NULL,
        agent_kind TEXT NOT NULL,
        model TEXT NOT NULL,
        cost_usd REAL DEFAULT 0 NOT NULL,
        cost_amount REAL DEFAULT 0 NOT NULL,
        cost_currency TEXT DEFAULT 'USD' NOT NULL,
        cost_is_approximate INTEGER DEFAULT 0 NOT NULL,
        input_tokens INTEGER DEFAULT 0 NOT NULL,
        output_tokens INTEGER DEFAULT 0 NOT NULL,
        cache_read_tokens INTEGER DEFAULT 0 NOT NULL,
        cache_create_tokens INTEGER DEFAULT 0 NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(day, agent_kind, model, cost_currency)
      );
    `);
    const insert = db.prepare(`
      INSERT INTO daily_model_usage (
        day, agent_kind, model, cost_currency,
        input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insert.run(
        row.day,
        row.agentKind,
        row.model,
        row.currency,
        row.input,
        row.output,
        row.cacheRead,
        row.cacheCreate,
        row.updatedAt,
      );
    }
  } finally {
    db.close();
  }
  // Non-database artifacts and backups in Cindy's user-data root must never be
  // mistaken for active owner databases.
  writeFileSync(`${dbPath}.bak`, 'not a database');
}

test('Cindy roots cover both regional editions on every desktop platform', () => {
  assert.deepEqual(
    getCindyDataRoots({}, 'darwin', '/Users/me'),
    [
      '/Users/me/Library/Application Support/CindyGlobal',
      '/Users/me/Library/Application Support/Cindy',
    ],
  );
  assert.deepEqual(
    getCindyDataRoots({ APPDATA: 'D:\\Profiles\\me\\Roaming' }, 'win32', 'C:\\Users\\me'),
    [
      win32.join('D:\\Profiles\\me\\Roaming', 'CindyGlobal'),
      win32.join('D:\\Profiles\\me\\Roaming', 'Cindy'),
    ],
  );
  assert.deepEqual(
    getCindyDataRoots({ XDG_CONFIG_HOME: '/home/me/.config-x' }, 'linux', '/home/me'),
    ['/home/me/.config-x/CindyGlobal', '/home/me/.config-x/Cindy'],
  );
});

test('Cindy ledger augments Codex and Pi without duplicating Claude transcripts', async (t) => {
  const DatabaseSync = await loadDatabaseSync(t);
  if (!DatabaseSync) return;

  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-cindy-'));
  const globalDir = join(root, 'CindyGlobal');
  const cnDir = join(root, 'Cindy');
  const emptyPiDir = join(root, 'empty-pi');
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(cnDir, { recursive: true });
  mkdirSync(emptyPiDir, { recursive: true });

  createUsageDb(DatabaseSync, join(globalDir, 'cindy-global-owner.db'), [
    {
      day: '2026-08-22', agentKind: 'claude-code', model: 'chatgpt/gpt-5.6-luna',
      currency: 'USD', input: 100, output: 10, cacheRead: 50, cacheCreate: 5,
      updatedAt: 1_787_389_329_800,
    },
    {
      day: '2026-08-22', agentKind: 'codex', model: 'chatgpt/gpt-5.6-luna',
      currency: 'CNY', input: 20, output: 2, cacheRead: 10, cacheCreate: 1,
      updatedAt: 1_787_389_329_900,
    },
    {
      day: '2026-08-22', agentKind: 'pi', model: 'anthropic/claude-sonnet-4-6',
      currency: 'USD', input: 40, output: 4, cacheRead: 20, cacheCreate: 3,
      updatedAt: 1_787_389_329_950,
    },
  ]);
  createUsageDb(DatabaseSync, join(cnDir, 'cindy-cn-owner.db'), [
    {
      day: '2026-08-22', agentKind: 'codex', model: 'chatgpt/gpt-5.6-luna',
      currency: 'USD', input: 30, output: 3, cacheRead: 15, cacheCreate: 2,
      updatedAt: 1_787_389_330_000,
    },
  ]);

  const previous = process.env.VIBE_USAGE_CINDY_DIRS;
  const previousPiDirs = process.env.VIBE_USAGE_PI_SESSION_DIRS;
  process.env.VIBE_USAGE_CINDY_DIRS = [globalDir, cnDir].join(delimiter);
  process.env.VIBE_USAGE_PI_SESSION_DIRS = emptyPiDir;
  try {
    assert.equal(findCindyDbPaths().length, 2);
    assert.ok(detectInstalledTools().some((tool) => tool.id === 'cindy'));
    assert.equal('cindy' in parsers, false);

    const codex = readCindyHarnessUsage('codex');
    assert.deepEqual(codex.sessions, []);
    assert.deepEqual(codex.buckets, [{
      source: 'codex',
      model: 'chatgpt/gpt-5.6-luna',
      project: 'unknown',
      bucketStart: new Date(2026, 7, 22).toISOString(),
      inputTokens: 53,
      outputTokens: 5,
      cachedInputTokens: 25,
      reasoningOutputTokens: 0,
      totalTokens: 58,
    }]);

    const pi = readCindyHarnessUsage('pi');
    assert.deepEqual(pi.buckets, [{
      source: 'pi-coding-agent',
      model: 'anthropic/claude-sonnet-4-6',
      project: 'unknown',
      bucketStart: new Date(2026, 7, 22).toISOString(),
      inputTokens: 43,
      outputTokens: 4,
      cachedInputTokens: 20,
      reasoningOutputTokens: 0,
      totalTokens: 47,
    }]);
    const integratedPi = await parsePi();
    assert.deepEqual(integratedPi.buckets, pi.buckets);

    assert.throws(() => readCindyHarnessUsage('claude-code'), /Unsupported Cindy harness/);
    assert.equal(codex.buckets.some((bucket) => bucket.source === 'claude-code'), false);

    const merged = mergeCindyHarnessUsage({
      buckets: [{
        source: 'codex',
        model: 'chatgpt/gpt-5.6-luna',
        project: 'unknown',
        bucketStart: new Date(2026, 7, 22).toISOString(),
        inputTokens: 7,
        outputTokens: 1,
        cachedInputTokens: 2,
        reasoningOutputTokens: 0,
        totalTokens: 8,
      }],
      sessions: [{ source: 'codex', sessionHash: 'native' }],
    }, codex);
    assert.equal(merged.buckets[0].inputTokens, 60);
    assert.equal(merged.buckets[0].outputTokens, 6);
    assert.equal(merged.buckets[0].cachedInputTokens, 27);
    assert.equal(merged.sessions.length, 1);
  } finally {
    if (previous === undefined) delete process.env.VIBE_USAGE_CINDY_DIRS;
    else process.env.VIBE_USAGE_CINDY_DIRS = previous;
    if (previousPiDirs === undefined) delete process.env.VIBE_USAGE_PI_SESSION_DIRS;
    else process.env.VIBE_USAGE_PI_SESSION_DIRS = previousPiDirs;
    rmSync(root, { recursive: true, force: true });
  }
});

test('dateFromCindyDay rejects malformed and normalized calendar dates', () => {
  assert.equal(dateFromCindyDay('2026-08-22')?.getDate(), 22);
  assert.equal(dateFromCindyDay('2026-02-30'), null);
  assert.equal(dateFromCindyDay('not-a-day'), null);
});
