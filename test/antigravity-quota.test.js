import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs, { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  antigravityBinary, antigravityDesktopPaths, asarPackageVersion, desktopVersion, fetchAntigravityQuota,
  readAntigravityQuota, supportsAntigravityUsage, withAntigravitySession,
} from '../src/quotas/providers/antigravity.js';
import {
  findRunningAntigravityServers, LoginRequired, parseLsofPorts, parseUnixProcessList, parseWindowsServers,
  runAntigravityCommand, TimedOut,
} from '../src/quotas/providers/antigravity-process.js';
import { discoverQuotaProducts, fetchQuotaProducts } from '../src/quotas/registry.js';
import { quotaResult } from '../src/quotas/schema.js';

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
const usageMeters = [
  { id: 'gemini-5h', label: '5h', utilization: (1 - 0.05826606601476669) * 100,
    resetsAt: '2026-11-20T17:15:03.000Z', windowSeconds: 18000 },
  { id: 'gemini-weekly', label: '7d', utilization: (1 - 0.4239039123058319) * 100,
    resetsAt: '2026-11-26T02:30:47.000Z', windowSeconds: 604800 },
];
const output = (stdout, code = 0, stderr = '') => ({ code, stdout, stderr });
const rpc = { status: 200, payload: { groups: [
  { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', remainingFraction: 0 }] },
] } };
const silentAuth = 'Print mode: not authenticated, trying silent auth';
const noTerminal = 'Print mode: not logged in and no controlling terminal; cannot complete interactive login';

test('only a confirmed agy release with read-only slash commands can receive /usage', () => {
  for (const version of ['1.1.11', '1.1.110', '1.2.0-beta.1', '1.10.0', '2.0.0', 'agy version v1.5.13\n']) {
    assert.equal(supportsAntigravityUsage(version), true, version);
  }
  for (const version of ['0.99.99', '1.0.111', '1.1.10', '1.1.11-rc.1', '', 'unknown',
    'upgrade available: 1.5.13', '1.1.10\nlatest: 1.5.13']) {
    assert.equal(supportsAntigravityUsage(version), false, version);
  }
});

test('quota discovery and fetch find both Mac system CLIs and prefer agy on PATH', t => {
  const paths = ['/opt/homebrew/bin/agy', '/usr/local/bin/agy'];
  const installed = new Set();
  const exists = t.mock.method(fs, 'existsSync', path => installed.has(path));
  const access = t.mock.method(fs, 'accessSync', path => {
    if (!installed.has(path)) throw new Error('fixture missing');
  });
  const stat = t.mock.method(fs, 'statSync', () => ({ isFile: () => true }));
  syncBuiltinESMExports();
  try {
    const environment = { PATH: '' };
    const detected = () => discoverQuotaProducts({ environment, home: '/fixture', platform: 'darwin' })
      .products.find(p => p.id === 'antigravity').detected;
    assert.equal(detected(), false);
    for (const path of paths) {
      installed.add(path);
      assert.equal(detected(), true);
      assert.equal(antigravityBinary(environment, '/fixture', 'darwin'), path);
      installed.delete(path);
    }
    installed.add(paths[0]);
    const onPath = join('/fixture', 'bin', 'agy');
    installed.add(onPath);
    assert.equal(antigravityBinary({ PATH: dirname(onPath) }, '/fixture', 'darwin'), onPath);
  } finally {
    exists.mock.restore();
    access.mock.restore();
    stat.mock.restore();
    syncBuiltinESMExports();
  }
});

test('desktop executable paths use the system and user Mac bundles or the Windows per-user install', () => {
  assert.deepEqual(antigravityDesktopPaths(), antigravityDesktopPaths(process.env, homedir(), process.platform));
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

test('discovery recognizes each desktop engine as the only installation signal', t => {
  const home = '/fixture';
  const environment = { PATH: '', LOCALAPPDATA: home };
  let installed;
  const exists = t.mock.method(fs, 'existsSync', path => path === installed);
  syncBuiltinESMExports();
  try {
    for (const platform of ['darwin', 'win32']) {
      for (installed of antigravityDesktopPaths(environment, home, platform)) {
        const { products } = discoverQuotaProducts({ home, environment, platform });
        assert.equal(products.find(p => p.id === 'antigravity').detected, true, installed);
      }
    }
  } finally {
    exists.mock.restore();
    syncBuiltinESMExports();
  }
});

/** A temporary installation and one read through the three steps, every launch and request faked. */
function install(t, { cli = true, desktop = true, platform = 'win32', version: installedVersion = '2.40.1' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'vbu-agy-install-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const environment = { LOCALAPPDATA: home, PATH: '' };
  const agy = platform === 'win32' ? join(home, 'agy', 'bin', 'agy.exe') : join(home, '.local', 'bin', 'agy');
  const engine = antigravityDesktopPaths(environment, home, platform).at(-1);
  for (const path of [...(cli ? [agy] : []), ...(desktop ? [engine] : [])]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '', { mode: 0o700 });
  }
  if (desktop && installedVersion) {
    if (platform === 'win32') {
      const manifest = join(dirname(engine), '..', 'app', 'package.json');
      mkdirSync(dirname(manifest), { recursive: true });
      writeFileSync(manifest, JSON.stringify({ name: 'antigravity', version: installedVersion }));
    } else {
      writeFileSync(join(dirname(engine), '..', '..', 'Info.plist'),
        `<key>CFBundleShortVersionString</key><string>${installedVersion}</string>`);
    }
  }
  const read = async ({
    version = output('1.5.13'), command = output(JSON.stringify(usage)), running = [],
    answer = () => ({ status: 404 }), hub = rpc, onAttempt = () => {}, skipAgy, agyLoggedOut, agyVersion,
  } = {}) => {
    const calls = [];
    const record = (name, limit) => {
      calls.push(name);
      onAttempt(name, limit);
    };
    const outcome = await readAntigravityQuota({
      environment, platform, binary: cli ? agy : undefined, desktop: desktop ? engine : undefined,
      skipAgy, agyLoggedOut, agyVersion,
      discoverImpl: async () => structuredClone(running),
      commandImpl: async (binary, args, options) => {
        assert.equal(binary, agy);
        const probe = args[0] === '--version';
        assert.deepEqual(args, probe ? ['--version'] : ['-p', '/usage', '--output-format', 'json']);
        record(probe ? 'version' : 'usage', options.timeoutMs);
        const response = probe ? version : command;
        if (response instanceof Error) throw response;
        return response;
      },
      sessionImpl: async (binary, callback, options) => {
        assert.equal(binary, engine);
        assert.equal(options.desktopVersion, installedVersion);
        record('desktop', options.timeoutMs);
        const meters = await callback({ port: 1235, token: 'engine-token' });
        if (!meters) throw new Error('fixture startup timed out');
        return meters;
      },
      requestImpl: async ({ port, scheme, token, timeoutMs }) => {
        if (port === 1235) return hub;
        record(`${scheme}:${port}`, timeoutMs);
        const response = answer({ port, scheme, token });
        if (response instanceof Error) throw response;
        return response;
      },
    });
    return { ...outcome, calls };
  };
  return Object.assign(read, { home, agy, engine, environment });
}

test('the official command comes first and needs nothing else when it works', async t => {
  for (const desktop of [true, false]) {
    const read = install(t, { desktop });
    const { calls, result, agyVersion, agyUnusable } = await read();
    assert.deepEqual(calls, ['version', 'usage']);
    assert.equal(result.status, 'ok');
    assert.equal(result.source, 'live');
    assert.deepEqual(result.meters, usageMeters);
    assert.equal(agyUnusable, null);
    const stat = statSync(read.agy);
    assert.deepEqual(agyVersion, { binary: `${read.agy}\0${stat.size}\0${stat.mtimeMs}`, supported: true });
  }
});

test('a remembered version check skips the extra launch until agy changes', async t => {
  const read = install(t);
  const { agyVersion } = await read();
  assert.deepEqual((await read({ agyVersion })).calls, ['usage']);
  assert.deepEqual((await read({ agyVersion: { ...agyVersion, binary: 'another build' } })).calls, ['version', 'usage']);
  const old = await read({ agyVersion: { ...agyVersion, supported: false } });
  assert.deepEqual(old.calls, ['desktop']);
  assert.equal(old.result.status, 'ok');
});

test('old, missing, failed and timed-out version probes never send a slash command', async t => {
  for (const desktop of [false, true]) {
    const read = install(t, { desktop });
    for (const [version, remembered] of [[output('1.1.10'), false], [output('unknown'), false],
      [output('1.5.13', 1), undefined], [output('', 1, noTerminal), undefined], [new TimedOut(), undefined]]) {
      const { calls, result, agyVersion } = await read({ version });
      assert.deepEqual(calls, desktop ? ['version', 'desktop'] : ['version']);
      assert.equal(result.status, desktop ? 'ok' : 'retryable_error');
      assert.equal(agyVersion?.supported, remembered);
    }
  }
});

test('a failed /usage asks a running desktop before starting an engine of our own', async t => {
  const read = install(t);
  const running = [{ pid: '42', token: 'running-token', ports: [1111, 2222] }];
  const answer = ({ port, scheme, token }) => {
    assert.equal(token, 'running-token');
    if (port === 1111) return scheme === 'https' ? new Error('wrong version number') : { status: 404 };
    return rpc;
  };
  const invalid = structuredClone(usage);
  invalid.command.data.groups[1].buckets[0].remaining_fraction = 1.01;
  for (const command of [new TimedOut(), new Error('spawn failed'), output('{'), output('{"status":"FAILURE"}'),
    output('{"status":"SUCCESS","response":"Please sign in to view quota"}'),
    output('{"status":"ERROR","error":"Print mode: not authenticated, trying silent auth"}'),
    output('', 1, silentAuth), output(JSON.stringify(invalid)), output(JSON.stringify(usage), 1)]) {
    const { calls, result } = await read({ command, running, answer });
    assert.deepEqual(calls, ['version', 'usage', 'https:1111', 'http:1111', 'https:2222']);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.meters.map(m => [m.id, m.utilization]), [['gemini-5h', 100]]);
  }
  for (const response of [{ status: 401, payload: { code: 'unauthenticated' } },
    { status: 200, payload: { code: 'unauthenticated' } }]) {
    const { calls, result } = await read({ command: new TimedOut(), running, answer: () => response });
    assert.deepEqual(calls, ['version', 'usage', 'https:1111']);
    assert.equal(result.status, 'unauthorized');
  }
  // Another port of the same process refusing the token is not the account.
  const refused = await read({ command: new TimedOut(), running,
    answer: ({ port }) => (port === 1111 ? { status: 403 } : rpc) });
  assert.deepEqual(refused.calls, ['version', 'usage', 'https:1111', 'https:2222']);
  assert.equal(refused.result.status, 'ok');
  for (const response of [new Error('refused'), { status: 401 }, { status: 503 }, { status: 200, payload: { groups: [] } }]) {
    const { calls, result } = await read({ command: new TimedOut(), running, answer: () => response });
    assert.equal(calls.at(-1), 'desktop');
    assert.equal(result.status, 'ok');
  }
  const failed = await read({ command: output(''), hub: { status: 503 } });
  assert.deepEqual(failed.calls, ['version', 'usage', 'desktop']);
  assert.equal(failed.result.status, 'retryable_error');
});

test('agy sign-in failures fall through to the desktop and are reported for the caller to remember', async t => {
  const logins = [output('{"status":"ERROR","error":"UNAUTHENTICATED","email":"private@example.invalid"}'),
    output('{"status":"UNAUTHENTICATED"}'), output('', 1, noTerminal),
    output('', 1, 'I1121 08:59:49.787026  1 printmode.go:409] Print mode: not logged in'),
    output('https://accounts.google.com/o/oauth2/auth?private@example.invalid', 1), new LoginRequired()];
  for (const desktop of [true, false]) {
    const read = install(t, { desktop });
    for (const command of logins) {
      const { calls, result, agyUnusable } = await read({ command });
      assert.deepEqual(calls, desktop ? ['version', 'usage', 'desktop'] : ['version', 'usage']);
      assert.equal(result.status, desktop ? 'ok' : 'unauthorized');
      assert.equal(agyUnusable, 'login');
      assert.ok(!JSON.stringify(result).includes('private@example.invalid'));
    }
    const skipped = await read({ skipAgy: true, agyLoggedOut: true });
    assert.deepEqual(skipped.calls, desktop ? ['desktop'] : []);
    assert.equal(skipped.result.status, desktop ? 'ok' : 'unauthorized');
    assert.equal(skipped.agyUnusable, null);
    // agy skipped because it hung last time: that was never a sign-in answer.
    assert.equal((await read({ skipAgy: true, hub: { status: 503 } })).result.status, 'retryable_error');
    if (desktop) {
      // A desktop that merely failed: not a sign-in problem, whatever agy said.
      assert.equal((await read({ skipAgy: true, agyLoggedOut: true, hub: { status: 503 } })).result.status, 'retryable_error');
      assert.equal((await read({ command: new LoginRequired(), hub: { status: 503 } })).result.status, 'retryable_error');
      assert.equal((await read({ skipAgy: true, agyLoggedOut: true, hub: { status: 401 } })).result.status, 'unauthorized');
    }
  }
  // A /usage that hangs (an interactive login waits a minute) also retires agy until it is used again;
  // running out of time before agy even starts does not.
  const read = install(t, { desktop: false });
  const hung = await read({ command: new TimedOut() });
  assert.equal(hung.agyUnusable, 'hang');
  assert.equal(hung.result.status, 'retryable_error');
  assert.equal((await read({ command: new Error('exit 1') })).agyUnusable, null);
  assert.equal((await read({ version: new TimedOut() })).agyUnusable, null);
});

test('desktop-only installations can return quota or a sign-in status', async t => {
  const read = install(t, { cli: false });
  for (const [hub, expected] of [[rpc, 'ok'], [{ status: 401 }, 'unauthorized'],
    [{ status: 200, payload: { code: 'unauthenticated' } }, 'unauthorized']]) {
    const { calls, result } = await read({ hub });
    assert.deepEqual(calls, ['desktop']);
    assert.equal(result.status, expected);
  }
});

test('our desktop engine starts only under the version the installed package reports', async t => {
  for (const platform of ['win32', 'darwin']) {
    const read = install(t, { cli: false, platform, version: null });
    const missing = await read();
    assert.deepEqual(missing.calls, []);
    assert.equal(missing.result.status, 'retryable_error');
    assert.equal(desktopVersion(read.engine, platform), undefined);
  }
  const home = mkdtempSync(join(tmpdir(), 'vbu-agy-version-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const resources = join(home, 'resources');
  const engine = join(resources, 'bin', 'language_server.exe');
  mkdirSync(join(resources, 'bin'), { recursive: true });
  writeFileSync(join(resources, 'app.asar'), asar({ 'package.json': JSON.stringify({ version: '2.41.0' }) }));
  assert.equal(desktopVersion(engine, 'win32'), '2.41.0');
  mkdirSync(join(resources, 'app'));
  writeFileSync(join(resources, 'app', 'package.json'), '{ not json');
  assert.equal(desktopVersion(engine, 'win32'), '2.41.0');
  writeFileSync(join(resources, 'app', 'package.json'), JSON.stringify({ version: '2.42.3' }));
  assert.equal(desktopVersion(engine, 'win32'), '2.42.3');
  writeFileSync(join(resources, 'app', 'package.json'), JSON.stringify({ version: '2.42.3; rm -rf' }));
  assert.equal(desktopVersion(engine, 'win32'), '2.41.0');
  assert.equal(desktopVersion(engine, 'linux'), undefined);
  for (const plist of ['<key>CFBundleVersion</key><string>99.9.9</string>',
    '<key>CFBundleShortVersionString</key>\n  <string>2.45.1</string>']) {
    const macEngine = join(home, 'Antigravity.app', 'Contents', 'Resources', 'bin', 'language_server');
    mkdirSync(dirname(macEngine), { recursive: true });
    writeFileSync(join(home, 'Antigravity.app', 'Contents', 'Info.plist'), plist);
    assert.equal(desktopVersion(macEngine, 'darwin'), plist.includes('Short') ? '2.45.1' : undefined);
  }
});

/** A minimal Electron asar archive: pickled header length, JSON index, then the files. */
function asar(files) {
  const index = { files: {} };
  const bodies = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    index.files[name] = { size: body.length, offset: String(offset) };
    bodies.push(body);
    offset += body.length;
  }
  const json = Buffer.from(JSON.stringify(index));
  const padded = Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(16 + padded);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(8 + padded, 4);
  header.writeUInt32LE(4 + padded, 8);
  header.writeUInt32LE(json.length, 12);
  json.copy(header, 16);
  return Buffer.concat([header, ...bodies]);
}

test('asar reading rejects archives it cannot index safely', t => {
  const root = mkdtempSync(join(tmpdir(), 'vbu-agy-asar-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'app.asar');
  for (const [content, expected] of [
    [asar({ 'package.json': '{"version":"3.0.1"}', 'main.js': 'x' }), '3.0.1'],
    [asar({ 'main.js': 'x' }), undefined],
    [asar({ 'package.json': '{"version":"latest"}' }), undefined],
    [Buffer.from('not an archive at all'), undefined],
    [Buffer.alloc(8), undefined],
  ]) {
    writeFileSync(file, content);
    assert.equal(asarPackageVersion(file), expected);
  }
  assert.equal(asarPackageVersion(join(root, 'missing.asar')), undefined);
});

test('all steps share one deadline, including version detection and cleanup', async t => {
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  for (const [platform, readMs, cleanupMs] of [['darwin', 18150, 1850], ['win32', 16900, 3100]]) {
    const dual = install(t, { platform });
    const cli = install(t, { platform, desktop: false });
    const desktop = install(t, { platform, cli: false });
    const reserve = 4000 + 5000 + cleanupMs;
    // With no running desktop found, the time held for it goes back to /usage.
    const idleReserve = 5000 + cleanupMs;
    const running = [{ pid: '7', token: 'running-token', ports: [1111] }];
    const version = ['version', 2000];
    for (const [read, spent, expected, extra = {}] of [
      [desktop, {}, [['desktop', readMs]]],
      [cli, { version: 500 }, [version, ['usage', readMs - 1000]]],
      [dual, { version: 500 }, [version, ['usage', readMs - 1000 - idleReserve], ['desktop', 5000]]],
      // A hanging desktop port still leaves the engine its 5s.
      [dual, { version: 500 }, [version, ['usage', readMs - 1000 - reserve], ['https:1111', 4000], ['desktop', 5000]],
        { running }],
      // A slow version check: /usage only if 3s remain beyond the desktop's share.
      [dual, {}, [version, ['usage', readMs - 2000 - cleanupMs - idleReserve], ['desktop', 5000]]],
      [dual, {}, readMs - 2000 - cleanupMs - reserve >= 3000
        ? [version, ['usage', readMs - 2000 - cleanupMs - reserve], ['https:1111', 4000], ['desktop', 5000]]
        // No time for /usage: the running desktop gets what the engine does not need, over both schemes.
        : [version, ['https:1111', 4000], ['http:1111', readMs - 2000 - cleanupMs - 4000 - 5000], ['desktop', 5000]],
        { running }],
    ]) {
      elapsed = 0;
      const attempts = [];
      const { result } = await read({
        command: new TimedOut(), hub: { status: 503 }, answer: () => new TimedOut(), ...extra,
        onAttempt(name, limit) {
          attempts.push([name, limit]);
          const used = spent[name] ?? limit;
          // Requests to a running desktop launch nothing; our own processes pay the worst cleanup.
          elapsed += used + (name.includes(':') ? 0 : used === limit ? cleanupMs : 500);
        },
      });
      assert.deepEqual(attempts, expected, platform);
      assert.ok(elapsed <= 20000, `${platform} exceeded deadline at ${elapsed}ms`);
      assert.equal(result.status, 'retryable_error');
    }
  }
});

test('cleanup that exhausts the shared deadline prevents another launch', async t => {
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  const { calls, result } = await install(t)({ version: new TimedOut(), onAttempt() { elapsed = 20000; } });
  assert.deepEqual(calls, ['version']);
  assert.equal(result.status, 'retryable_error');
});

/** One machine for the read-only-after-use rules: a fake read, real records and conversation stores. */
function machine(t) {
  const home = mkdtempSync(join(tmpdir(), 'vbu-agy-gate-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const environment = { PATH: '', ANTIGRAVITY_CLI_PATH: process.execPath, VIBE_USAGE_QUOTA_CACHE_DIR: join(home, 'quota') };
  const stores = { desktop: join(home, '.gemini', 'antigravity', 'conversations'),
    cli: join(home, '.gemini', 'antigravity-cli', 'conversations'),
    ide: join(home, '.gemini', 'antigravity-ide', 'conversations') };
  for (const store of Object.values(stores)) mkdirSync(store, { recursive: true });
  writeFileSync(join(stores.desktop, 'earlier.db'), 'used before');
  const reads = [];
  let written = 0;
  const T0 = Date.parse('2026-11-24T10:00:00Z');
  const at = minutes => new Date(T0 + minutes * 60_000);
  const reading = (now = at(0)) => quotaResult({ id: 'antigravity', status: 'ok', fetchedAt: now, meters: [
    { id: 'gemini-5h', label: '5h', utilization: 40, resetsAt: new Date(T0 + 3_600_000).toISOString(), windowSeconds: 18000 },
    { id: 'gemini-weekly', label: '7d', utilization: 10, resetsAt: new Date(T0 + 3 * 86_400_000).toISOString(), windowSeconds: 604800 },
  ] });
  let respond = options => ({ result: reading(options.now) });
  return {
    home, environment, stores, reads, at, reading, T0,
    statePath: join(home, 'quota', 'antigravity-quota.json'),
    answer(next) { respond = next; },
    use(store = 'cli', name = 'conversation.db') { writeFileSync(join(stores[store], name), 'x'.repeat(++written)); },
    fetch(now, extra = {}) {
      return fetchAntigravityQuota({ environment, home, platform: 'linux', now, ...extra,
        readImpl: async options => { reads.push(options); return respond(options); } });
    },
  };
}

test('Google is asked only after Antigravity was used, at most once per 5 minutes', async t => {
  const m = machine(t);
  const first = await m.fetch(m.at(0));
  assert.equal(m.reads.length, 1);
  assert.equal(first.status, 'ok');
  for (const [minutes, store, expectedReads] of [[1, null, 1], [2, 'cli', 1], [5, null, 2], [11, null, 2],
    [12, 'desktop', 3], [30, 'ide', 4]]) {
    if (store) m.use(store);
    const result = await m.fetch(m.at(minutes));
    assert.equal(m.reads.length, expectedReads, `${minutes} min`);
    assert.equal(result.status, 'ok');
    assert.equal(result.source, 'live');
    assert.equal(result.fetchedAt, m.at(minutes).toISOString());
  }
  // A read-only open (our own sync) changes only `.db-shm`.
  writeFileSync(join(m.stores.cli, 'conversation.db-shm'), 'opened');
  const remembered = await m.fetch(m.at(59));
  assert.equal(m.reads.length, 4);
  assert.equal(remembered.dataAsOf, m.at(30).toISOString());
  assert.deepEqual(remembered.meters, m.reading().meters);
  const record = JSON.parse(readFileSync(m.statePath, 'utf8'));
  assert.deepEqual(Object.keys(record).sort(), ['agyLoginBlocked', 'agyVersion', 'attemptAt', 'failure', 'failures',
    'reading', 'seen', 'version']);
  if (process.platform !== 'win32') assert.equal(statSync(m.statePath).mode & 0o777, 0o600);
});

test('windows that reset while Antigravity sat unused show as recovered', async t => {
  const m = machine(t);
  await m.fetch(m.at(0));
  const afterFiveHour = await m.fetch(m.at(120));
  assert.equal(m.reads.length, 1);
  assert.deepEqual(afterFiveHour.meters, [
    { id: 'gemini-5h', label: '5h', utilization: 0, windowSeconds: 18000 },
    m.reading().meters[1],
  ]);
  assert.equal(afterFiveHour.dataAsOf, new Date(m.T0 + 3_600_000).toISOString());
  const afterWeek = await m.fetch(m.at(4 * 24 * 60));
  assert.deepEqual(afterWeek.meters.map(meter => [meter.utilization, meter.resetsAt]), [[0, undefined], [0, undefined]]);
  assert.equal(afterWeek.dataAsOf, new Date(m.T0 + 3 * 86_400_000).toISOString());

  // Used after the reset: the new window's usage is unknown, so it is left out until the next read.
  const busy = machine(t);
  await busy.fetch(busy.at(0));
  busy.use();
  const unknown = await busy.fetch(busy.at(62), { egressGate: async () => ({ message: 'held back' }) });
  assert.equal(unknown.status, 'unsupported', 'used and due: it would ask now');
  const meanwhile = await busy.fetch(busy.at(3));
  assert.deepEqual(meanwhile.meters, busy.reading().meters, 'before the reset nothing changes');
  busy.answer(options => ({ result: quotaResult({ id: 'antigravity', status: 'retryable_error', fetchedAt: options.now }) }));
  const failed = await busy.fetch(busy.at(63));
  assert.equal(failed.source, 'cache');
  assert.deepEqual(failed.meters, [busy.reading().meters[1]]);
  // Newer than the reset, so a client that already shows 0% for the window replaces it.
  assert.equal(failed.dataAsOf, busy.at(63).toISOString());

  const shown = machine(t);
  await shown.fetch(shown.at(0));
  const recovered = await shown.fetch(shown.at(61));
  assert.equal(recovered.meters[0].utilization, 0);
  shown.use();
  const afterUse = await shown.fetch(shown.at(62), { egressGate: async () => null });
  assert.equal(afterUse.status, 'ok', 'asked again');
  const withinFloor = await shown.fetch(shown.at(63));
  assert.equal(withinFloor.dataAsOf, shown.at(62).toISOString());

  // A window without a reset time is over once its whole length has passed.
  const rolling = machine(t);
  rolling.answer(options => ({ result: quotaResult({ id: 'antigravity', status: 'ok', fetchedAt: options.now,
    meters: [{ id: 'gemini-5h', label: '5h', utilization: 70, windowSeconds: 18000 }] }) }));
  await rolling.fetch(rolling.at(0));
  assert.equal((await rolling.fetch(rolling.at(299))).meters[0].utilization, 70);
  assert.equal((await rolling.fetch(rolling.at(300))).meters[0].utilization, 0);
});

test('a computer where Antigravity was never used asks nothing until a conversation exists', async t => {
  const m = machine(t);
  rmSync(join(m.stores.desktop, 'earlier.db'));
  const never = await m.fetch(m.at(0));
  assert.equal(never.status, 'no_data');
  assert.equal(m.reads.length, 0);
  assert.equal(existsSync(m.statePath), false);
  m.use('ide');
  assert.equal((await m.fetch(m.at(1))).status, 'ok');
  assert.equal(m.reads.length, 1);
});

test('failed reads back off from 5 minutes to an hour, with or without use', async t => {
  const m = machine(t);
  m.answer(options => ({ result: quotaResult({ id: 'antigravity', status: 'retryable_error', fetchedAt: options.now }) }));
  let minutes = 0;
  assert.equal((await m.fetch(m.at(minutes))).status, 'retryable_error');
  for (const wait of [5, 10, 20, 40, 60, 60]) {
    const reads = m.reads.length;
    assert.equal((await m.fetch(m.at(minutes + wait - 0.01))).status, 'retryable_error');
    assert.equal(m.reads.length, reads, `before ${wait} min`);
    minutes += wait;
    await m.fetch(m.at(minutes));
    assert.equal(m.reads.length, reads + 1, `after ${wait} min`);
  }
  // Success clears the backoff; from then on only use leads to another read.
  m.answer(options => ({ result: m.reading(options.now) }));
  minutes += 60;
  assert.equal((await m.fetch(m.at(minutes))).status, 'ok');
  const reads = m.reads.length;
  await m.fetch(m.at(minutes + 30));
  assert.equal(m.reads.length, reads);
  m.use();
  await m.fetch(m.at(minutes + 35));
  assert.equal(m.reads.length, reads + 1);
});

test('a failed read keeps the last numbers, marked as not from this read', async t => {
  const m = machine(t);
  await m.fetch(m.at(0));
  m.answer(options => ({ result: quotaResult({ id: 'antigravity', status: 'retryable_error', fetchedAt: options.now }) }));
  m.use();
  for (const minutes of [5, 6]) {
    const result = await m.fetch(m.at(minutes));
    assert.equal(result.status, 'ok');
    assert.equal(result.source, 'cache');
    assert.equal(result.dataAsOf, m.at(0).toISOString());
    assert.deepEqual(result.meters, m.reading().meters);
  }
  assert.equal(m.reads.length, 2);
});

test('a sign-in failure is remembered and retried only after Antigravity is used again', async t => {
  const m = machine(t);
  m.answer(options => ({ result: quotaResult({ id: 'antigravity', status: 'unauthorized', fetchedAt: options.now }) }));
  assert.equal((await m.fetch(m.at(0))).status, 'unauthorized');
  assert.equal((await m.fetch(m.at(120))).status, 'unauthorized');
  assert.equal(m.reads.length, 1);
  m.use();
  m.answer(options => ({ result: m.reading(options.now) }));
  assert.equal((await m.fetch(m.at(121))).status, 'ok');
  assert.equal(m.reads.length, 2);

  // After a sign-in failure the old numbers may be another account's: never shown again.
  m.answer(options => ({ result: quotaResult({ id: 'antigravity', status: 'unauthorized', fetchedAt: options.now }) }));
  m.use('cli', 'switch.db');
  assert.equal((await m.fetch(m.at(130))).status, 'unauthorized');
  m.answer(options => ({ result: quotaResult({ id: 'antigravity', status: 'retryable_error', fetchedAt: options.now }) }));
  m.use('cli', 'other-account.db');
  assert.equal((await m.fetch(m.at(140))).status, 'retryable_error');
});

test('agy is skipped after it asked for sign-in until agy itself is used or replaced', async t => {
  const m = machine(t);
  const memo = { binary: 'fixture build', supported: true };
  m.answer(options => ({ result: m.reading(options.now), agyUnusable: 'login', agyVersion: memo }));
  await m.fetch(m.at(0));
  m.answer(options => ({ result: m.reading(options.now) }));
  m.use('desktop');
  await m.fetch(m.at(5));
  assert.equal(m.reads.at(-1).skipAgy, true);
  assert.equal(m.reads.at(-1).agyLoggedOut, true);
  assert.deepEqual(m.reads.at(-1).agyVersion, memo);
  m.use('desktop', 'second.db');
  await m.fetch(m.at(10));
  assert.equal(m.reads.at(-1).skipAgy, true);
  m.use('cli');
  await m.fetch(m.at(15));
  assert.equal(m.reads.at(-1).skipAgy, false);

  m.answer(options => ({ result: m.reading(options.now), agyUnusable: 'login' }));
  m.use('cli', 'again.db');
  await m.fetch(m.at(20));
  const replaced = join(m.home, 'agy-copy');
  copyFileSync(process.execPath, replaced);
  fs.chmodSync(replaced, 0o755);
  m.use('desktop', 'third.db');
  await m.fetch(m.at(25), { environment: { ...m.environment, ANTIGRAVITY_CLI_PATH: replaced } });
  assert.equal(m.reads.at(-1).skipAgy, false);

  // A hang retires agy too, but is not remembered as a sign-in answer, and keeps the numbers.
  m.answer(options => ({ result: quotaResult({ id: 'antigravity', status: 'retryable_error', fetchedAt: options.now }),
    agyUnusable: 'hang' }));
  m.use('desktop', 'fourth.db');
  const hung = await m.fetch(m.at(30));
  assert.equal(hung.source, 'cache');
  m.answer(options => ({ result: quotaResult({ id: 'antigravity', status: 'retryable_error', fetchedAt: options.now }) }));
  const next = await m.fetch(m.at(35));
  assert.equal(m.reads.at(-1).skipAgy, true);
  assert.equal(m.reads.at(-1).agyLoggedOut, false);
  assert.equal(next.status, 'ok');
  assert.equal(next.source, 'cache');
});

test('the egress check runs only when Google would be asked, and a pause records no attempt', async t => {
  const m = machine(t);
  const checks = [];
  const pause = { message: 'Paused', pauseReason: 'egressRegionUnsupported', region: 'CN' };
  let paused = pause;
  const egressGate = async () => { checks.push(paused); return paused; };
  const first = await m.fetch(m.at(0), { egressGate });
  assert.equal(first.status, 'unsupported');
  assert.equal(m.reads.length, 0);
  assert.equal(existsSync(m.statePath), false);
  paused = null;
  assert.equal((await m.fetch(m.at(1), { egressGate })).status, 'ok');
  assert.equal(m.reads.length, 1);
  await m.fetch(m.at(2), { egressGate });
  assert.equal(checks.length, 2, 'an answer from the record checks nothing');
});

test('nothing is asked when the attempt cannot be recorded', async t => {
  const m = machine(t);
  const file = join(m.home, 'not-a-directory');
  writeFileSync(file, '');
  const result = await m.fetch(m.at(0), { environment: { ...m.environment, VIBE_USAGE_QUOTA_CACHE_DIR: file } });
  assert.equal(m.reads.length, 0);
  assert.equal(result.status, 'retryable_error');
});

test('two processes at the same moment ask only once', async t => {
  const m = machine(t);
  m.answer(async options => { await delay(50); return { result: m.reading(options.now) }; });
  const [one, two] = await Promise.all([m.fetch(m.at(0)), m.fetch(m.at(0))]);
  assert.equal(m.reads.length, 1);
  assert.deepEqual([one.status, two.status].sort(), ['no_data', 'ok']);
  // Also while the egress check keeps both waiting before the attempt is recorded.
  m.use();
  const egressGate = async () => { await delay(20); return null; };
  await Promise.all([m.fetch(m.at(10), { egressGate }), m.fetch(m.at(10), { egressGate })]);
  assert.equal(m.reads.length, 2);
});

test('a clock set back, a corrupt record or a missing installation do not block or fake a read', async t => {
  const m = machine(t);
  await m.fetch(m.at(60));
  m.use();
  await m.fetch(m.at(0));
  assert.equal(m.reads.length, 2);
  for (const content of ['{', '[]', JSON.stringify({ version: 99, attemptAt: m.at(0).toISOString() }),
    JSON.stringify({ version: 1, reading: { readAt: 'never', meters: [] }, failures: -3, failure: 'odd' })]) {
    writeFileSync(m.statePath, content);
    await m.fetch(m.at(1));
  }
  assert.equal(m.reads.length, 6);
  const missing = await m.fetch(m.at(2), { environment: { PATH: '', VIBE_USAGE_QUOTA_CACHE_DIR: join(m.home, 'other') } });
  assert.equal(missing.status, 'missing_credentials');
  assert.equal(existsSync(join(m.home, 'other')), false);
});

test('the registry passes the reading through without its own cache', async t => {
  const m = machine(t);
  const options = { environment: m.environment, home: m.home, platform: 'linux', now: m.at(0),
    readImpl: async ({ now }) => ({ result: m.reading(now) }) };
  const { products: [result] } = await fetchQuotaProducts(['antigravity'], options);
  assert.equal(result.status, 'ok');
  assert.equal(result.cacheScope, undefined);
  assert.equal(existsSync(join(m.home, 'quota', 'quota-cache.json')), false);
  assert.ok(existsSync(m.statePath));
});

test('running desktop servers come only from this user\'s Antigravity language servers', async () => {
  const ps = [
    '  101   501 /Applications/Antigravity.app/Contents/Resources/bin/language_server --csrf_token 1234abcd-ef00-4a1b --app_data_dir antigravity',
    '  102   502 /Applications/Antigravity.app/Contents/Resources/bin/language_server --csrf_token aaaabbbbcccc',
    '  103   501 /Applications/Antigravity.app/Contents/Resources/bin/language_server --csrf_token ccccdddd --gemini_dir /tmp/vibe-usage-agy-quota-x',
    '  104   501 /usr/local/bin/language_server --csrf_token eeeeffff0000',
    '  105   501 /Applications/Antigravity.app/Contents/Resources/bin/language_server --app_data_dir antigravity',
    '  106   501 /Applications/Antigravity IDE.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm --csrf_token=99998888-7777',
  ].join('\n');
  assert.deepEqual(parseUnixProcessList(ps, 501), [{ pid: '101', token: '1234abcd-ef00-4a1b' },
    { pid: '106', token: '99998888-7777' }]);
  assert.deepEqual(parseLsofPorts('p101\nf12\nn127.0.0.1:52345\nf13\nn[::1]:52346\nf14\nn*:52345\nn127.0.0.1:99999\n'),
    [52345, 52346]);
  const windows = [
    '---', 'ProcessId=201', 'Ports=50001,50002,50001',
    'CommandLine="C:\\Users\\Ada\\AppData\\Local\\Programs\\antigravity\\resources\\bin\\language_server.exe" --csrf_token 0a0b0c0d-1111\r',
    '---', 'ProcessId=202', 'Ports=', 'CommandLine=C:\\x\\antigravity\\language_server.exe --csrf_token 0a0b0c0d2222',
    '---', 'ProcessId=203', 'Ports=50003', 'CommandLine=C:\\tools\\language_server.exe --csrf_token 0a0b0c0d3333',
  ].join('\n');
  assert.deepEqual(parseWindowsServers(windows), [{ pid: '201', token: '0a0b0c0d-1111', ports: [50001, 50002] }]);

  const calls = [];
  const execImpl = async (file, args) => {
    calls.push(file);
    if (file === '/bin/ps') return ps;
    if (/lsof$/.test(file)) return args.includes('101') ? 'p101\nn127.0.0.1:52345\n' : '';
    if (file === 'powershell.exe') throw new Error('blocked by policy');
    if (file === 'pwsh.exe') return windows;
    throw new Error(`unexpected ${file}`);
  };
  assert.deepEqual(await findRunningAntigravityServers({ platform: 'darwin', execImpl, uid: 501 }),
    [{ pid: '101', token: '1234abcd-ef00-4a1b', ports: [52345] }]);
  assert.deepEqual(await findRunningAntigravityServers({ platform: 'win32', execImpl }),
    [{ pid: '201', token: '0a0b0c0d-1111', ports: [50001, 50002] }]);
  calls.length = 0;
  assert.deepEqual(await findRunningAntigravityServers({ platform: 'linux', execImpl }), []);
  assert.deepEqual(calls, []);
  assert.deepEqual(await findRunningAntigravityServers({ platform: 'darwin', execImpl: async () => { throw new Error('no ps'); } }), []);
});

test('agy children turn off agy\'s self-update and get browser stubs first on PATH, only for themselves', async t => {
  const stopAtSpawn = new Error('fixture stopped at spawn');
  for (const platform of ['darwin', 'win32']) {
    const seen = [];
    // Windows keeps its own spelling of the PATH name; there is only ever one.
    const pathKey = platform === 'win32' ? 'Path' : 'PATH';
    const environment = Object.freeze({ [pathKey]: platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin',
      agy_cli_disable_auto_update: 'false', BIGMODEL_API_KEY: 'fixture-domestic', HTTPS_PROXY: 'http://proxy.invalid' });
    for (const args of [['--version'], ['-p', '/usage', '--output-format', 'json']]) {
      await assert.rejects(runAntigravityCommand('fixture-agy', args, { environment, platform, timeoutMs: 3000,
        spawnImpl(binary, received, { env, cwd }) {
          seen.push(env);
          assert.deepEqual(received, args);
          const stubs = join(cwd, 'browser-stubs');
          assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
          assert.equal(env.agy_cli_disable_auto_update, undefined);
          assert.equal(env.BIGMODEL_API_KEY, undefined);
          assert.equal(env.HTTPS_PROXY, 'http://proxy.invalid');
          assert.deepEqual(Object.keys(env).filter(key => key.toUpperCase() === 'PATH'), [pathKey]);
          const sep = platform === 'win32' ? ';' : delimiter;
          assert.equal(env[pathKey], `${stubs}${sep}${environment[pathKey]}`);
          if (platform === 'win32') {
            for (const name of ['rundll32.bat', 'browser.bat']) {
              assert.match(readFileSync(join(stubs, name), 'utf8'), /exit \/b 1/);
            }
            assert.equal(env.BROWSER, join(stubs, 'browser.bat'));
          } else {
            for (const name of ['open', 'xdg-open', 'browser']) {
              assert.match(readFileSync(join(stubs, name), 'utf8'), /^#!\/bin\/sh\n/);
              // Windows hosts have no POSIX permission bits to check.
              if (process.platform !== 'win32') assert.equal(statSync(join(stubs, name)).mode & 0o777, 0o700);
            }
            assert.equal(env.BROWSER, join(stubs, 'browser'));
          }
          throw stopAtSpawn;
        } }), stopAtSpawn);
    }
    assert.equal(seen.length, 2);
  }
  // The desktop engine is not agy: no stubs, its own temporary data root.
  const inherited = { PATH: '/fixture/bin', ANTIGRAVITY_GEMINI_DIR: '/fixture/custom-login' };
  await assert.rejects(withAntigravitySession('fixture-engine', null, {
    environment: { ...inherited, Z_AI_API_KEY: 'fixture-overseas' }, desktopVersion: '2.40.1', timeoutMs: 3000,
    spawnImpl(binary, args, { env, cwd }) {
      assert.equal(args[args.indexOf('--gemini_dir') + 1], cwd);
      assert.deepEqual(env, { ...inherited, ANTIGRAVITY_GEMINI_DIR: cwd, ANTIGRAVITY_VSCODE_HOST: '1' });
      throw stopAtSpawn;
    },
  }), stopAtSpawn);
  await assert.rejects(withAntigravitySession('fixture-engine', null, { environment: {} }), /unavailable/);
});

test('agy -p waits through silent auth but stops at a sign-in diagnostic', async () => {
  for (const [lines, expected] of [
    [[silentAuth, JSON.stringify(usage)], 'output'],
    [[noTerminal], LoginRequired], [['Print mode: not logged in'], LoginRequired],
    [['https://accounts.google.com/o/oauth2/auth?private'], LoginRequired],
  ]) {
    const script = `const lines = JSON.parse(process.argv[1]);
      for (const line of lines.slice(0, -1)) process.stderr.write(line + '\\n');
      setTimeout(() => { process.stdout.write(lines.at(-1)); if (lines.length === 1) setInterval(() => {}, 1000); }, 100);`;
    const action = runAntigravityCommand('fixture-agy', ['-p', '/usage', '--output-format', 'json'], {
      environment: {}, timeoutMs: 3000,
      spawnImpl: (_, _args, options) => spawn(process.execPath, ['-e', script, JSON.stringify(lines)], options),
    });
    if (expected === 'output') assert.equal((await action).stdout, JSON.stringify(usage));
    else await assert.rejects(action, expected);
  }
});

if (process.platform !== 'win32') {
  test('a browser launcher reached through PATH or BROWSER is a stub, and agy stops right away', async t => {
    const root = mkdtempSync(join(tmpdir(), 'vbu-agy-browser-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const system = join(root, 'system');
    mkdirSync(system);
    for (const name of ['open', 'xdg-open']) {
      writeFileSync(join(system, name), `#!/bin/sh\necho "$@" >> '${join(root, 'real-browser')}'\n`, { mode: 0o755 });
    }
    for (const launcher of ['open', 'xdg-open', '$BROWSER']) {
      const started = Date.now();
      const script = `require('node:child_process').spawnSync('/bin/sh', ['-c', ${JSON.stringify(`${launcher} https://accounts.google.com/o/oauth2/auth`)}]);
        setInterval(() => {}, 1000);`;
      await assert.rejects(runAntigravityCommand('fixture-agy', ['-p', '/usage', '--output-format', 'json'], {
        environment: { PATH: `${system}${delimiter}/usr/bin${delimiter}/bin`, BROWSER: join(system, 'open') },
        timeoutMs: 5000, spawnImpl: (_, _args, options) => spawn(process.execPath, ['-e', script], options),
      }), LoginRequired);
      assert.ok(Date.now() - started < 3000, launcher);
    }
    assert.equal(existsSync(join(root, 'real-browser')), false);
  });
}

test('the owned desktop engine uses a temporary data root, closes stdin and stops on login URLs', async () => {
  const tokens = new Set();
  for (const mode of ['quota', 'marker', 'oauth']) {
    let child, cwd, endpoint, printedToken;
    const action = withAntigravitySession('fixture-engine', async ep => {
      endpoint = ep;
      if (mode === 'oauth') return new Promise(() => {}); // login while an RPC is in flight
      return 'quota';
    }, { desktopVersion: '2.40.1', timeoutMs: 4000, environment: {}, spawnImpl: (_, args, options) => {
      cwd = options.cwd;
      printedToken = args[args.indexOf('--csrf_token') + 1];
      assert.deepEqual(args, ['--standalone', '--override_ide_name', 'antigravity', '--subclient_type', 'hub',
        '--override_ide_version', '2.40.1', '--override_user_agent_name', 'antigravity',
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
          process.stdout.write('Print mode: not logged in\\n');
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
  test('the quota CLI asks agy once, answers from its record until agy is used again, and never opens a browser', t => {
    const cli = fileURLToPath(new URL('../bin/vibe-usage.js', import.meta.url));
    // A regression in the fake CLI path must never launch a system-wide Mac install or scan processes.
    const isolate = "data:text/javascript,Object.defineProperty(process,'platform',{value:'linux'})";
    function machineFor(mode) {
      const home = mkdtempSync(join(tmpdir(), 'vbu-agy-cli-'));
      t.after(() => rmSync(home, { recursive: true, force: true }));
      const binary = join(home, 'agy');
      writeFileSync(binary, `#!/usr/bin/env node
        const args = process.argv.slice(2).join(' ');
        const { appendFileSync, realpathSync } = require('node:fs');
        if ('ANTIGRAVITY_GEMINI_DIR' in process.env || process.cwd() === realpathSync(process.env.HOME)) process.exit(1);
        if (process.env.AGY_CLI_DISABLE_AUTO_UPDATE !== 'true') process.exit(1);
        if (args === '--version') {
          appendFileSync(process.env.FIXTURE_TRACE, 'version ');
          console.log('1.5.13');
        } else if (args === '-p /usage --output-format json') {
          appendFileSync(process.env.FIXTURE_TRACE, 'usage ');
          if (process.env.FIXTURE_MODE === 'login') {
            process.stderr.write('Print mode: not logged in and no controlling terminal');
            setInterval(() => {}, 1000);
          } else if (process.env.FIXTURE_MODE === 'browser') {
            require('node:child_process').spawnSync('open', ['https://accounts.google.com/o/oauth2/auth']);
            setInterval(() => {}, 1000);
          } else console.log(process.env.FIXTURE_USAGE);
        } else process.exit(1);\n`, { mode: 0o700 });
      const system = join(home, 'system');
      mkdirSync(system);
      writeFileSync(join(system, 'open'), `#!/bin/sh\ntouch '${join(home, 'real-browser')}'\n`, { mode: 0o755 });
      const trace = join(home, 'calls');
      writeFileSync(trace, '');
      const used = join(home, '.gemini', 'antigravity-cli', 'conversations');
      mkdirSync(used, { recursive: true });
      writeFileSync(join(used, 'earlier.db'), 'used before');
      const run = () => JSON.parse(execFileSync(process.execPath,
        ['--import', isolate, cli, 'quota', 'fetch', '--product', 'antigravity', '--json'], {
          timeout: 8000, env: { HOME: home, PATH: `${dirname(process.execPath)}${delimiter}${system}`,
            ANTIGRAVITY_CLI_PATH: binary, TMPDIR: tmpdir(), FIXTURE_USAGE: JSON.stringify(usage),
            FIXTURE_MODE: mode, FIXTURE_TRACE: trace },
        }));
      return { home, run, calls: () => readFileSync(trace, 'utf8'),
        record: join(home, '.vibe-usage', 'antigravity-quota.json') };
    }

    const ok = machineFor('ok');
    const first = ok.run();
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.products[0].status, 'ok');
    assert.equal(ok.calls(), 'version usage ');
    const again = ok.run().products[0];
    assert.equal(again.status, 'ok');
    assert.equal(again.dataAsOf, first.products[0].dataAsOf);
    assert.equal(ok.calls(), 'version usage ');
    writeFileSync(join(ok.home, '.gemini', 'antigravity-cli', 'conversations', 'session.db'), 'used');
    ok.run();
    assert.equal(ok.calls(), 'version usage ', 'used, but within 5 minutes');
    const record = JSON.parse(readFileSync(ok.record, 'utf8'));
    record.attemptAt = new Date(Date.now() - 6 * 60_000).toISOString();
    writeFileSync(ok.record, JSON.stringify(record));
    assert.equal(ok.run().products[0].status, 'ok');
    assert.equal(ok.calls(), 'version usage usage ');
    assert.equal(existsSync(join(ok.home, '.vibe-usage', 'quota-cache.json')), false);
    assert.equal(existsSync(join(ok.home, '.gemini', 'antigravity')), false);

    for (const mode of ['login', 'browser']) {
      const signedOut = machineFor(mode);
      assert.equal(signedOut.run().products[0].status, 'unauthorized');
      assert.equal(signedOut.run().products[0].status, 'unauthorized');
      assert.equal(signedOut.calls(), 'version usage ');
      assert.equal(existsSync(join(signedOut.home, 'real-browser')), false);
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
