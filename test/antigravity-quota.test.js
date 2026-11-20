import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs, { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { antigravityBinary, antigravityDesktopPaths, supportsAntigravityUsage, withAntigravitySession } from '../src/quotas/providers/antigravity.js';
import { LoginRequired, runAntigravityCommand, TimedOut } from '../src/quotas/providers/antigravity-process.js';
import { fetchQuotaProducts } from '../src/quotas/registry.js';

// Allow-listed fields from the sanitized agy 1.5.13 /usage sample.
const usage = { status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: { groups: [
  { name: 'Gemini Models', buckets: [
    { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.4239039123058319, reset_time: '2026-11-26T02:30:47Z' },
    { id: 'gemini-5h', window: '5h', remaining_fraction: 0.05826606601476669, reset_time: '2026-11-20T17:15:03Z' },
  ] },
  { name: 'Claude and GPT models', buckets: [
    { id: '3p-weekly', window: 'weekly', remaining_fraction: 1 },
    { id: '3p-5h', window: '5h', remaining_fraction: 1 },
  ] },
  { name: 'Gemini 4 Argon', buckets: [
    { id: 'gemini-argon-wtu-weekly', window: 'weekly', remaining_fraction: 0.9968332052230835 },
  ] },
] } } };
const output = (stdout, code = 0, stderr = '') => ({ code, stdout, stderr });
const rpc = { status: 200, payload: { groups: [
  { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', remainingFraction: 0 }] },
] } };

test('only a confirmed agy release with read-only slash commands can receive /usage', () => {
  for (const version of ['1.1.11', '1.1.110', '1.2.0-beta.1', '1.10.0', '2.0.0', 'agy version v1.5.13\n']) {
    assert.equal(supportsAntigravityUsage(version), true, version);
  }
  for (const version of ['0.99.99', '1.0.111', '1.1.10', '1.1.11-rc.1', '', 'unknown',
    'upgrade available: 1.5.13', '1.1.10\nlatest: 1.5.13']) {
    assert.equal(supportsAntigravityUsage(version), false, version);
  }
});

test('Mac GUI launches find either system agy even with an empty PATH', t => {
  const paths = ['/opt/homebrew/bin/agy', '/usr/local/bin/agy'];
  let installed;
  const access = t.mock.method(fs, 'accessSync', path => {
    if (path !== installed) throw new Error('fixture missing');
  });
  const stat = t.mock.method(fs, 'statSync', () => ({ isFile: () => true }));
  syncBuiltinESMExports();
  try {
    for (installed of paths) assert.equal(antigravityBinary({ PATH: '' }, '/fixture', 'darwin'), installed);
  } finally {
    access.mock.restore();
    stat.mock.restore();
    syncBuiltinESMExports();
  }
});

test('desktop executable paths use the system and user Mac bundles or the Windows per-user install', () => {
  const home = '/fixture';
  const suffix = join('Antigravity.app', 'Contents', 'Resources', 'bin', 'language_server');
  assert.deepEqual(antigravityDesktopPaths({}, home, 'darwin'), [
    join('/Applications', suffix), join(home, 'Applications', suffix),
  ]);
  assert.deepEqual(antigravityDesktopPaths({ LOCALAPPDATA: home }, home, 'win32'), [
    join(home, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe'),
  ]);
  assert.deepEqual(antigravityDesktopPaths({}, home, 'win32'), []);
  assert.deepEqual(antigravityDesktopPaths({}, home, 'linux'), []);
});

// Exercise discovery + fetch + schema/cache through the same registry as the apps.
// A simulated per-user Windows install keeps all paths inside the fixture on every OS.
function install(t, { cli = true, desktop = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'vbu-agy-install-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const environment = { LOCALAPPDATA: home, PATH: '', VIBE_USAGE_QUOTA_CACHE_DIR: home };
  const agy = join(home, 'agy', 'bin', 'agy.exe');
  const [engine] = antigravityDesktopPaths(environment, home, 'win32');
  for (const path of [...(cli ? [agy] : []), ...(desktop ? [engine] : [])]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
  }
  return async ({
    version = output('1.5.13'), command = output(JSON.stringify(usage)), legacy = rpc, hub = rpc,
    onAttempt = () => {},
  } = {}) => {
    const calls = [];
    function record(name, options) {
      calls.push(name);
      onAttempt(name, options.timeoutMs);
    }
    const { products: [result], schemaVersion } = await fetchQuotaProducts(['antigravity'], {
      environment, home, platform: 'win32',
      commandImpl: async (binary, args, options) => {
        assert.equal(binary, agy);
        const probe = args[0] === '--version';
        record(probe ? 'version' : 'usage', options);
        assert.deepEqual(args, probe ? ['--version'] : ['-p', '/usage', '--output-format', 'json']);
        const response = probe ? version : command;
        if (response instanceof Error) throw response;
        return response;
      },
      sessionImpl: async (binary, callback, options) => {
        record(binary === engine ? 'desktop' : 'legacy', options);
        assert.equal(binary, options.desktopVersion ? engine : agy);
        if (binary === engine) assert.equal(options.desktopVersion, '2.33.0');
        const meters = await callback({ port: binary === engine ? 1235 : 1234 });
        if (!meters) throw new Error('fixture startup timed out');
        return meters;
      },
      requestImpl: async ({ port }) => port === 1235 ? hub : legacy,
    });
    assert.equal(schemaVersion, 1);
    assert.equal(result.source, 'live');
    assert.equal(existsSync(join(home, 'quota-cache.json')), false);
    return { result, calls };
  };
}

test('a new CLI uses the structured Gemini windows even with the desktop installed', async t => {
  for (const desktop of [true, false]) {
    const { calls, result } = await install(t, { desktop })();
    assert.deepEqual(calls, ['version', 'usage']);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.meters, [
      { id: 'gemini-5h', label: '5h', utilization: (1 - 0.05826606601476669) * 100,
        resetsAt: '2026-11-20T17:15:03.000Z', windowSeconds: 18000 },
      { id: 'gemini-weekly', label: '7d', utilization: (1 - 0.4239039123058319) * 100,
        resetsAt: '2026-11-26T02:30:47.000Z', windowSeconds: 604800 },
    ]);
  }
});

test('old, missing, failed and timed-out version probes never send a slash command', async t => {
  const fetch = install(t, { desktop: false });
  for (const version of [output('1.1.10'), output('unknown'), output('1.5.13', 1), new TimedOut()]) {
    const { calls, result } = await fetch({ version });
    assert.deepEqual(calls, ['version', 'legacy']);
    assert.equal(result.status, 'ok');
  }
});

test('fast usage failures try the CLI service once, then the desktop engine only when needed', async t => {
  const fetch = install(t);
  const invalid = structuredClone(usage);
  invalid.command.data.groups[1].buckets[0].remaining_fraction = 1.01;
  for (const command of [new Error('spawn failed'), output('{'), output('{"status":"FAILURE"}'),
    output(JSON.stringify(invalid)), output(JSON.stringify(usage), 1)]) {
    const { calls, result } = await fetch({ command });
    assert.deepEqual(calls, ['version', 'usage', 'legacy']);
    assert.equal(result.status, 'ok');
  }
  const recovered = await fetch({ command: output(''), legacy: { status: 503 } });
  assert.deepEqual(recovered.calls, ['version', 'usage', 'legacy', 'desktop']);
  assert.equal(recovered.result.status, 'ok');
  const failed = await fetch({ command: output(''), legacy: { status: 503 }, hub: { status: 503 } });
  assert.equal(failed.result.status, 'retryable_error');
});

test('all attempts share one deadline, including version detection and cleanup', async t => {
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  const unavailable = { status: 503 };
  // The version probe takes 1s. Timeouts use their full allocation, a fast /usage
  // failure takes 2s, and the failed process takes another 0.5s to clean up.
  const timedOut = new TimedOut();
  const old = output('1.1.10');
  const fast = output('');
  for (const [devices, version, command, expected] of [
    [{ desktop: false }, undefined, timedOut, [['version', 2000], ['usage', 8900], ['legacy', 6500]]],
    [{}, undefined, timedOut, [['version', 2000], ['usage', 8900], ['desktop', 6500]]],
    [{}, undefined, fast, [['version', 2000], ['usage', 8900], ['legacy', 6400], ['desktop', 6500]]],
    [{ desktop: false }, old, undefined, [['version', 2000], ['legacy', 15900]]],
    [{}, timedOut, undefined, [['version', 2000], ['legacy', 7400], ['desktop', 6500]]],
    [{ cli: false }, undefined, undefined, [['desktop', 16900]]],
  ]) {
    elapsed = 0;
    const attempts = [];
    const { result } = await install(t, devices)({
      version, command, legacy: unavailable, hub: unavailable,
      onAttempt(name, limit) {
        attempts.push([name, limit]);
        if (name === 'version' && version !== timedOut) elapsed += 1000;
        else if (name === 'usage' && command === fast) elapsed += 2500;
        else elapsed += limit + (name === expected.at(-1)[0] ? 3100 : 500);
      },
    });
    assert.deepEqual(attempts, expected);
    assert.equal(elapsed, 20000);
    assert.equal(result.status, 'retryable_error');
  }
});

test('cleanup that exhausts the shared deadline prevents another launch', async t => {
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  const { calls, result } = await install(t)({
    command: new TimedOut(), onAttempt(name) { if (name === 'usage') elapsed = 20000; },
  });
  assert.deepEqual(calls, ['version', 'usage']);
  assert.equal(result.status, 'retryable_error');
});

test('a CLI service login failure ends the fetch even with a working desktop engine', async t => {
  const fetch = install(t);
  for (const legacy of [{ status: 401 }, { status: 403 }, { status: 200, payload: { code: 'unauthenticated' } }]) {
    const { calls, result } = await fetch({ command: output(''), legacy });
    assert.deepEqual(calls, ['version', 'usage', 'legacy']);
    assert.equal(result.status, 'unauthorized');
  }
});

test('explicit /usage login failures are terminal and keep account text out of the result', async t => {
  const fetch = install(t);
  for (const command of [output('{"status":"ERROR","error":"UNAUTHENTICATED","email":"private@example.invalid"}'),
    output('{"status":"SUCCESS","response":"Please sign in to view quota"}'),
    output('', 1, 'Print mode: not logged in and no controlling terminal; private@example.invalid')]) {
    const { calls, result } = await fetch({ command });
    assert.deepEqual(calls, ['version', 'usage']);
    assert.equal(result.status, 'unauthorized');
    assert.ok(!JSON.stringify(result).includes('private@example.invalid'));
  }
});

test('desktop-only installations can return quota or a sign-in status', async t => {
  const fetch = install(t, { cli: false });
  for (const [hub, expected] of [[rpc, 'ok'], [{ status: 401 }, 'unauthorized'],
    [{ status: 200, payload: { code: 'unauthenticated' } }, 'unauthorized']]) {
    const { calls, result } = await fetch({ hub });
    assert.deepEqual(calls, ['desktop']);
    assert.equal(result.status, expected);
  }
});

test('Mac desktop sessions use the bundle short version or the verified fallback', async t => {
  const home = mkdtempSync(join(tmpdir(), 'vbu-agy-plist-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const environment = { PATH: '', ANTIGRAVITY_CLI_PATH: join(home, 'absent') };
  const engine = antigravityDesktopPaths(environment, home, 'darwin').at(-1);
  mkdirSync(dirname(engine), { recursive: true });
  writeFileSync(engine, '', { mode: 0o700 });
  const plist = join(home, 'Applications', 'Antigravity.app', 'Contents', 'Info.plist');
  const versions = [];
  // Keep an installed system-wide bundle out of this user-bundle fixture.
  const access = t.mock.method(fs, 'accessSync', path => { if (path !== engine) throw new Error('missing'); });
  syncBuiltinESMExports();
  try {
    for (const content of [null, '<key>CFBundleVersion</key><string>99.9.9</string>',
      '<key>CFBundleShortVersionString</key>\n  <string>2.45.1</string>']) {
      if (content !== null) writeFileSync(plist, content);
      const { products: [result] } = await fetchQuotaProducts(['antigravity'], {
        environment, home, platform: 'darwin',
        sessionImpl: async (_, callback, options) => {
          versions.push(options.desktopVersion);
          return callback({});
        },
        requestImpl: async () => rpc,
      });
      assert.equal(result.status, 'ok');
    }
  } finally {
    access.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(versions, ['2.33.0', '2.33.0', '2.45.1']);
});

test('all agy commands inherit the login directory and only the desktop engine gets a temporary --gemini_dir', async () => {
  const stopAtSpawn = new Error('fixture stopped at spawn');
  for (const environment of [{}, { ANTIGRAVITY_GEMINI_DIR: '/fixture/custom-login' }]) {
    const options = {
      environment: Object.freeze(environment), timeoutMs: 3000,
      spawnImpl(binary, args, { env, cwd }) {
        if (binary === 'fixture-engine') {
          assert.ok(args.includes('--gemini_dir'));
          assert.equal(args[args.indexOf('--gemini_dir') + 1], cwd);
          assert.equal(env.ANTIGRAVITY_VSCODE_HOST, '1');
        } else {
          assert.deepEqual(env, environment);
          assert.ok(!args.includes('--gemini_dir'));
        }
        throw stopAtSpawn;
      },
    };
    for (const args of [['--version'], ['-p', '/usage', '--output-format', 'json']]) {
      await assert.rejects(runAntigravityCommand('fixture-agy', args, options), stopAtSpawn);
    }
    await assert.rejects(withAntigravitySession('fixture-agy', null, options), stopAtSpawn);
    await assert.rejects(withAntigravitySession('fixture-engine', null, {
      ...options, desktopVersion: '2.33.0',
    }), stopAtSpawn);
  }
});

test('the owned desktop engine uses a temporary data root, closes stdin and stops on login URLs', async () => {
  const tokens = new Set();
  for (const mode of ['quota', 'marker', 'oauth']) {
    let child, cwd, endpoint, printedToken;
    const action = withAntigravitySession('fixture-engine', async ep => {
      endpoint = ep;
      if (mode === 'oauth') return new Promise(() => {}); // login while an RPC is in flight
      return 'quota';
    }, { desktopVersion: '2.33.0', timeoutMs: 4000, environment: {}, spawnImpl: (_, args, options) => {
      cwd = options.cwd;
      printedToken = args[args.indexOf('--csrf_token') + 1];
      assert.deepEqual(args, ['--standalone', '--override_ide_name', 'antigravity', '--subclient_type', 'hub',
        '--override_ide_version', '2.33.0', '--override_user_agent_name', 'antigravity',
        '--https_server_port', '0', '--csrf_token', printedToken, '--app_data_dir', 'antigravity',
        '--api_server_url', 'https://generativelanguage.googleapis.com',
        '--cloud_code_endpoint', 'https://daily-cloudcode-pa.googleapis.com', '--gemini_dir', cwd]);
      assert.match(printedToken, /^[0-9a-f]{64}$/);
      tokens.add(printedToken);
      assert.equal(options.env.ANTIGRAVITY_VSCODE_HOST, '1');
      const script = `process.stdin.resume(); process.stdin.on('end', () => {
        const mode = process.argv[1];
        if (mode === 'marker') {
          process.stderr.write('ANTIGRAVITY_OPEN_');
          setTimeout(() => process.stderr.write('URL: https://example.invalid/private'), 20);
        } else {
          process.stdout.write('listening on dynamic port at ');
          setTimeout(() => process.stdout.write('12345 for HTTPS\\n'), 20);
          if (mode === 'oauth') setTimeout(() => process.stderr.write('https://accounts.google.com/o/oauth2/auth?private'), 500);
        }
      }); setInterval(() => {}, 1000);`;
      child = spawn(process.execPath, ['-e', script, mode], options);
      return child;
    } });
    if (mode === 'quota') {
      assert.equal(await action, 'quota');
      assert.equal(endpoint.port, 12345);
      assert.equal(endpoint.token, printedToken);
    } else {
      await assert.rejects(action, LoginRequired);
      assert.equal(Boolean(endpoint), mode === 'oauth');
    }
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(existsSync(cwd), false);
  }
  assert.equal(tokens.size, 3);
});

test('print-mode commands bound output and clean their process and cwd on timeout or success', async () => {
  for (const mode of ['timeout', 'oversize', 'success']) {
    let child, cwd;
    const action = runAntigravityCommand('fixture-agy', ['-p', '/usage', '--output-format', 'json'], {
      timeoutMs: mode === 'timeout' ? 300 : 3000, environment: {}, spawnImpl: (_, args, options) => {
        cwd = options.cwd;
        const script = mode === 'timeout' ? 'setInterval(() => {}, 1000)'
          : mode === 'oversize' ? 'process.stdout.write(Buffer.alloc(1024 * 1024 + 1))' : 'console.log("ok")';
        child = spawn(process.execPath, ['-e', script, '--', ...args], options);
        return child;
      },
    });
    if (mode === 'success') assert.deepEqual(await action, output('ok\n'));
    else await assert.rejects(action, mode === 'timeout' ? TimedOut : /unavailable/);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(existsSync(cwd), false);
  }
});

test('a locked temporary directory leaves the command result intact', async t => {
  let leftover;
  let retryOptions;
  const remove = t.mock.method(fs, 'rmSync', (path, options) => {
    leftover = path;
    retryOptions = options;
    throw Object.assign(new Error('directory in use'), { code: 'EBUSY' });
  });
  syncBuiltinESMExports();
  try {
    const response = await runAntigravityCommand(process.execPath, ['-e', 'console.log("ok")'], { timeoutMs: 3000 });
    assert.deepEqual(response, output('ok\n'));
    assert.deepEqual(retryOptions, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    assert.ok(existsSync(leftover));
  } finally {
    remove.mock.restore();
    syncBuiltinESMExports();
    if (leftover) rmSync(leftover, { recursive: true, force: true });
  }
});

if (process.platform !== 'win32') {
  test('the quota CLI reads a signed-out or signed-in fake agy without private RPC', t => {
    const home = mkdtempSync(join(tmpdir(), 'vbu-agy-cli-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const binary = join(home, 'agy');
    writeFileSync(binary, `#!/usr/bin/env node
      const args = process.argv.slice(2).join(' ');
      const { realpathSync } = require('node:fs');
      if ('ANTIGRAVITY_GEMINI_DIR' in process.env || process.cwd() === realpathSync(process.env.HOME)) process.exit(1);
      if (args === '--version') console.log('1.1.11');
      else if (args === '-p /usage --output-format json') console.log(process.env.FIXTURE_USAGE);
      else process.exit(1);\n`, { mode: 0o700 });
    const cli = fileURLToPath(new URL('../bin/vibe-usage.js', import.meta.url));
    // A regression in the fake CLI path must never launch a system-wide Mac install.
    const isolate = "data:text/javascript,Object.defineProperty(process,'platform',{value:'linux'})";
    for (const [payload, expected] of [[usage, 'ok'], [{ status: 'ERROR', error: 'auth_error' }, 'unauthorized']]) {
      const stdout = execFileSync(process.execPath, ['--import', isolate, cli, 'quota', 'fetch', '--product', 'antigravity', '--json'], {
        timeout: 5000, env: { HOME: home, PATH: dirname(process.execPath), ANTIGRAVITY_CLI_PATH: binary,
          TMPDIR: tmpdir(), FIXTURE_USAGE: JSON.stringify(payload) },
      });
      const { schemaVersion, products: [result] } = JSON.parse(stdout);
      assert.equal(schemaVersion, 1);
      assert.equal(result.status, expected);
      assert.equal(existsSync(join(home, '.gemini')), false);
      assert.equal(existsSync(join(home, '.vibe-usage', 'quota-cache.json')), false);
    }
  });

  test('cleanup kills a stubborn helper in the owned group after the fake CLI exits', async () => {
    const helper = "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);";
    const parent = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helper)}],
      { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.once('data', data => process.stdout.write(data, () => process.exit(0)));`;
    const { stdout } = await runAntigravityCommand(process.execPath, ['-e', parent], { timeoutMs: 3000 });
    const pid = Number(stdout.trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    try {
      for (let i = 0; i < 40; i++) {
        try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
        await delay(25);
      }
      assert.fail('owned helper is still alive');
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* Already reaped. */ }
    }
  });
}
