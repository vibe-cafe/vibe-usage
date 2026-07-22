import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { encodeIngestBody } from '../src/api.js';

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
