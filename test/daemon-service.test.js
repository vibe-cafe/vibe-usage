import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACKAGE_SPEC,
  generateLaunchdPlist,
  generateSystemdUnit,
  generateWindowsTaskCmd,
  generateWindowsTaskVbs,
  generateWindowsTaskXml,
  installedModeFromText,
  isNpxCachePath,
  launchPathsFromText,
  missingLaunchPaths,
  npxLauncher,
  parseWindowsTaskInvocation,
  resolveServiceLaunch,
  stableRuntimePath,
  windowsDaemonProcessExpression,
} from '../src/daemon-service.js';

test('systemd service preserves CLAUDE_CONFIG_DIR', () => {
  const unit = generateSystemdUnit('/usr/bin/node', '/opt/vibe usage/bin.js', '/tmp/claude "work"');
  assert.match(unit, /Environment="CLAUDE_CONFIG_DIR=\/tmp\/claude \\"work\\""/);
});

test('launchd service preserves and XML-escapes CLAUDE_CONFIG_DIR', () => {
  const plist = generateLaunchdPlist('/usr/bin/node', '/opt/vibe-usage/bin.js', '/tmp/claude&a<b>');
  assert.match(plist, /<key>CLAUDE_CONFIG_DIR<\/key>/);
  assert.match(plist, /<string>\/tmp\/claude&amp;a&lt;b&gt;<\/string>/);
});

test('systemd service preserves MiMoCode database path overrides', () => {
  const unit = generateSystemdUnit('/usr/bin/node', '/opt/vibe-usage/bin.js', undefined, {
    MIMOCODE_HOME: '/tmp/mimo "home"',
    MIMOCODE_DB: '/tmp/mimo "home"/custom.db',
    XDG_DATA_HOME: '/tmp/xdg "data"',
  });
  assert.match(unit, /Environment="MIMOCODE_HOME=\/tmp\/mimo \\"home\\""/);
  assert.match(unit, /Environment="MIMOCODE_DB=\/tmp\/mimo \\"home\\"\/custom\.db"/);
  assert.match(unit, /Environment="XDG_DATA_HOME=\/tmp\/xdg \\"data\\""/);
});

test('launchd service preserves and XML-escapes MiMoCode database path overrides', () => {
  const plist = generateLaunchdPlist('/usr/bin/node', '/opt/vibe-usage/bin.js', undefined, {
    MIMOCODE_HOME: '/tmp/mimo&a<b>',
    MIMOCODE_DB: '/tmp/mimo&a<b>/custom.db',
    XDG_DATA_HOME: '/tmp/xdg&a<b>',
  });
  assert.match(plist, /<key>MIMOCODE_HOME<\/key>/);
  assert.match(plist, /<string>\/tmp\/mimo&amp;a&lt;b&gt;<\/string>/);
  assert.match(plist, /<key>MIMOCODE_DB<\/key>/);
  assert.match(plist, /<string>\/tmp\/mimo&amp;a&lt;b&gt;\/custom\.db<\/string>/);
  assert.match(plist, /<key>XDG_DATA_HOME<\/key>/);
  assert.match(plist, /<string>\/tmp\/xdg&amp;a&lt;b&gt;<\/string>/);
});

test('systemd service preserves mcode home override', () => {
  const unit = generateSystemdUnit('/usr/bin/node', '/opt/vibe-usage/bin.js', undefined, {
    MCODE_HOME: '/tmp/mcode "home"',
  });
  assert.match(unit, /Environment="MCODE_HOME=\/tmp\/mcode \\"home\\""/);
});

test('launchd service preserves and XML-escapes mcode home override', () => {
  const plist = generateLaunchdPlist('/usr/bin/node', '/opt/vibe-usage/bin.js', undefined, {
    MCODE_HOME: '/tmp/mcode&a<b>',
  });
  assert.match(plist, /<key>MCODE_HOME<\/key>/);
  assert.match(plist, /<string>\/tmp\/mcode&amp;a&lt;b&gt;<\/string>/);
});

test('services preserve the MiniMax Code relocation variables', () => {
  // The mcode CLI relocates its data root with these; a daemon that loses them
  // would sync a different (usually empty) store than the foreground CLI.
  const unit = generateSystemdUnit('/usr/bin/node', '/opt/vibe-usage/bin.js', undefined, {
    MINIMAX_DATA_DIR: '/tmp/minimax "data"',
    MAVIS_DATA_DIR: '/tmp/mavis data',
  });
  assert.match(unit, /Environment="MINIMAX_DATA_DIR=\/tmp\/minimax \\"data\\""/);
  assert.match(unit, /Environment="MAVIS_DATA_DIR=\/tmp\/mavis data"/);

  const plist = generateLaunchdPlist('/usr/bin/node', '/opt/vibe-usage/bin.js', undefined, {
    MINIMAX_DATA_DIR: '/tmp/minimax&a<b>',
  });
  assert.match(plist, /<key>MINIMAX_DATA_DIR<\/key>/);
  assert.match(plist, /<string>\/tmp\/minimax&amp;a&lt;b&gt;<\/string>/);
});

test('windows task cmd quotes paths, preserves env overrides, and doubles literal percents', () => {
  const cmd = generateWindowsTaskCmd(
    'C:\\Program Files\\nodejs\\node.exe',
    'D:\\app with space\\bin.js',
    'C:\\tmp claude dir',
    { MIMOCODE_HOME: 'C:\\mimo 100%', MIMOCODE_DB: 'C:\\mimo 100%\\custom.db' },
  );
  assert.match(cmd, /set "NODE_ENV=production"/);
  assert.match(cmd, /set "CLAUDE_CONFIG_DIR=C:\\tmp claude dir"/);
  assert.match(cmd, /set "MIMOCODE_HOME=C:\\mimo 100%%"/);
  assert.match(cmd, /set "MIMOCODE_DB=C:\\mimo 100%%\\custom\.db"/);
  assert.match(cmd, /"C:\\Program Files\\nodejs\\node\.exe" "D:\\app with space\\bin\.js" daemon/);
  assert.match(cmd, />> ".*daemon\.log" 2>&1/);
});

test('windows process matching follows the recorded Bun invocation', () => {
  const cmd = generateWindowsTaskCmd(
    'C:\\Tools\\bun.exe',
    'D:\\app 100%\\bin.js',
    undefined,
    {},
  );
  const invocation = parseWindowsTaskInvocation(cmd);
  assert.deepEqual(invocation, {
    runtimePath: 'C:\\Tools\\bun.exe',
    binPath: 'D:\\app 100%\\bin.js',
  });

  const expression = windowsDaemonProcessExpression(invocation);
  assert.match(expression, /\$_\.ExecutablePath -ieq 'C:\\Tools\\bun\.exe'/);
  assert.match(expression, /\$_\.CommandLine -like '\*D:\\app 100%\\bin\.js\* daemon\*'/);
  assert.doesNotMatch(expression, /node\.exe/);
});

test('windows task cmd omits unset env overrides', () => {
  const cmd = generateWindowsTaskCmd('/usr/bin/node', '/opt/vibe-usage/bin.js', undefined, {});
  assert.doesNotMatch(cmd, /set "CLAUDE_CONFIG_DIR/);
  assert.doesNotMatch(cmd, /set "MIMOCODE_HOME/);
});

test('windows task vbs launches the cmd with a hidden window and waits on it', () => {
  const vbs = generateWindowsTaskVbs('C:\\vibe-usage\\daemon-task.cmd');
  assert.match(vbs, /Run """C:\\vibe-usage\\daemon-task\.cmd""", 0, True/);
});

test('windows task xml pins logon trigger, unlimited runtime, and escapes XML paths', () => {
  const xml = generateWindowsTaskXml(
    'DESKTOP\\l',
    'C:\\Windows\\System32\\wscript.exe',
    'C:\\a&b dir\\daemon-task.vbs',
  );
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<UserId>DESKTOP\\l<\/UserId>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<Command>C:\\Windows\\System32\\wscript\.exe<\/Command>/);
  assert.match(xml, /<Arguments>"C:\\a&amp;b dir\\daemon-task\.vbs"<\/Arguments>/);
});

test('services preserve Pi store relocation variables', () => {
  const env = {
    PI_CODING_AGENT_DIR: '/tmp/pi "agent"',
    PI_CODING_AGENT_SESSION_DIR: '/tmp/pi&a<b>/sessions',
  };
  const unit = generateSystemdUnit('/usr/bin/node', '/opt/vibe-usage/bin.js', undefined, env);
  assert.match(unit, /Environment="PI_CODING_AGENT_DIR=\/tmp\/pi \\"agent\\""/);
  assert.match(unit, /Environment="PI_CODING_AGENT_SESSION_DIR=\/tmp\/pi&a<b>\/sessions"/);

  const plist = generateLaunchdPlist('/usr/bin/node', '/opt/vibe-usage/bin.js', undefined, env);
  assert.match(plist, /<key>PI_CODING_AGENT_DIR<\/key>/);
  assert.match(plist, /<key>PI_CODING_AGENT_SESSION_DIR<\/key>/);
  assert.match(plist, /<string>\/tmp\/pi&amp;a&lt;b&gt;\/sessions<\/string>/);
});

test('services preserve Cline home, data and session directory overrides', () => {
  for (const key of ['CLINE_DIR', 'CLINE_DATA_DIR', 'CLINE_SESSION_DATA_DIR']) {
    const env = { [key]: '/tmp/cline custom' };
    assert.ok(generateSystemdUnit('/usr/bin/node', '/opt/vibe/bin.js', undefined, env)
      .includes(`Environment="${key}=/tmp/cline custom"`));
    assert.ok(generateLaunchdPlist('/usr/bin/node', '/opt/vibe/bin.js', undefined, env)
      .includes(`<key>${key}</key>`));
    assert.ok(generateWindowsTaskCmd('C:\\node\\node.exe', 'C:\\vibe\\bin.js', undefined,
      { [key]: 'C:\\Cline 100%' }).includes(`set "${key}=C:\\Cline 100%%"`));
  }
});

test('services preserve a custom Hermes home for background sync', () => {
  const env = { HERMES_HOME: '/tmp/hermes&a<b>' };
  const unit = generateSystemdUnit('/usr/bin/node', '/opt/vibe-usage/bin.js', undefined, env);
  assert.match(unit, /Environment="HERMES_HOME=\/tmp\/hermes&a<b>"/);

  const plist = generateLaunchdPlist('/usr/bin/node', '/opt/vibe-usage/bin.js', undefined, env);
  assert.match(plist, /<key>HERMES_HOME<\/key>/);
  assert.match(plist, /<string>\/tmp\/hermes&amp;a&lt;b&gt;<\/string>/);

  const cmd = generateWindowsTaskCmd('C:\\node\\node.exe', 'C:\\vibe\\bin.js', undefined, {
    HERMES_HOME: 'C:\\hermes 100%',
  });
  assert.match(cmd, /set "HERMES_HOME=C:\\hermes 100%%"/);
});

test('services preserve a custom Cola data directory for background sync', () => {
  const env = { COLA_DATA_DIR: '/tmp/cola custom' };
  assert.match(generateSystemdUnit('/usr/bin/node', '/opt/vibe/bin.js', undefined, env),
    /Environment="COLA_DATA_DIR=\/tmp\/cola custom"/);
  assert.match(generateLaunchdPlist('/usr/bin/node', '/opt/vibe/bin.js', undefined, env),
    /<key>COLA_DATA_DIR<\/key>\s*<string>\/tmp\/cola custom<\/string>/);
  assert.match(generateWindowsTaskCmd('C:\\node\\node.exe', 'C:\\vibe\\bin.js', undefined,
    { COLA_DATA_DIR: 'C:\\Cola Data' }), /set "COLA_DATA_DIR=C:\\Cola Data"/);
});

// ---- npx launcher mode: the service re-resolves the package instead of
// pinning a cache path that disappears on `npm cache clean`. ----

test('npx cache detection has a known positive and a known negative', () => {
  assert.equal(isNpxCachePath('/Users/x/.npm/_npx/4b0e2640fe917ac8/node_modules/@vibe-cafe/vibe-usage/bin/vibe-usage.js'), true);
  assert.equal(isNpxCachePath('C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\@vibe-cafe\\vibe-usage\\bin\\vibe-usage.js'), true);
  assert.equal(isNpxCachePath('/opt/homebrew/lib/node_modules/@vibe-cafe/vibe-usage/bin/vibe-usage.js'), false);
});

test('npxLauncher only engages when npx sits next to the running node', () => {
  const found = npxLauncher('/opt/homebrew/bin/node', () => true, 'darwin');
  assert.deepEqual(found, { mode: 'npx', npxPath: '/opt/homebrew/bin/npx', nodeDir: '/opt/homebrew/bin' });
  assert.equal(npxLauncher('/opt/homebrew/bin/node', () => false, 'darwin'), null);
  const win = npxLauncher('C:\\nodejs\\node.exe', p => p.endsWith('npx.cmd'), 'win32');
  assert.deepEqual(win, { mode: 'npx', nodeDir: 'C:\\nodejs', npxPath: 'C:\\nodejs\\npx.cmd' });
  assert.equal(npxLauncher('C:\\nodejs\\node.exe', () => false, 'win32'), null);
});

const NPX_LAUNCHER = { mode: 'npx', npxPath: '/opt/homebrew/bin/npx', nodeDir: '/opt/homebrew/bin' };

test('systemd unit in npx mode runs npx --yes @latest with node on PATH and a slower restart', () => {
  const unit = generateSystemdUnit('/opt/homebrew/bin/node', '/x/_npx/h/bin.js', undefined, {}, NPX_LAUNCHER);
  assert.match(unit, new RegExp(`ExecStart=/opt/homebrew/bin/npx --yes ${PACKAGE_SPEC.replace('/', '\\/')} daemon`));
  assert.match(unit, /Environment="PATH=\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin"/);
  assert.match(unit, /RestartSec=60/);
  assert.doesNotMatch(unit, /_npx/);
});

test('systemd unit without a launcher is byte-for-byte the pinned form', () => {
  const unit = generateSystemdUnit('/usr/bin/node', '/opt/vibe-usage/bin.js', undefined, {});
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/opt\/vibe-usage\/bin\.js daemon/);
  assert.match(unit, /RestartSec=10/);
  assert.doesNotMatch(unit, /PATH=/);
});

test('launchd plist in npx mode runs npx --yes @latest, sets PATH, and throttles relaunches', () => {
  const plist = generateLaunchdPlist('/opt/homebrew/bin/node', '/x/_npx/h/bin.js', undefined, {}, NPX_LAUNCHER);
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/npx<\/string>\s*<string>--yes<\/string>\s*<string>@vibe-cafe\/vibe-usage@latest<\/string>\s*<string>daemon<\/string>/);
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin<\/string>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>60<\/integer>/);
  assert.doesNotMatch(plist, /_npx/);
});

test('launchd plist without a launcher keeps the pinned invocation and no throttle', () => {
  const plist = generateLaunchdPlist('/usr/bin/node', '/opt/vibe-usage/bin.js', undefined, {});
  assert.match(plist, /<string>\/usr\/bin\/node<\/string>\s*<string>\/opt\/vibe-usage\/bin\.js<\/string>\s*<string>daemon<\/string>/);
  assert.doesNotMatch(plist, /ThrottleInterval/);
  assert.doesNotMatch(plist, /<key>PATH<\/key>/);
});

test('windows task cmd in npx mode prepends node dir to PATH and matches the live node process', () => {
  const launcher = { mode: 'npx', npxPath: 'C:\\Program Files\\nodejs\\npx.cmd', nodeDir: 'C:\\Program Files\\nodejs' };
  const cmd = generateWindowsTaskCmd('C:\\Program Files\\nodejs\\node.exe', 'C:\\x\\_npx\\h\\bin.js', undefined, {}, launcher);
  assert.match(cmd, /set "PATH=C:\\Program Files\\nodejs;%PATH%"/);
  assert.match(cmd, /"C:\\Program Files\\nodejs\\npx\.cmd" --yes @vibe-cafe\/vibe-usage@latest daemon >> ".*daemon\.log" 2>&1/);
  assert.doesNotMatch(cmd, /_npx/);

  const invocation = parseWindowsTaskInvocation(cmd);
  assert.deepEqual(invocation, {
    runtimePath: 'C:\\Program Files\\nodejs\\node.exe',
    binPath: 'vibe-usage.js',
    mode: 'npx',
    npxPath: 'C:\\Program Files\\nodejs\\npx.cmd',
  });
  const expression = windowsDaemonProcessExpression(invocation);
  assert.match(expression, /\$_\.ExecutablePath -ieq 'C:\\Program Files\\nodejs\\node\.exe'/);
  assert.match(expression, /\$_\.CommandLine -like '\*vibe-usage\.js\* daemon\*'/);
});

test('installed mode is read back correctly from every generated unit form', () => {
  const pinnedPlist = generateLaunchdPlist('/usr/bin/node', '/Users/x/.npm/_npx/h/node_modules/@vibe-cafe/vibe-usage/bin/vibe-usage.js', undefined, {});
  assert.equal(installedModeFromText(pinnedPlist), 'pinned');
  assert.equal(installedModeFromText(generateLaunchdPlist('/opt/homebrew/bin/node', '/x/bin.js', undefined, {}, NPX_LAUNCHER)), 'npx');
  assert.equal(installedModeFromText(generateSystemdUnit('/usr/bin/node', '/x/bin.js', undefined, {})), 'pinned');
  assert.equal(installedModeFromText(generateSystemdUnit('/opt/homebrew/bin/node', '/x/bin.js', undefined, {}, NPX_LAUNCHER)), 'npx');
  const winLauncher = { mode: 'npx', npxPath: 'C:\\nodejs\\npx.cmd', nodeDir: 'C:\\nodejs' };
  assert.equal(installedModeFromText(generateWindowsTaskCmd('C:\\nodejs\\node.exe', 'C:\\x\\bin.js', undefined, {}, winLauncher)), 'npx');
  assert.equal(installedModeFromText(generateWindowsTaskCmd('C:\\nodejs\\node.exe', 'C:\\x\\bin.js', undefined, {})), 'pinned');
});


test('all service templates preserve KIKI_HOME independently of Kimi Code', () => {
  const env = { KIKI_HOME: '/tmp/kiki-home', KIMI_CODE_HOME: '/tmp/kimi-home' };
  const unit = generateSystemdUnit('/usr/bin/node', '/opt/vibe-usage/bin.js', undefined, env);
  assert.match(unit, /Environment="KIKI_HOME=\/tmp\/kiki-home"/);
  assert.match(unit, /Environment="KIMI_CODE_HOME=\/tmp\/kimi-home"/);
  const plist = generateLaunchdPlist('/usr/bin/node', '/opt/vibe-usage/bin.js', undefined, env);
  assert.match(plist, /<key>KIKI_HOME<\/key>\s*<string>\/tmp\/kiki-home<\/string>/);
  const cmd = generateWindowsTaskCmd('C:\\node\\node.exe', 'C:\\vibe\\bin.js', undefined, { KIKI_HOME: 'C:\\fixture\\kiki', KIMI_CODE_HOME: 'C:\\fixture\\kimi' });
  assert.ok(cmd.includes('set "KIKI_HOME=C:\\fixture\\kiki"'));
  assert.ok(cmd.includes('set "KIMI_CODE_HOME=C:\\fixture\\kimi"'));
});


test('all service templates preserve Kilo database and XDG location overrides', () => {
  const env = { KILO_DB: '/data/kilo & usage.db', XDG_DATA_HOME: '/data/xdg' };
  const unit = generateSystemdUnit('/usr/bin/node', '/opt/vibe/bin.js', undefined, env);
  assert.ok(unit.includes('KILO_DB=/data/kilo & usage.db'));
  assert.ok(unit.includes('XDG_DATA_HOME=/data/xdg'));
  const plist = generateLaunchdPlist('/usr/bin/node', '/opt/vibe/bin.js', undefined, env);
  assert.match(plist, /<key>KILO_DB<\/key>\s*<string>\/data\/kilo &amp; usage.db<\/string>/);
  const cmd = generateWindowsTaskCmd('C:\\node\\node.exe', 'C:\\vibe\\bin.js', undefined, { KILO_DB: 'D:\\kilo\\custom.db', XDG_DATA_HOME: 'D:\\data' });
  assert.ok(cmd.includes('set "KILO_DB=D:\\kilo\\custom.db"'));
  assert.ok(cmd.includes('set "XDG_DATA_HOME=D:\\data"'));
});

// ---- Stable runtime path: a Node upgrade must not strand the service. ----

// realpath over a fixed link table: a path maps to its resolved target, an
// unknown path does not exist.
function fakeRealpath(links) {
  return (path) => {
    if (Object.hasOwn(links, path)) return links[path];
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  };
}

const BREW_KEG_NODE = '/opt/homebrew/Cellar/node/26.8.2/bin/node';

test('Homebrew: the PATH symlink is registered instead of the versioned Cellar path', () => {
  const resolve = fakeRealpath({
    [BREW_KEG_NODE]: BREW_KEG_NODE,
    '/opt/homebrew/bin/node': BREW_KEG_NODE,
  });
  const options = { pathEnv: '/usr/bin:/opt/homebrew/bin:/bin', os: 'darwin', resolve, tempDirs: [] };
  assert.equal(stableRuntimePath(BREW_KEG_NODE, options), '/opt/homebrew/bin/node');
  // Linuxbrew is the same layout under another prefix.
  const linuxKeg = '/home/linuxbrew/.linuxbrew/Cellar/node/26.8.2/bin/node';
  const linux = fakeRealpath({ [linuxKeg]: linuxKeg, '/home/linuxbrew/.linuxbrew/bin/node': linuxKeg });
  assert.equal(
    stableRuntimePath(linuxKeg, { pathEnv: '/home/linuxbrew/.linuxbrew/bin:/usr/bin', os: 'linux', resolve: linux, tempDirs: [] }),
    '/home/linuxbrew/.linuxbrew/bin/node',
  );
});

test('a keg-only formula on PATH through opt/ is registered through opt/', () => {
  const keg = '/opt/homebrew/Cellar/node@22/22.23.1/bin/node';
  const resolve = fakeRealpath({ [keg]: keg, '/opt/homebrew/opt/node@22/bin/node': keg });
  assert.equal(
    stableRuntimePath(keg, { pathEnv: '/opt/homebrew/opt/node@22/bin:/usr/bin', os: 'darwin', resolve, tempDirs: [] }),
    '/opt/homebrew/opt/node@22/bin/node',
  );
});

test('only a PATH entry resolving to the running binary counts; first match wins', () => {
  const resolve = fakeRealpath({
    [BREW_KEG_NODE]: BREW_KEG_NODE,
    '/usr/local/bin/node': '/usr/local/bin/node', // the nodejs.org installer's own binary
    '/opt/homebrew/bin/node': BREW_KEG_NODE,
    '/opt/homebrew/opt/node/bin/node': BREW_KEG_NODE,
  });
  const pathEnv = '/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/opt/node/bin';
  assert.equal(stableRuntimePath(BREW_KEG_NODE, { pathEnv, os: 'darwin', resolve, tempDirs: [] }), '/opt/homebrew/bin/node');
  // Run explicitly with the installer's node: that is what gets registered.
  assert.equal(stableRuntimePath('/usr/local/bin/node', { pathEnv, os: 'darwin', resolve, tempDirs: [] }), '/usr/local/bin/node');
});

test('without a stable PATH entry the running path is kept (nvm, Volta, fnm)', () => {
  // nvm: PATH holds the versioned directory itself; nothing better exists.
  const nvm = '/Users/x/.nvm/versions/node/v22.23.1/bin/node';
  assert.equal(stableRuntimePath(nvm, {
    pathEnv: '/Users/x/.nvm/versions/node/v22.23.1/bin:/usr/bin', os: 'darwin', resolve: fakeRealpath({ [nvm]: nvm }), tempDirs: [],
  }), nvm);

  // Volta: ~/.volta/bin/node is the volta-shim, not node.
  const volta = '/Users/x/.volta/tools/image/node/22.23.1/bin/node';
  assert.equal(stableRuntimePath(volta, {
    pathEnv: '/Users/x/.volta/bin:/usr/bin',
    os: 'darwin',
    resolve: fakeRealpath({ [volta]: volta, '/Users/x/.volta/bin/node': '/Users/x/.volta/bin/volta-shim' }),
    tempDirs: [],
  }), volta);

  // fnm: the per-shell multishell link does resolve to the same binary, but it
  // disappears with the shell, so it is never registered.
  const fnm = '/Users/x/Library/Application Support/fnm/node-versions/v22.23.1/installation/bin/node';
  const multishell = '/Users/x/Library/Caches/fnm_multishells/4242_1762900000000/bin';
  assert.equal(stableRuntimePath(fnm, {
    pathEnv: `${multishell}:/usr/bin`, os: 'darwin', resolve: fakeRealpath({ [fnm]: fnm, [`${multishell}/node`]: fnm }), tempDirs: [],
  }), fnm);
});

test('a PATH entry under the temp directory is never registered', () => {
  const bun = '/Users/x/.bun/bin/bun';
  const shim = '/var/folders/ab/xyz/T/bun-node-1a2b';
  assert.equal(stableRuntimePath(bun, {
    pathEnv: `${shim}:/usr/bin`, os: 'darwin', resolve: fakeRealpath({ [bun]: bun, [`${shim}/bun`]: bun }), tempDirs: ['/var/folders/ab/xyz/T'],
  }), bun);
});

test('Windows, an empty PATH or an unresolvable runtime keep the running path', () => {
  assert.equal(stableRuntimePath('C:\\Program Files\\nodejs\\node.exe', { pathEnv: 'C:\\Program Files\\nodejs', os: 'win32' }), 'C:\\Program Files\\nodejs\\node.exe');
  const resolve = fakeRealpath({ [BREW_KEG_NODE]: BREW_KEG_NODE, '/opt/homebrew/bin/node': BREW_KEG_NODE });
  assert.equal(stableRuntimePath(BREW_KEG_NODE, { pathEnv: '', os: 'darwin', resolve, tempDirs: [] }), BREW_KEG_NODE);
  assert.equal(stableRuntimePath('/gone/node', { pathEnv: '/opt/homebrew/bin', os: 'darwin', resolve, tempDirs: [] }), '/gone/node');
});

test('Homebrew npx mode registers the npx and PATH next to the stable node, never the keg', () => {
  const resolve = fakeRealpath({ [BREW_KEG_NODE]: BREW_KEG_NODE, '/opt/homebrew/bin/node': BREW_KEG_NODE });
  const npxBin = '/Users/x/.npm/_npx/4b0e2640fe917ac8/node_modules/@vibe-cafe/vibe-usage/bin/vibe-usage.js';
  const options = { pathEnv: '/opt/homebrew/bin:/usr/bin', os: 'darwin', resolve, tempDirs: [], exists: () => true };
  const launch = resolveServiceLaunch(BREW_KEG_NODE, npxBin, options);
  assert.deepEqual(launch, {
    nodePath: '/opt/homebrew/bin/node',
    isNpxCache: true,
    launcher: { mode: 'npx', npxPath: '/opt/homebrew/bin/npx', nodeDir: '/opt/homebrew/bin' },
  });
  const plist = generateLaunchdPlist(launch.nodePath, npxBin, undefined, {}, launch.launcher);
  const unit = generateSystemdUnit(launch.nodePath, npxBin, undefined, {}, launch.launcher);
  for (const text of [plist, unit]) assert.doesNotMatch(text, /Cellar/);

  // No npx beside the stable node: fall back to the one beside execPath, as before.
  const fallback = resolveServiceLaunch(BREW_KEG_NODE, npxBin, { ...options, exists: p => p.startsWith('/opt/homebrew/Cellar/') });
  assert.equal(fallback.launcher.npxPath, '/opt/homebrew/Cellar/node/26.8.2/bin/npx');

  // A global install pins the stable node with its own bin path.
  const global = resolveServiceLaunch(BREW_KEG_NODE, '/opt/homebrew/lib/node_modules/@vibe-cafe/vibe-usage/bin/vibe-usage.js', options);
  assert.deepEqual(global, { nodePath: '/opt/homebrew/bin/node', isNpxCache: false, launcher: null });
});

// Homebrew layouts and stableRuntimePath() are POSIX-only (Windows keeps execPath).
test('on a real filesystem the stable path survives a simulated brew upgrade', { skip: process.platform === 'win32' }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vibe-usage-brew-')));
  try {
    const keg = version => join(root, 'Cellar', 'node', version, 'bin');
    mkdirSync(keg('26.8.2'), { recursive: true });
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(keg('26.8.2'), 'node'), '');
    writeFileSync(join(keg('26.8.2'), 'npx'), '');
    symlinkSync('../Cellar/node/26.8.2/bin/node', join(root, 'bin', 'node'));
    symlinkSync('../Cellar/node/26.8.2/bin/npx', join(root, 'bin', 'npx'));
    const execPath = realpathSync(join(root, 'bin', 'node')); // what Node reports
    assert.equal(execPath, join(keg('26.8.2'), 'node'));

    const pathEnv = `${join(root, 'bin')}:/usr/bin`;
    const npxBin = join(root, '.npm', '_npx', 'h', 'node_modules', '@vibe-cafe', 'vibe-usage', 'bin', 'vibe-usage.js');
    // The fixture lives under the temp dir, which the default guard skips.
    assert.equal(stableRuntimePath(execPath, { pathEnv, os: 'darwin' }), execPath);
    const launch = resolveServiceLaunch(execPath, npxBin, { pathEnv, os: 'darwin', tempDirs: [] });
    assert.equal(launch.nodePath, join(root, 'bin', 'node'));
    assert.equal(launch.launcher.npxPath, join(root, 'bin', 'npx'));

    const plistFile = join(root, 'service.plist');
    writeFileSync(plistFile, generateLaunchdPlist(launch.nodePath, npxBin, undefined, {}, launch.launcher));
    const oldStyle = join(root, 'old-style.plist');
    writeFileSync(oldStyle, generateLaunchdPlist(execPath, npxBin, undefined, {}, npxLauncher(execPath)));
    assert.deepEqual(missingLaunchPaths('launchd', { file: plistFile }), []);
    assert.deepEqual(missingLaunchPaths('launchd', { file: oldStyle }), []);

    // brew upgrade node: new keg, links re-pointed, old keg cleaned up.
    mkdirSync(keg('26.9.0'), { recursive: true });
    renameSync(join(keg('26.8.2'), 'node'), join(keg('26.9.0'), 'node'));
    renameSync(join(keg('26.8.2'), 'npx'), join(keg('26.9.0'), 'npx'));
    for (const name of ['node', 'npx']) {
      unlinkSync(join(root, 'bin', name));
      symlinkSync(`../Cellar/node/26.9.0/bin/${name}`, join(root, 'bin', name));
    }
    rmSync(join(root, 'Cellar', 'node', '26.8.2'), { recursive: true });

    assert.deepEqual(missingLaunchPaths('launchd', { file: plistFile }), [], 'the stable registration still starts');
    assert.deepEqual(missingLaunchPaths('launchd', { file: oldStyle }), [join(keg('26.8.2'), 'npx')], 'the versioned one is reported');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Reading the registered launch paths back. ----

test('launch paths are read back from every generated unit form', () => {
  const npx = { mode: 'npx', npxPath: '/opt/homebrew/bin/npx', nodeDir: '/opt/homebrew/bin' };
  assert.deepEqual(launchPathsFromText('launchd', generateLaunchdPlist('/opt/homebrew/bin/node', '/x/_npx/h/bin.js', undefined, {}, npx)), ['/opt/homebrew/bin/npx']);
  assert.deepEqual(launchPathsFromText('launchd', generateLaunchdPlist('/usr/bin/node', '/opt/vibe & co/<bin>.js', undefined, {})), ['/usr/bin/node', '/opt/vibe & co/<bin>.js']);
  assert.deepEqual(launchPathsFromText('systemd', generateSystemdUnit('/opt/homebrew/bin/node', '/x/_npx/h/bin.js', undefined, {}, npx)), ['/opt/homebrew/bin/npx']);
  assert.deepEqual(launchPathsFromText('systemd', generateSystemdUnit('/usr/bin/node', '/opt/vibe/bin.js', undefined, {})), ['/usr/bin/node', '/opt/vibe/bin.js']);
  const winNpx = { mode: 'npx', npxPath: 'C:\\Program Files\\nodejs\\npx.cmd', nodeDir: 'C:\\Program Files\\nodejs' };
  assert.deepEqual(launchPathsFromText('taskscheduler', generateWindowsTaskCmd('C:\\Program Files\\nodejs\\node.exe', 'C:\\x\\bin.js', undefined, {}, winNpx)), ['C:\\Program Files\\nodejs\\npx.cmd']);
  assert.deepEqual(launchPathsFromText('taskscheduler', generateWindowsTaskCmd('C:\\100%\\node.exe', 'C:\\vibe\\bin.js', undefined, {})), ['C:\\100%\\node.exe', 'C:\\vibe\\bin.js']);
  for (const plat of ['launchd', 'systemd', 'taskscheduler']) assert.equal(launchPathsFromText(plat, 'not a unit'), null);
});

test('missing launch paths: none, some, or unknown when the unit is unreadable', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-launch-'));
  try {
    const node = join(root, 'node');
    writeFileSync(node, '');
    const file = join(root, 'unit');
    writeFileSync(file, generateSystemdUnit(node, join(root, 'bin.js'), undefined, {}));
    assert.deepEqual(missingLaunchPaths('systemd', { file }), [join(root, 'bin.js')]);
    writeFileSync(join(root, 'bin.js'), '');
    assert.deepEqual(missingLaunchPaths('systemd', { file }), []);
    // A dangling symlink is missing too.
    const link = join(root, 'npx');
    symlinkSync(join(root, 'deleted-target'), link);
    writeFileSync(file, generateLaunchdPlist(node, '/x/_npx/h/bin.js', undefined, {}, { mode: 'npx', npxPath: link, nodeDir: root }));
    assert.deepEqual(missingLaunchPaths('launchd', { file }), [link]);
    assert.equal(missingLaunchPaths('launchd', { file: join(root, 'absent') }), null);
    assert.equal(missingLaunchPaths('taskscheduler', { cmd: join(root, 'absent.cmd') }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- End to end: status / install against a broken registration. Runs the
// real CLI with HOME in a temp dir and fake launchctl / systemctl first on
// PATH, so the machine's real service manager is never touched. ----

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'vibe-usage.js');
const servicePlatform = process.platform === 'darwin'
  ? 'launchd'
  : (process.platform === 'linux' && existsSync('/run/systemd/system') ? 'systemd' : null);

function withServiceHome(fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vibe-usage-service-')));
  try {
    const home = join(root, 'home');
    const fakeBin = join(root, 'fake-bin');
    mkdirSync(home);
    mkdirSync(fakeBin);
    const log = join(root, 'service-manager.log');
    for (const name of ['launchctl', 'systemctl']) {
      writeFileSync(join(fakeBin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\nexit 0\n`);
      chmodSync(join(fakeBin, name), 0o755);
    }
    const env = {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      VIBE_USAGE_DEV: '0',
      VIBE_USAGE_CONFIG_DIR: join(root, 'config'),
      VIBE_USAGE_STATE_DIR: join(root, 'state'),
    };
    // Refuse to run at all unless the fakes really shadow the real tools.
    const which = spawnSync('/bin/sh', ['-c', 'command -v launchctl; command -v systemctl'], { env, encoding: 'utf8' });
    assert.equal(which.stdout.trim(), `${join(fakeBin, 'launchctl')}\n${join(fakeBin, 'systemctl')}`);
    const unitFile = servicePlatform === 'launchd'
      ? join(home, 'Library', 'LaunchAgents', 'ai.vibecafe.vibe-usage.plist')
      : join(home, '.config', 'systemd', 'user', 'vibe-usage.service');
    mkdirSync(dirname(unitFile), { recursive: true });
    const run = (...args) => spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' });
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
    fn({ root, unitFile, run, calls });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeUnit(unitFile, nodePath, binPath, launcher = null) {
  const generate = servicePlatform === 'launchd' ? generateLaunchdPlist : generateSystemdUnit;
  writeFileSync(unitFile, generate(nodePath, binPath, undefined, {}, launcher));
}

test('daemon status reports a registered launch path that no longer exists', { skip: !servicePlatform }, () => {
  withServiceHome(({ root, unitFile, run }) => {
    const goneNpx = join(root, 'homebrew', 'Cellar', 'node', '26.8.2', 'bin', 'npx');
    writeUnit(unitFile, join(root, 'homebrew', 'Cellar', 'node', '26.8.2', 'bin', 'node'), '/x/_npx/h/bin.js',
      { mode: 'npx', npxPath: goneNpx, nodeDir: dirname(goneNpx) });
    const broken = run('daemon', 'status');
    assert.equal(broken.status, 0, broken.stderr);
    assert.match(broken.stdout, /后台服务的启动路径已失效，下次启动时（如重启电脑后）会失败/);
    assert.ok(broken.stdout.includes(goneNpx), broken.stdout);
    assert.match(broken.stdout, /daemon install` 重新注册/);

    writeUnit(unitFile, process.execPath, bin);
    const healthy = run('daemon', 'status');
    assert.equal(healthy.status, 0, healthy.stderr);
    assert.doesNotMatch(healthy.stdout, /启动路径已失效/);
  });
});

test('daemon install replaces a broken registration and still refuses a working one', { skip: !servicePlatform }, () => {
  withServiceHome(({ root, unitFile, run, calls }) => {
    writeUnit(unitFile, process.execPath, bin);
    const refused = run('daemon', 'install');
    assert.match(refused.stdout, /Daemon 已安装/);
    assert.equal(calls(), '', 'a working registration is left alone');

    const goneNode = join(root, 'homebrew', 'Cellar', 'node', '26.8.2', 'bin', 'node');
    writeUnit(unitFile, goneNode, bin);
    const replaced = run('daemon', 'install');
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.match(replaced.stdout, /启动路径已不存在（常见于升级 Node 之后），先移除旧注册再重新安装/);
    assert.match(replaced.stdout, /已开启后台自动同步/);
    const written = readFileSync(unitFile, 'utf8');
    assert.ok(!written.includes(goneNode), 'the dead path is gone');
    assert.deepEqual(missingLaunchPaths(servicePlatform, { file: unitFile }), []);
    const log = calls();
    if (servicePlatform === 'launchd') {
      assert.equal(log, `launchctl unload ${unitFile}\nlaunchctl load ${unitFile}\n`);
    } else {
      assert.match(log, /systemctl --user stop vibe-usage\.service[\s\S]*systemctl --user enable --now vibe-usage\.service/);
    }
  });
});
