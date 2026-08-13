import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function assistantRecord(id, model, timestamp) {
  return {
    id,
    timestamp,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    cwd: '/private/workspace/workbuddy-e2e',
    content: [{ type: 'text', text: 'PRIVATE_WORKBUDDY_RESPONSE' }],
    message: { role: 'assistant', usage: { inputTokens: 100, outputTokens: 20 } },
    providerData: {
      requestModelId: model,
      usage: { inputTokens: 100, outputTokens: 20 },
    },
  };
}

test('WorkBuddy sync uploads routed-model buckets and session metadata once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-workbuddy-e2e-'));
  const projects = join(root, 'workbuddy', 'projects', 'encoded');
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const homeDir = join(root, 'home');
  mkdirSync(projects, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(join(projects, 'session.jsonl'), [
    JSON.stringify({
      id: 'user-a',
      timestamp: '2026-08-10T00:50:00.000Z',
      type: 'message',
      role: 'user',
      cwd: '/private/workspace/workbuddy-e2e',
      content: [{ type: 'text', text: 'PRIVATE_WORKBUDDY_PROMPT' }],
      message: { role: 'user' },
    }),
    JSON.stringify(assistantRecord('request-a', 'actual-model-a', '2026-08-10T00:50:10.000Z')),
    JSON.stringify(assistantRecord('request-b', 'actual-model-b', '2026-08-10T00:50:20.000Z')),
  ].join('\n') + '\n');

  const received = [];
  try {
    await withServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/usage/settings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ uploadProject: true }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/usage/ingest') {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          const payload = JSON.parse(gunzipSync(Buffer.concat(chunks)).toString('utf8'));
          received.push(payload);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            ingested: payload.buckets.length,
            sessions: payload.sessions?.length || 0,
          }));
        });
        return;
      }
      res.writeHead(404).end();
    }, async apiUrl => {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        apiKey: 'vbu_e2e_test',
        apiUrl,
        hostname: 'workbuddy-e2e',
      }));
      const env = {
        ...process.env,
        HOME: homeDir,
        VIBE_USAGE_DEV: '0',
        VIBE_USAGE_CONFIG_DIR: configDir,
        VIBE_USAGE_STATE_DIR: stateDir,
        VIBE_USAGE_WORKBUDDY_DIRS: join(root, 'workbuddy'),
      };
      const command = `
        import { parsers } from './src/parsers/index.js';
        for (const source of Object.keys(parsers)) {
          if (source !== 'workbuddy') delete parsers[source];
        }
        const { runSync } = await import('./src/sync.js');
        await runSync({ throws: true, quiet: true });
      `;
      await execFileAsync(process.execPath, ['--input-type=module', '-e', command], {
        cwd: process.cwd(),
        env,
      });
      await execFileAsync(process.execPath, ['--input-type=module', '-e', command], {
        cwd: process.cwd(),
        env,
      });
    });

    assert.equal(received.length, 1, 'the unchanged second sync must not POST');
    assert.equal(received[0].buckets.length, 2);
    assert.equal(received[0].sessions.length, 1);
    assert.deepEqual(new Set(received[0].buckets.map(bucket => bucket.model)), new Set([
      'actual-model-a',
      'actual-model-b',
    ]));
    assert.equal(received[0].buckets.every(bucket => bucket.source === 'workbuddy'), true);
    assert.equal(received[0].sessions[0].source, 'workbuddy');
    assert.equal(received[0].sessions[0].messageCount, 3);
    assert.equal(received[0].sessions[0].activeSeconds, 10);

    const payload = JSON.stringify(received[0]);
    assert.equal(payload.includes('PRIVATE_WORKBUDDY'), false);
    assert.equal(payload.includes('/private/workspace'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
