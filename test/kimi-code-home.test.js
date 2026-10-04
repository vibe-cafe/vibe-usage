import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// No VIBE_USAGE_KIMI_CODE_DIR here: the parser must resolve the data root via
// KIMI_CODE_HOME, exactly like the Kimi Code CLI itself does.
const root = mkdtempSync(join(tmpdir(), 'vibe-usage-kimi-home-test-'));
const customHome = join(root, 'custom-kimi-home');
const legacyRoot = join(root, 'kimi-legacy');
process.env.KIMI_CODE_HOME = customHome;
process.env.VIBE_USAGE_KIMI_DIR = legacyRoot;
// The additive desktop home must be isolated too, otherwise this test reads
// real Kimi Work history on a developer's machine.
process.env.APPDATA = join(root, 'appdata');
process.env.XDG_CONFIG_HOME = join(root, 'xdg');
process.env.HOME = root;
process.env.USERPROFILE = root;

const { parse } = await import('../src/parsers/kimi-code.js');

after(() => {
  delete process.env.KIMI_CODE_HOME;
  rmSync(root, { recursive: true, force: true });
});

test('parser honors KIMI_CODE_HOME when resolving the sessions root', async () => {
  const start = Date.parse('2026-07-20T08:01:00.000Z');
  const mainDir = join(customHome, 'sessions', 'wd_homeproj_abcd', 'session_9', 'agents', 'main');
  mkdirSync(mainDir, { recursive: true });
  writeFileSync(join(mainDir, 'wire.jsonl'), `${JSON.stringify({
    type: 'usage.record',
    model: 'kimi-code/k3',
    usage: { inputOther: 5, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
    usageScope: 'turn',
    time: start,
  })}\n`, 'utf-8');

  const result = await parse();
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].project, 'homeproj');
  assert.equal(result.buckets[0].inputTokens, 5);
});
