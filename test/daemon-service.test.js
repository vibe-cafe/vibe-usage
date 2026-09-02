import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateLaunchdPlist,
  generateSystemdUnit,
  generateWindowsTaskCmd,
  generateWindowsTaskVbs,
  generateWindowsTaskXml,
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
