import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Claude Desktop Cowork on Windows. The classic installer keeps its data in
// %APPDATA%\Claude; the MSIX (Store) build's %APPDATA% writes land in its
// package (%LOCALAPPDATA%\Packages\Claude_<suffix>\LocalCache\Roaming\Claude)
// or, after the 2026-11 update, %LOCALAPPDATA%\Claude-Data\claude_<suffix>.
// Each case runs in a child process with process.platform forced to win32 and
// os.homedir() pointed at a synthetic user directory, so nothing touches the
// real machine (same pattern as test/hermes-discovery.test.js).

const repo = new URL('../', import.meta.url);
const probe = `
  import os from 'node:os';
  import { syncBuiltinESMExports } from 'node:module';
  os.homedir = () => process.env.VIBE_USAGE_TEST_USER;
  syncBuiltinESMExports();
  Object.defineProperty(process, 'platform', { value: process.env.VIBE_USAGE_TEST_PLATFORM });
  const { findClaudeDesktopRoots } = await import('./src/claude-roots.js');
  const { parse } = await import('./src/parsers/claude-code.js');
  const { detectInstalledTools } = await import('./src/tools.js');
  const result = await parse();
  console.log(JSON.stringify({
    desktopRoots: findClaudeDesktopRoots(),
    buckets: result.buckets,
    sessions: result.sessions,
    skipped: !!result.skipped,
    warnings: result.warnings || [],
    detected: detectInstalledTools().some((tool) => tool.id === 'claude-code'),
  }));
`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-claude-desktop-win-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const user = join(root, 'user');
  const appData = join(user, 'AppData', 'Roaming');
  const localAppData = join(user, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });

  const dataDirs = {
    classic: join(appData, 'Claude'),
    msix: join(localAppData, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude'),
    claudeData: join(localAppData, 'Claude-Data', 'claude_pzs8sxrjxfjjc'),
  };

  // A Cowork session's private Claude Code root, at the depth Claude Desktop
  // uses: local-agent-mode-sessions/<account>/<org>/<session>/.claude.
  function coworkRoot(dataDir, session = 'local_session') {
    return join(dataDir, 'local-agent-mode-sessions', 'account', 'org', session, '.claude');
  }

  function writeSession(claudeRoot, sessionId, calls) {
    const dir = join(claudeRoot, 'projects', '-sessions-cowork-proj');
    mkdirSync(dir, { recursive: true });
    const lines = [
      { type: 'user', timestamp: '2026-11-10T10:00:00.000Z', cwd: '/sessions/proj' },
      ...calls.map(({ id, input, output, at = '2026-11-10T10:01:00.000Z' }) => ({
        type: 'assistant',
        timestamp: at,
        cwd: '/sessions/proj',
        requestId: `req_${id}`,
        message: {
          id: `msg_${id}`,
          model: 'claude-opus-4-8',
          usage: { input_tokens: input, output_tokens: output },
        },
      })),
    ];
    writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  function run({ platform = 'win32', env: overrides = {} } = {}) {
    const env = { ...process.env };
    for (const name of [
      'VIBE_USAGE_CLAUDE_DIRS',
      'VIBE_USAGE_CLAUDE_DESKTOP_DIRS',
      'CLAUDE_CONFIG_DIR',
      'XDG_CONFIG_HOME',
    ]) delete env[name];
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...env,
        HOME: user,
        USERPROFILE: user,
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
        VIBE_USAGE_CACHE_DIR: join(root, 'cache'),
        VIBE_USAGE_TEST_USER: user,
        VIBE_USAGE_TEST_PLATFORM: platform,
        ...overrides,
      },
    }));
  }

  return { root, user, appData, localAppData, dataDirs, coworkRoot, writeSession, run };
}

function totals(result) {
  return result.buckets.reduce(
    (sum, b) => ({ input: sum.input + b.inputTokens, output: sum.output + b.outputTokens }),
    { input: 0, output: 0 },
  );
}

test('Windows MSIX Cowork sessions under Packages\\Claude_<suffix>\\LocalCache are parsed', (t) => {
  const { dataDirs, coworkRoot, writeSession, run } = fixture(t);
  const cowork = coworkRoot(dataDirs.msix);
  writeSession(cowork, 'cowork-session', [{ id: 'a', input: 100, output: 10 }]);

  const result = run();
  assert.deepEqual(result.desktopRoots, [cowork]);
  assert.equal(result.skipped, false);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(totals(result), { input: 100, output: 10 });
  assert.equal(result.buckets[0].source, 'claude-code');
  assert.equal(result.sessions.length, 1);
  assert.equal(result.detected, true);
});

test('Windows MSIX Cowork sessions under Claude-Data\\claude_<suffix> are parsed', (t) => {
  const { dataDirs, coworkRoot, writeSession, run } = fixture(t);
  const cowork = coworkRoot(dataDirs.claudeData);
  writeSession(cowork, 'cowork-session', [{ id: 'a', input: 70, output: 7 }]);

  const result = run();
  assert.deepEqual(result.desktopRoots, [cowork]);
  assert.deepEqual(totals(result), { input: 70, output: 7 });
  assert.equal(result.detected, true);
});

test('Windows classic-installer Cowork sessions under %APPDATA%\\Claude still work', (t) => {
  const { dataDirs, coworkRoot, writeSession, run } = fixture(t);
  const cowork = coworkRoot(dataDirs.classic);
  writeSession(cowork, 'cowork-session', [{ id: 'a', input: 40, output: 4 }]);

  const result = run();
  assert.deepEqual(result.desktopRoots, [cowork]);
  assert.deepEqual(totals(result), { input: 40, output: 4 });
  assert.equal(result.detected, true);
});

test('Windows Cowork data in both classic and MSIX locations is merged and a copied session counts once', (t) => {
  const { dataDirs, coworkRoot, writeSession, run } = fixture(t);
  const classic = coworkRoot(dataDirs.classic, 'local_old');
  const msix = coworkRoot(dataDirs.msix, 'local_old');
  const msixOnly = coworkRoot(dataDirs.msix, 'local_new');
  // The same logical session left behind in the classic directory (older,
  // shorter) and continued in the package: one copy, the more complete one.
  writeSession(classic, 'shared-session', [{ id: 'shared', input: 100, output: 10 }]);
  writeSession(msix, 'shared-session', [
    { id: 'shared', input: 100, output: 10 },
    { id: 'later', input: 50, output: 5, at: '2026-11-10T10:02:00.000Z' },
  ]);
  writeSession(msixOnly, 'other-session', [{ id: 'other', input: 20, output: 2 }]);

  const result = run();
  assert.deepEqual(result.desktopRoots.sort(), [classic, msix, msixOnly].sort());
  assert.equal(result.skipped, false);
  assert.deepEqual(totals(result), { input: 170, output: 17 });
  assert.equal(result.sessions.length, 2);
});

test('Windows package directories follow the Windows app rule: case-insensitive prefix, alphanumeric suffix', (t) => {
  const { localAppData, coworkRoot, writeSession, run } = fixture(t);
  const packages = join(localAppData, 'Packages');
  const accepted = join(packages, 'CLAUDE_ABC123', 'LocalCache', 'Roaming', 'Claude');
  writeSession(coworkRoot(accepted), 'accepted', [{ id: 'ok', input: 9, output: 1 }]);
  for (const name of ['Claude_', 'Claude_abc-def', 'Claude_abc.def', 'XClaude_abc', 'AnthropicPBC.Claude_abc']) {
    writeSession(
      coworkRoot(join(packages, name, 'LocalCache', 'Roaming', 'Claude')),
      `ignored-${name}`,
      [{ id: name, input: 1000, output: 1000 }],
    );
  }
  // A stray file with a matching name is neither scanned nor a warning, so it
  // cannot mark the source incomplete.
  writeFileSync(join(packages, 'Claude_file1'), 'not a directory');

  const result = run();
  assert.deepEqual(result.desktopRoots, [coworkRoot(accepted)]);
  assert.equal(result.skipped, false);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(totals(result), { input: 9, output: 1 });
});

test('Windows MSIX discovery falls back to ~\\AppData\\Local when LOCALAPPDATA is unset', (t) => {
  const { dataDirs, coworkRoot, writeSession, run } = fixture(t);
  const cowork = coworkRoot(dataDirs.msix);
  writeSession(cowork, 'cowork-session', [{ id: 'a', input: 30, output: 3 }]);

  const result = run({ env: { LOCALAPPDATA: '' } });
  assert.deepEqual(result.desktopRoots, [cowork]);
  assert.deepEqual(totals(result), { input: 30, output: 3 });
});

test('MSIX package directories are a Windows-only location', (t) => {
  const { dataDirs, coworkRoot, writeSession, run } = fixture(t);
  writeSession(coworkRoot(dataDirs.msix), 'cowork-session', [{ id: 'a', input: 30, output: 3 }]);

  const result = run({ platform: 'darwin' });
  assert.deepEqual(result.desktopRoots, []);
  assert.deepEqual(result.buckets, []);
});

test('VIBE_USAGE_CLAUDE_DESKTOP_DIRS still replaces Windows Desktop discovery, MSIX included', (t) => {
  const { root, dataDirs, coworkRoot, writeSession, run } = fixture(t);
  writeSession(coworkRoot(dataDirs.msix), 'cowork-session', [{ id: 'a', input: 30, output: 3 }]);
  const override = join(root, 'override');
  const overrideRoot = coworkRoot(override);
  writeSession(overrideRoot, 'override-session', [{ id: 'b', input: 5, output: 1 }]);

  const result = run({ env: { VIBE_USAGE_CLAUDE_DESKTOP_DIRS: override } });
  assert.deepEqual(result.desktopRoots, [overrideRoot]);
  assert.deepEqual(totals(result), { input: 5, output: 1 });
});

test('Windows package directories that are links (mklink /J or symlink) are followed; a dangling one is ignored quietly', (t) => {
  const { root, localAppData, coworkRoot, writeSession, run } = fixture(t);
  // The real stores live on "another drive"; the package directory names in
  // AppData are links to them, as `mklink /J` leaves behind.
  const movedPackage = join(root, 'D-drive', 'Claude_pkg');
  const movedData = join(root, 'D-drive', 'claude_data');
  writeSession(
    coworkRoot(join(movedPackage, 'LocalCache', 'Roaming', 'Claude')),
    'packaged-session',
    [{ id: 'pkg', input: 11, output: 1 }],
  );
  writeSession(coworkRoot(movedData), 'data-session', [{ id: 'data', input: 22, output: 2 }]);
  const packages = join(localAppData, 'Packages');
  const claudeData = join(localAppData, 'Claude-Data');
  mkdirSync(packages, { recursive: true });
  mkdirSync(claudeData, { recursive: true });
  symlinkSync(movedPackage, join(packages, 'Claude_linked1'), 'junction');
  symlinkSync(movedData, join(claudeData, 'claude_linked2'), 'junction');
  symlinkSync(join(root, 'missing-target'), join(packages, 'Claude_dangling'), 'junction');

  const result = run();
  assert.deepEqual(result.desktopRoots.sort(), [
    coworkRoot(join(claudeData, 'claude_linked2')),
    coworkRoot(join(packages, 'Claude_linked1', 'LocalCache', 'Roaming', 'Claude')),
  ].sort());
  assert.equal(result.skipped, false);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(totals(result), { input: 33, output: 3 });
  assert.equal(result.sessions.length, 2);
});

test('A Packages or Claude-Data path that cannot be listed (not a directory) is skipped without a warning', (t) => {
  const { localAppData, dataDirs, coworkRoot, writeSession, run } = fixture(t);
  writeSession(coworkRoot(dataDirs.classic), 'classic-session', [{ id: 'a', input: 40, output: 4 }]);
  writeFileSync(join(localAppData, 'Packages'), 'not a directory');
  writeFileSync(join(localAppData, 'Claude-Data'), 'not a directory');

  const result = run();
  assert.deepEqual(result.desktopRoots, [coworkRoot(dataDirs.classic)]);
  assert.equal(result.skipped, false);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(totals(result), { input: 40, output: 4 });
});

test('An unreadable Packages or Claude-Data directory is skipped without a warning', {
  skip: process.platform === 'win32' ? 'POSIX chmod fixture: Windows requires a separate ACL denial test'
    : process.getuid?.() === 0 && 'POSIX root bypasses chmod denial; run as an unprivileged user',
}, (t) => {
  const { localAppData, dataDirs, coworkRoot, writeSession, run } = fixture(t);
  writeSession(coworkRoot(dataDirs.classic), 'classic-session', [{ id: 'a', input: 40, output: 4 }]);
  writeSession(coworkRoot(dataDirs.msix), 'msix-session', [{ id: 'b', input: 1000, output: 1000 }]);
  writeSession(coworkRoot(dataDirs.claudeData), 'data-session', [{ id: 'c', input: 1000, output: 1000 }]);
  const blocked = [join(localAppData, 'Packages'), join(localAppData, 'Claude-Data')];
  for (const dir of blocked) chmodSync(dir, 0);
  try {
    const result = run();
    assert.deepEqual(result.desktopRoots, [coworkRoot(dataDirs.classic)]);
    assert.equal(result.skipped, false);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(totals(result), { input: 40, output: 4 });
  } finally {
    for (const dir of blocked) chmodSync(dir, 0o700);
  }
});

test('One session copied into Packages, Claude-Data and ~/.claude counts once, from the most complete copy', (t) => {
  const { user, dataDirs, coworkRoot, writeSession, run } = fixture(t);
  const calls = [
    { id: 'one', input: 100, output: 10 },
    { id: 'two', input: 50, output: 5, at: '2026-11-10T10:02:00.000Z' },
    { id: 'three', input: 25, output: 2, at: '2026-11-10T10:03:00.000Z' },
  ];
  writeSession(coworkRoot(dataDirs.claudeData), 'shared-session', calls.slice(0, 1));
  writeSession(coworkRoot(dataDirs.msix), 'shared-session', calls.slice(0, 2));
  writeSession(join(user, '.claude'), 'shared-session', calls);

  const result = run();
  assert.equal(result.desktopRoots.length, 2);
  assert.equal(result.skipped, false);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(totals(result), { input: 175, output: 17 });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].messageCount, 4);
});
