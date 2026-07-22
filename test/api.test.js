import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { encodeIngestBody, fetchSettings, retryDelayMs } from '../src/api.js';

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  try {
    return await run(url);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('ingest encodes client metadata in the gzipped JSON body', () => {
  const client = {
    collectorVersion: '0.10.2',
    surface: 'windows-app',
    surfaceVersion: '0.5.10',
    syncId: '00000000-0000-4000-8000-000000000000',
    batchIndex: 0,
    batchCount: 1,
  };

  const { body, useGzip } = encodeIngestBody([{ source: 'codex' }], { client });
  const received = JSON.parse(gunzipSync(body).toString('utf-8'));

  assert.equal(useGzip, true);
  assert.deepEqual(received.client, client);
  assert.deepEqual(received.buckets, [{ source: 'codex' }]);
});

test('retry delay uses equal jitter instead of synchronized fixed boundaries', () => {
  assert.equal(retryDelayMs(0, () => 0), 500);
  assert.equal(retryDelayMs(0, () => 1), 1000);
  assert.equal(retryDelayMs(1, () => 0), 1000);
  assert.equal(retryDelayMs(1, () => 1), 2000);
});

test('fetchSettings retries transient failures and preserves explicit false', async () => {
  let requests = 0;
  const delays = [];
  await withServer((_req, res) => {
    requests++;
    if (requests < 3) {
      res.writeHead(500).end('temporary');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ uploadProject: false }));
    }
  }, async url => {
    const result = await fetchSettings(url, 'vbu_test', {
      sleep: async ms => { delays.push(ms); },
      random: () => 0,
    });
    assert.deepEqual(result, { uploadProject: false });
  });
  assert.equal(requests, 3);
  assert.deepEqual(delays, [500, 1000]);
});

test('fetchSettings returns null only after transient retries are exhausted', async () => {
  let requests = 0;
  await withServer((_req, res) => {
    requests++;
    res.writeHead(500).end('temporary');
  }, async url => {
    const result = await fetchSettings(url, 'vbu_test', {
      sleep: async () => {},
      random: () => 0,
    });
    assert.equal(result, null);
  });
  assert.equal(requests, 3);
});

test('fetchSettings does not retry an invalid API key', async () => {
  let requests = 0;
  await withServer((_req, res) => {
    requests++;
    res.writeHead(401).end('nope');
  }, async url => {
    await assert.rejects(
      fetchSettings(url, 'vbu_bad', { sleep: async () => {} }),
      /UNAUTHORIZED/,
    );
  });
  assert.equal(requests, 1);
});
