import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseCline } from '../src/parsers/cline.js';
import { detectInstalledTools } from '../src/tools.js';

function restoreEnv(name, value) {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

function writeTask(root, item, messages) {
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(root, 'tasks', String(item.id)), { recursive: true });
  writeFileSync(join(root, 'state', 'taskHistory.json'), JSON.stringify([item]));
  writeFileSync(join(root, 'tasks', String(item.id), 'ui_messages.json'), JSON.stringify(messages));
}

function apiMessage(ts, tokensIn, tokensOut, cacheWrites = 0, cacheReads = 0) {
  return {
    type: 'say',
    say: 'api_req_started',
    ts,
    text: JSON.stringify({ model: 'cline-model', tokensIn, tokensOut, cacheWrites, cacheReads }),
  };
}

test('Cline reads standalone data and keeps only the most complete migrated task copy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-cline-'));
  const previous = process.env.VIBE_USAGE_CLINE_DIRS;
  try {
    const extension = join(root, 'extension');
    const standalone = join(root, '.cline');
    writeTask(extension, {
      id: 'old-task', ulid: 'shared-ulid', cwd: '/work/old-project', modelId: 'fallback',
    }, [apiMessage(1783357500000, 999, 99)]);
    writeTask(standalone, {
      id: 'new-task', ulid: 'shared-ulid', cwd: '/work/new-project', modelId: 'fallback',
    }, [
      { type: 'ask', ts: 1783357499000 },
      apiMessage(1783357500000, 20, 4, 2, 5),
      apiMessage(1783357510000, 30, 6, 3, 7),
      { type: 'say', say: 'user_feedback', ts: 1783357520000 },
    ]);
    process.env.VIBE_USAGE_CLINE_DIRS = `${extension}${delimiter}${standalone}`;

    const result = await parseCline();
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0].source, 'cline');
    assert.equal(result.buckets[0].project, 'new-project');
    assert.equal(result.buckets[0].inputTokens, 55);
    assert.equal(result.buckets[0].outputTokens, 10);
    assert.equal(result.buckets[0].cachedInputTokens, 12);
    assert.equal(result.sessions.length, 1);

    const detected = detectInstalledTools().map((tool) => tool.id);
    assert.ok(detected.includes('cline'));
  } finally {
    restoreEnv('VIBE_USAGE_CLINE_DIRS', previous);
    rmSync(root, { recursive: true, force: true });
  }
});
