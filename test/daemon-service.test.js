import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateLaunchdPlist,
  generateSystemdUnit,
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
