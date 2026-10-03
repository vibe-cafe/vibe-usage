import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = new URL('../', import.meta.url);
const probe = `
  import os from 'node:os';
  import { syncBuiltinESMExports } from 'node:module';
  os.homedir = () => process.env.VIBE_USAGE_TEST_HERMES_USER;
  syncBuiltinESMExports();
  Object.defineProperty(process, 'platform', { value: process.env.VIBE_USAGE_TEST_PLATFORM });
  import { delimiter } from 'node:path';
  const { parse } = await import('./src/parsers/hermes.js');
  const { detectInstalledTools } = await import('./src/tools.js');
  const extraRoots = (process.env.VIBE_USAGE_TEST_HERMES_EXTRA || '')
    .split(delimiter)
    .filter(Boolean);
  let result;
  try {
    result = await parse({ extraRoots });
  } catch (error) {
    result = { error: { code: error.code, message: error.message } };
  }
  console.log(JSON.stringify({
    ...result,
    detected: detectInstalledTools({
      extraRoots: extraRoots.length ? { hermes: extraRoots } : undefined,
    }).some(tool => tool.id === 'hermes'),
  }));
`;

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-hermes-discovery-'));
  const userDir = join(root, 'user');
  mkdirSync(userDir);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  async function writeDb(dir, extraSql = '') {
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'state.db');
    const sql = `
      CREATE TABLE sessions (
        id TEXT, model TEXT, started_at REAL, input_tokens INTEGER,
        output_tokens INTEGER, cache_read_tokens INTEGER, reasoning_tokens INTEGER,
        cache_write_tokens INTEGER, source TEXT
      );
      CREATE TABLE messages (session_id TEXT, role TEXT, timestamp REAL);
      INSERT INTO sessions VALUES ('desktop-session', 'test-model', 1788764700, 100, 20, 0, 5, 0, 'api_server');
      INSERT INTO messages VALUES ('desktop-session', 'user', 1788764700), ('desktop-session', 'assistant', 1788764720);
      ${extraSql}
    `;
    let DatabaseSync;
    try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* Node 20 uses sqlite3. */ }
    if (DatabaseSync) {
      const db = new DatabaseSync(dbPath);
      try { db.exec(sql); } finally { db.close(); }
    } else {
      execFileSync('sqlite3', [dbPath, sql]);
    }
  }

  function run(platform, overrides = {}) {
    const env = { ...process.env };
    delete env.HERMES_HOME;
    delete env.LOCALAPPDATA;
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...env,
        VIBE_USAGE_TEST_HERMES_USER: userDir,
        VIBE_USAGE_TEST_PLATFORM: platform,
        ...overrides,
      },
    }));
  }

  return { root, userDir, writeDb, run };
}

function assertUsage(result, project = 'default') {
  assert.equal(result.detected, true);
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].project, project);
  assert.equal(result.buckets[0].totalTokens, 120);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].messageCount, 2);
}

test('Hermes Desktop default macOS store is parsed and detected', async (t) => {
  const { userDir, writeDb, run } = await fixture(t);
  await writeDb(join(userDir, '.hermes'));
  assertUsage(run('darwin'));
});

test('Hermes Desktop native Windows store is parsed without HERMES_HOME', async (t) => {
  const { root, writeDb, run } = await fixture(t);
  const localAppData = join(root, 'relocated-local-app-data');
  await writeDb(join(localAppData, 'hermes'));
  assertUsage(run('win32', { LOCALAPPDATA: localAppData }));
});

test('Hermes Windows default works when LOCALAPPDATA is absent', async (t) => {
  const { userDir, writeDb, run } = await fixture(t);
  await writeDb(join(userDir, 'AppData', 'Local', 'hermes'));
  assertUsage(run('win32'));
});

test('Hermes Windows retains the legacy store when the native root is absent', async (t) => {
  const { userDir, writeDb, run } = await fixture(t);
  await writeDb(join(userDir, '.hermes'));
  assertUsage(run('win32'));
});

test('Hermes Windows follows the native root when both layouts exist', async (t) => {
  const { userDir, writeDb, run } = await fixture(t);
  await writeDb(join(userDir, '.hermes', 'profiles', 'legacy'));
  await writeDb(join(userDir, 'AppData', 'Local', 'hermes'));
  assertUsage(run('win32'));
});

test('Hermes custom home is used by parsing and installed-tool detection', async (t) => {
  const { root, userDir, writeDb, run } = await fixture(t);
  const customHome = join(root, 'custom-home');
  await writeDb(customHome);
  await writeDb(join(userDir, 'AppData', 'Local', 'hermes', 'profiles', 'other'));
  assertUsage(run('win32', { HERMES_HOME: customHome }));
});

test('Hermes named profiles are detected even without a default database', async (t) => {
  const { userDir, writeDb, run } = await fixture(t);
  await writeDb(join(userDir, '.hermes', 'profiles', 'work'));
  assertUsage(run('darwin'), 'work');
});

test('Hermes is absent when neither the default nor profile databases exist', async (t) => {
  const { run } = await fixture(t);
  const result = run('win32');
  assert.equal(result.detected, false);
  assert.deepEqual(result.buckets, []);
  assert.deepEqual(result.sessions, []);
});

// Real filesystem permission failures exercise both exists/stat and directory
// reads. Windows ACLs do not implement chmod(0), so these cases run on POSIX.
for (const location of ['home', 'profiles', 'profile']) {
  test(`Hermes rejects incomplete discovery when ${location} is unreadable`, {
    skip: process.platform === 'win32' ? 'POSIX chmod fixture: Windows requires a separate ACL denial test'
    : process.getuid?.() === 0 && 'POSIX root bypasses chmod denial; run as an unprivileged user',
  }, async (t) => {
    const { userDir, writeDb, run } = await fixture(t);
    const home = join(userDir, '.hermes');
    const profiles = join(home, 'profiles');
    const profile = join(profiles, 'work');
    await writeDb(home);
    await writeDb(profile);
    const blocked = { home, profiles, profile }[location];
    chmodSync(blocked, 0);
    try {
      const result = run('darwin');
      assert.equal(result.error?.code, 'EACCES');
      assert.equal(result.buckets, undefined);
      assert.equal(result.sessions, undefined);
    } finally {
      chmodSync(blocked, 0o700);
    }
  });
}

test('Hermes does not fall back to legacy data when the Windows native root is unreadable', {
  skip: process.platform === 'win32' ? 'POSIX chmod fixture: Windows requires a separate ACL denial test'
    : process.getuid?.() === 0 && 'POSIX root bypasses chmod denial; run as an unprivileged user',
}, async (t) => {
  const { userDir, writeDb, run } = await fixture(t);
  await writeDb(join(userDir, '.hermes'));
  const localAppData = join(userDir, 'AppData', 'Local');
  await writeDb(join(localAppData, 'hermes'));
  chmodSync(localAppData, 0);
  try {
    assert.equal(run('win32').error?.code, 'EACCES');
  } finally {
    chmodSync(localAppData, 0o700);
  }
});

test('Hermes rejects a failed messages query instead of reporting partial success', async (t) => {
  const { userDir, writeDb, run } = await fixture(t);
  await writeDb(join(userDir, '.hermes'), 'DROP TABLE messages;');
  const result = run('darwin');
  assert.match(result.error?.message || '', /no such table: messages/);
  assert.equal(result.buckets, undefined);
  assert.equal(result.sessions, undefined);
  assert.equal(result.detected, true);
});

test('configured Hermes extra home is discovered alongside the default home', async (t) => {
  const { root, userDir, writeDb, run } = await fixture(t);
  await writeDb(join(userDir, '.hermes'));
  const extra = join(root, 'extra-hermes');
  await writeDb(
    join(extra, 'profiles', 'work'),
    "UPDATE sessions SET id = 'extra-session'; UPDATE messages SET session_id = 'extra-session';",
  );
  const result = run('darwin', { VIBE_USAGE_TEST_HERMES_EXTRA: extra });
  assert.equal(result.detected, true);
  assert.equal(result.skipped, undefined);
  const projects = result.buckets.map(bucket => bucket.project).sort();
  assert.deepEqual(projects, ['default', 'work']);
  assert.equal(result.buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0), 240);
  assert.equal(result.sessions.length, 2);
});

test('Hermes extra home equal to the default home is not double-counted', async (t) => {
  const { userDir, writeDb, run } = await fixture(t);
  const home = join(userDir, '.hermes');
  await writeDb(home);
  const result = run('darwin', { VIBE_USAGE_TEST_HERMES_EXTRA: home });
  assertUsage(result);
  assert.equal(result.skipped, undefined);
});

test('Hermes extra home equal to HERMES_HOME is not double-counted', async (t) => {
  const { root, writeDb, run } = await fixture(t);
  const home = join(root, 'custom-home');
  await writeDb(home);
  const result = run('darwin', {
    HERMES_HOME: home,
    VIBE_USAGE_TEST_HERMES_EXTRA: home,
  });
  assertUsage(result);
  assert.equal(result.skipped, undefined);
});

test('a missing configured Hermes home skips the sync instead of reporting empty success', async (t) => {
  const { root, userDir, writeDb, run } = await fixture(t);
  await writeDb(join(userDir, '.hermes'));
  const missing = join(root, 'missing-hermes');
  const result = run('darwin', { VIBE_USAGE_TEST_HERMES_EXTRA: missing });
  assert.equal(result.skipped, true);
  assert.deepEqual(result.buckets, []);
  assert.deepEqual(result.sessions, []);
  assert.match(result.warnings?.[0] || '', /额外根目录不可用/);
});

test('an unreadable configured Hermes home skips the sync', {
  skip: process.platform === 'win32' ? 'POSIX chmod fixture: Windows requires a separate ACL denial test'
    : process.getuid?.() === 0 && 'POSIX root bypasses chmod denial; run as an unprivileged user',
}, async (t) => {
  const { root, userDir, writeDb, run } = await fixture(t);
  await writeDb(join(userDir, '.hermes'));
  const extra = join(root, 'locked-hermes');
  await writeDb(extra);
  chmodSync(extra, 0);
  try {
    const result = run('darwin', { VIBE_USAGE_TEST_HERMES_EXTRA: extra });
    assert.equal(result.skipped, true);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.buckets, []);
    assert.match(result.warnings?.[0] || '', /额外根目录读取失败/);
  } finally {
    chmodSync(extra, 0o700);
  }
});
