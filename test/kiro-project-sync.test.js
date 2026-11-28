import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable, Writable } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';

test('Kiro keeps uploaded CLI bucket keys and merges new buckets by folder name', async t => {
  const root = mkdtempSync(join(tmpdir(), 'kiro-project-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archives = join(root, 'archives');
  mkdirSync(archives);
  Object.assign(process.env, {
    TZ: 'UTC',
    VIBE_USAGE_CONFIG_DIR: root, VIBE_USAGE_STATE_DIR: root,
    VIBE_USAGE_MAGPIE_TEST_FILE: join(root, 'no-ledger'), VIBE_USAGE_DEV: '0',
    KIRO_SESSIONS_DIR: archives, KIRO_CLI_SESSIONS_DIR: join(root, 'no-streams'),
    KIRO_CLI_DB_PATH: join(root, 'no-db'), KIRO_USER_PATH: join(root, 'no-ide'),
  });
  const { saveConfig } = await import('../src/config.js');
  const { bucketKey, bucketHash, loadState, saveState, clearState } = await import('../src/state.js');
  const { parsers } = await import('../src/parsers/index.js');
  const { runSync } = await import('../src/sync.js');
  for (const source of Object.keys(parsers)) {
    if (source !== 'kiro') delete parsers[source];
  }
  const hostname = 'test-machine';
  saveConfig({ apiUrl: 'http://kiro.invalid', apiKey: 'vbu_fixture', hostname });

  // In-memory ingest only upserts rows. Pruning a local key cannot erase a
  // row here, so an accidental rename shows up in the server total.
  const rows = new Map();
  let uploadProject = true;
  let sent = [];
  t.mock.method(http, 'request', (url, options, reply) => {
    assert.equal(url.host, 'kiro.invalid');
    const chunks = [];
    return new Writable({
      write(chunk, encoding, done) { chunks.push(chunk); done(); },
      final(done) {
        let answer;
        if (url.pathname === '/api/usage/settings') {
          answer = { uploadProject, codexUltrafast: { startAt: '1970-01-01T00:00:00.000Z' } };
        } else {
          assert.equal(url.pathname, '/api/usage/ingest');
          const { buckets } = JSON.parse(gunzipSync(Buffer.concat(chunks)));
          for (const b of buckets) rows.set(bucketKey(b), b);
          sent.push(...buckets);
          answer = { ingested: buckets.length };
        }
        reply(Object.assign(Readable.from([JSON.stringify(answer)]), { statusCode: 200 }));
        done();
      },
    });
  });
  const sync = async () => {
    sent = [];
    await runSync({ quiet: true, throws: true });
    assert.deepEqual(Object.keys(loadState().buckets).sort(), [...rows.keys()].sort());
    assert.ok(sent.every(b => !('cwd' in b)));
    return sent.map(b => [b.project, b.totalTokens]).sort();
  };
  const time = Date.parse('2026-06-29T08:05:00Z');
  const model = 'kiro-' + 'm'.repeat(100);
  function archive(id, cwd, tokens, timestamp = time, modelId = model) {
    writeFileSync(join(archives, id + '.json'), JSON.stringify({
      conversation_id: id, cwd, value: { history: [{
        request_metadata: { request_start_timestamp_ms: timestamp, model_id: modelId },
        user: { text: 'x'.repeat(tokens * 4) },
      }] },
    }));
  }
  const posix = '/' + 'p'.repeat(200) + '/demo/';
  const windows = 'C:\\repo\\demo\\';
  const start = '2026-06-29T08:00:00.000Z';
  function oldUpload(cwd, tokens) {
    const b = { source: 'kiro', model: model.slice(0, 100), hostname, project: cwd.slice(0, 200),
      bucketStart: start, inputTokens: tokens, totalTokens: tokens };
    rows.set(bucketKey(b), b);
    const state = loadState();
    state.buckets[bucketKey(b)] = bucketHash(b);
    saveState(state);
  }
  for (const [id, cwd] of [['one', posix], ['two', windows]]) {
    archive(id, cwd, 4);
    oldUpload(cwd, 4);
  }
  const total = () => [...rows.values()].reduce((n, b) => n + b.totalTokens, 0);
  assert.equal(total(), 8);
  assert.deepEqual(await sync(), []);
  assert.equal(total(), 8);
  archive('two', windows, 6);
  assert.deepEqual(await sync(), [[windows, 6]]);
  assert.equal(total(), 10);
  assert.deepEqual(await sync(), []);

  archive('three', '/other/demo', 3); // same window and model as both legacy rows
  archive('four', '/archive/demo', 1);
  archive('five', posix, 5, time + 1_800_000); // same long path, new window
  archive('six', windows, 2, time, 'other-model');
  assert.deepEqual(await sync(), [['demo', 2], ['demo', 4], ['demo', 5]]);
  assert.equal(total(), 21);
  assert.deepEqual(await sync(), []);

  // Start a separate, always-hidden upload history.
  clearState();
  rows.clear();
  uploadProject = false;
  assert.deepEqual(await sync(), [['unknown', 14], ['unknown', 2], ['unknown', 5]]);
  assert.deepEqual(await sync(), []);

  clearState();
  rows.clear();
  uploadProject = true;
  assert.deepEqual(await sync(), [['demo', 14], ['demo', 2], ['demo', 5]]);
  assert.deepEqual(await sync(), []);
});
