import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Windows-specific behaviours that used to live only in the Windows app's
// vendored patch set. They are upstream bugs: the CLI runs on Windows too, and
// each one silently collected nothing, wrote to the wrong place, or failed
// outright there.

/** Run a snippet in a child process with `process.platform` forced. */
function probe(source, env) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('a directory occupying the config file path is moved aside instead of blocking every save', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-eisdir-config-'));
  const configDir = join(root, 'cfg');
  const configFile = join(configDir, 'config.json');
  try {
    // The layout that stops the CLI dead: the *file* path is a directory.
    mkdirSync(configFile, { recursive: true });
    writeFileSync(join(configFile, 'leftover.txt'), 'user data');
    const out = probe(
      `import { saveConfig, loadConfig } from './src/config.js';
       saveConfig({ apiKey: 'vbu_fixture' });
       console.log(JSON.stringify(loadConfig()));`,
      { VIBE_USAGE_CONFIG_DIR: configDir, VIBE_USAGE_DEV: '0' },
    );
    // The run saved, and the thing that was in the way still exists under a
    // backup name — a repair must never delete what it moved.
    assert.deepEqual(JSON.parse(out.trim()), { apiKey: 'vbu_fixture' });
    const backup = readdirSync(configDir).find(name => name.startsWith('config.json.directory-backup-'));
    assert.ok(backup, 'the moved directory keeps a backup name');
    assert.equal(readFileSync(join(configDir, backup, 'leftover.txt'), 'utf8'), 'user data');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a directory occupying the state file path is moved aside instead of blocking every sync', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-eisdir-state-'));
  const stateDir = join(root, 'state');
  const stateFile = join(stateDir, 'state.json');
  try {
    mkdirSync(stateFile, { recursive: true });
    writeFileSync(join(stateFile, 'leftover.txt'), 'user data');
    const out = probe(
      `import { saveState, loadState } from './src/state.js';
       saveState({ buckets: { fixture: 'hash' }, sessions: {} });
       console.log(JSON.stringify(loadState().buckets));`,
      { VIBE_USAGE_STATE_DIR: stateDir, VIBE_USAGE_DEV: '0' },
    );
    assert.deepEqual(JSON.parse(out.trim()), { fixture: 'hash' });
    const backup = readdirSync(stateDir).find(name => name.startsWith('state.json.directory-backup-'));
    assert.ok(backup, 'the moved directory keeps a backup name');
    assert.equal(readFileSync(join(stateDir, backup, 'leftover.txt'), 'utf8'), 'user data');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OpenCode on Windows also probes %LOCALAPPDATA%, without replacing the XDG root', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-opencode-win-'));
  try {
    const localAppData = join(root, 'AppData', 'Local');
    const winRoot = join(localAppData, 'opencode');
    mkdirSync(winRoot, { recursive: true });
    // A database the resolver recognises, so the root is not skipped as absent.
    writeFileSync(join(winRoot, 'opencode.db'), '');

    const rootsFor = platform => JSON.parse(probe(
      `Object.defineProperty(process, 'platform', { value: process.env.FIXTURE_PLATFORM });
       const { getOpenCodeStores } = await import('./src/opencode-roots.js');
       console.log(JSON.stringify(getOpenCodeStores().map(s => s.path)));`,
      { FIXTURE_PLATFORM: platform, LOCALAPPDATA: localAppData, HOME: root, VIBE_USAGE_DEV: '0' },
    ).trim());

    // POSIX: unchanged — no fixture at ~/.local/share/opencode, and no
    // LOCALAPPDATA guess to fall back on.
    assert.equal(rootsFor('linux').length, 0);
    // Windows: the LOCALAPPDATA store is read as an additional root. The store
    // paths come back canonicalised, so compare against the realpath.
    assert.deepEqual(rootsFor('win32'), [join(realpathSync(winRoot), 'opencode.db')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Amp on Windows reads %LOCALAPPDATA%\\amp\\threads', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-amp-win-'));
  try {
    const localAppData = join(root, 'AppData', 'Local');
    const threadsDir = join(localAppData, 'amp', 'threads');
    mkdirSync(threadsDir, { recursive: true });
    writeFileSync(join(threadsDir, 'thread-1.jsonl'), '');

    const dirs = JSON.parse(probe(
      `Object.defineProperty(process, 'platform', { value: process.env.FIXTURE_PLATFORM });
       const { resolveThreadsDir } = await import('./src/parsers/amp.js');
       console.log(JSON.stringify(resolveThreadsDir()));`,
      { FIXTURE_PLATFORM: 'win32', LOCALAPPDATA: localAppData, HOME: root, VIBE_USAGE_DEV: '0' },
    ).trim());

    assert.equal(dirs, threadsDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
