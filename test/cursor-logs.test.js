import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parse as parseCursorLogs, getCursorLogDir } from '../src/parsers/cursor-logs.js';
import { parse as parseCursor } from '../src/parsers/cursor.js';

describe('cursor-logs parser', () => {
  it('counts completed and aborted blocks with tokens under the same cursor source', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'vibe-usage-cursor-logs-'));
    const previousLogDir = process.env.CURSOR_LOG_DIR;
    try {
      const fixtureText = await readFile(new URL('./fixtures/sample-cursor.log', import.meta.url), 'utf8');
      await mkdir(tmp, { recursive: true });
      await writeFile(join(tmp, 'cursor.log'), fixtureText, 'utf8');
      process.env.CURSOR_LOG_DIR = tmp;

      const result = await parseCursorLogs();

      assert.strictEqual(result.sessions.length, 0);
      assert.ok(result.buckets.length > 0);

      const sources = new Set(result.buckets.map(b => b.source));
      assert.deepStrictEqual([...sources], ['cursor']);

      const totalInput = result.buckets.reduce((s, b) => s + b.inputTokens, 0);
      const totalOutput = result.buckets.reduce((s, b) => s + b.outputTokens, 0);
      const totalCache = result.buckets.reduce((s, b) => s + b.cachedInputTokens, 0);

      // completed: (325659 - 325120) + 1032
      // aborted: (1000 - 900) + 200
      assert.strictEqual(totalInput, 639);
      assert.strictEqual(totalOutput, 1232);
      assert.strictEqual(totalCache, 326020);
    } finally {
      if (previousLogDir == null) delete process.env.CURSOR_LOG_DIR;
      else process.env.CURSOR_LOG_DIR = previousLogDir;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('falls back from cursor parser to local logs under the same cursor source', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'vibe-usage-cursor-fallback-'));
    const previousLogDir = process.env.CURSOR_LOG_DIR;
    const previousStateDb = process.env.CURSOR_STATE_DB_PATH;
    try {
      const fixtureText = await readFile(new URL('./fixtures/sample-cursor.log', import.meta.url), 'utf8');
      await mkdir(tmp, { recursive: true });
      await writeFile(join(tmp, 'cursor.log'), fixtureText, 'utf8');
      process.env.CURSOR_LOG_DIR = tmp;
      process.env.CURSOR_STATE_DB_PATH = join(tmp, 'missing-state.vscdb');

      const result = await parseCursor();
      assert.ok(result.buckets.length > 0);
      const sources = new Set(result.buckets.map(b => b.source));
      assert.deepStrictEqual([...sources], ['cursor']);
    } finally {
      if (previousLogDir == null) delete process.env.CURSOR_LOG_DIR;
      else process.env.CURSOR_LOG_DIR = previousLogDir;
      if (previousStateDb == null) delete process.env.CURSOR_STATE_DB_PATH;
      else process.env.CURSOR_STATE_DB_PATH = previousStateDb;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('resolves platform log paths', () => {
    const originalPlatform = process.platform;
    const originalAppData = process.env.APPDATA;

    const desc = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    assert.ok(getCursorLogDir().includes('.config/Cursor/logs'));

    Object.defineProperty(process, 'platform', { value: 'darwin' });
    assert.ok(getCursorLogDir().includes('Library/Application Support/Cursor/logs'));

    process.env.APPDATA = 'C:/Users/demo/AppData/Roaming';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    assert.ok(getCursorLogDir().includes('Cursor/logs'));

    if (desc) Object.defineProperty(process, 'platform', desc);
    process.env.APPDATA = originalAppData;
  });
});
