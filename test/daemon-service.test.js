import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKAGE_SPEC,
  generateLaunchdPlist,
  generateSystemdUnit,
  generateWindowsTaskCmd,
  generateWindowsTaskVbs,
  generateWindowsTaskXml,
  installedModeFromText,
  isNpxCachePath,
  npxLauncher,
  parseWindowsTaskInvocation,
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
  assert.equal(win.mode, 'npx');
  assert.match(win.npxPath, /npx\.cmd$/);
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
