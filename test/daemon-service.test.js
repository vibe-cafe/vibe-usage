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
