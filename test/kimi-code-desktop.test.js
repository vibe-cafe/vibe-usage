import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { kimiWorkCodeHome, resolveKimiCodeRoots } from '../src/kimi-roots.js';

const start = Date.parse('2026-09-08T08:01:00.000Z');

function writeWire(home, sessionDirName, workDir, timestamp = start) {
  const sessionDir = join(home, 'sessions', sessionDirName, 'conv-80772099c13d487b49d33756');
  const agentsDir = join(sessionDir, 'agents', 'main');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, 'wire.jsonl'), `${[
    JSON.stringify({ type: 'turn.prompt', origin: { kind: 'user' }, time: timestamp }),
    JSON.stringify({
      type: 'usage.record',
      model: 'kimi-code/kimi-for-coding',
      usage: { inputOther: 7, output: 3, inputCacheRead: 2, inputCacheCreation: 1 },
      usageScope: 'turn',
      time: timestamp + 1000,
    }),
  ].join('\n')}\n`, 'utf-8');
  writeFileSync(join(home, 'session_index.jsonl'), `${JSON.stringify({
    sessionId: 'conv-80772099c13d487b49d33756', sessionDir, workDir,
  })}\n`, { flag: 'a' });
  return sessionDir;
}

function runParse(env) {
  const script = 'import { parse } from "./src/parsers/kimi-code.js";'
    + 'console.log(JSON.stringify(await parse()));';
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), env, encoding: 'utf8',
  }));
}

test('Kimi Work home is resolved per platform', () => {
  assert.equal(
    kimiWorkCodeHome({}, 'darwin', '/Users/me'),
    '/Users/me/Library/Application Support/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home',
  );
  assert.equal(
    kimiWorkCodeHome({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32', 'C:\\Users\\me'),
    'C:\\Users\\me\\AppData\\Roaming\\kimi-desktop\\daimon-share\\daimon\\runtime\\kimi-code\\home',
  );
  assert.equal(
    kimiWorkCodeHome({}, 'linux', '/home/me'),
    '/home/me/.config/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home',
  );
});

test('CLI home stays primary and the desktop home is additive, without duplicates', () => {
  // Forcing platform: 'linux' below exercises the posix branch regardless of
  // host OS, so every path fed into or compared against it must be built with
  // `posix.join` too — mixing in the native `join` (backslash on Windows)
  // would make otherwise-identical directories compare as different strings,
  // even though Windows' filesystem APIs happily accept forward slashes.
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-kimi-roots-')).replaceAll('\\', '/');
  const fakeHome = posix.join(root, 'home');
  const cliHome = posix.join(root, 'cli-home');
  mkdirSync(cliHome, { recursive: true });
  // Same store reachable under the desktop home path: scan it once, not twice.
  mkdirSync(posix.join(fakeHome, '.config', 'kimi-desktop', 'daimon-share', 'daimon', 'runtime', 'kimi-code'), { recursive: true });
  symlinkSync(cliHome, kimiWorkCodeHome({}, 'linux', fakeHome), process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.deepEqual(resolveKimiCodeRoots({ KIMI_CODE_HOME: cliHome }, 'linux', fakeHome), [cliHome]);
    assert.deepEqual(
      resolveKimiCodeRoots({}, 'linux', fakeHome),
      [posix.join(fakeHome, '.kimi-code'), kimiWorkCodeHome({}, 'linux', fakeHome)],
    );
    // Fixture hook replaces discovery entirely — the machine's real stores stay out.
    assert.deepEqual(
      resolveKimiCodeRoots({ VIBE_USAGE_KIMI_CODE_DIR: '/fixture/home' }, 'linux', fakeHome),
      ['/fixture/home'],
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Kimi Work desktop sessions are parsed and merged with the CLI home', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-kimi-desktop-'));
  const fakeHome = join(root, 'home');
  const cliHome = join(root, 'cli-home');
  // os.homedir() ignores HOME on Windows and reads USERPROFILE instead; set
  // both so the child (which calls homedir() with no args) resolves fakeHome
  // on every platform instead of falling back to the real runner home.
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, KIMI_CODE_HOME: cliHome };
  delete env.VIBE_USAGE_KIMI_CODE_DIR;
  // Keep the fixture hermetic: an ambient XDG_CONFIG_HOME / APPDATA on the
  // runner would move the desktop home out from under it, and the child would
  // then resolve a different directory than the one we wrote.
  delete env.XDG_CONFIG_HOME;
  delete env.APPDATA;
  const desktopHome = kimiWorkCodeHome(env, process.platform, fakeHome);
  try {
    mkdirSync(cliHome, { recursive: true });
    mkdirSync(desktopHome, { recursive: true });
    writeWire(desktopHome, 'wd_venture_cap_6084fcc58cb8', '/work/venture_cap');
    writeWire(cliHome, 'wd_cli_project_abcdef', '/work/cli-project', start + 3600_000);

    const result = runParse(env);

    assert.deepEqual(result.buckets.map(bucket => bucket.project).sort(), ['cli-project', 'venture_cap']);
    for (const bucket of result.buckets) {
      assert.equal(bucket.model, 'kimi-code/kimi-for-coding');
      assert.equal(bucket.inputTokens, 8); // inputOther + inputCacheCreation
      assert.equal(bucket.outputTokens, 3);
      assert.equal(bucket.cachedInputTokens, 2);
    }
    assert.equal(result.sessions.length, 2);
    assert.deepEqual(result.sessions.map(session => session.userMessageCount), [1, 1]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
