import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

test('DSH sync backfills V3 usage without reset, preserves privacy, and protects state on future formats', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-dsh-e2e-'));
  const sessions = join(root, 'sessions');
  const logDir = join(sessions, 'project', 'same-session');
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  mkdirSync(logDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const received = [];
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url.split('?')[0] === '/api/usage/settings') {
      res.end(JSON.stringify({ uploadProject: false }));
    } else if (req.method === 'POST' && req.url === '/api/usage/ingest') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const payload = JSON.parse(gunzipSync(Buffer.concat(chunks)).toString('utf8'));
        received.push(payload);
        res.end(JSON.stringify({ ingested: payload.buckets.length, sessions: payload.sessions?.length || 0 }));
      });
    } else {
      res.writeHead(404).end();
    }
  });
  const turn = (seq, time, inputTokens) => [
    { type: 'user/message', seq, time, data: {
      id: `private-message-${seq}`, source: { kind: 'user' },
      content: [{ type: 'text', text: 'PRIVATE_DSH_PROMPT' }],
    } },
    { type: 'assistant/message', seq: seq + 1, time: time + 10000, data: {
      message: { id: `private-message-${seq + 1}`, source: { kind: 'model', model: 'deepseek-v4-pro' },
        content: [{ type: 'text', text: 'PRIVATE_DSH_RESPONSE' }] },
      usage: { inputTokens, outputTokens: 50, reasoningTokens: 20, cacheReadTokens: 100 },
    } },
  ];
  const oldTurn = turn(0, Date.parse('2026-09-05T01:00:00Z'), 1000);
  const writeLog = (version, records) => writeFileSync(
    join(logDir, `session${version ? `.v${version}` : ''}.jsonl`),
    [{ type: 'session', id: 'same-session', version, cwd: '/private/PRIVATE_DSH_PROJECT',
      ...(version >= 2 ? { isSeeded: false } : {}) }, ...records].map(JSON.stringify).join('\n') + '\n',
  );
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      apiKey: 'vbu_dsh_test', apiUrl: `http://127.0.0.1:${server.address().port}`, hostname: 'dsh-test',
    }));
    const command = `
      import { parsers } from './src/parsers/index.js';
      for (const source of Object.keys(parsers)) if (source !== 'dsh') delete parsers[source];
      const { runSync } = await import('./src/sync.js');
      await runSync({ throws: true });
    `;
    const sync = () => execFileAsync(process.execPath, ['--input-type=module', '-e', command], {
      cwd: process.cwd(),
      env: { ...process.env, VIBE_USAGE_DEV: '0', VIBE_USAGE_CONFIG_DIR: configDir,
        VIBE_USAGE_STATE_DIR: stateDir, VIBE_USAGE_DSH_SESSIONS: sessions },
    });

    writeLog(0, oldTurn);
    await sync();
    assert.equal(received.length, 1);
    const sessionHash = received[0].sessions[0].sessionHash;
    writeLog(3, [...oldTurn, ...turn(2, Date.parse('2026-09-10T01:00:00Z'), 250)]);
    await sync();
    assert.equal(received.length, 2);
    assert.equal(received[1].buckets.length, 1, 'previously uploaded V0 history is unchanged');
    assert.equal(received[1].buckets[0].inputTokens, 250);
    assert.equal(received[1].sessions[0].sessionHash, sessionHash);
    assert.equal(received[1].sessions[0].messageCount, 4);
    assert.equal(received[1].buckets[0].project, 'unknown');
    assert.equal(received[1].sessions[0].project, 'unknown');
    assert.doesNotMatch(JSON.stringify(received), /PRIVATE_DSH|private-message-|same-session|\/private\//);

    const unchanged = await sync();
    assert.match(unchanged.stdout, /无新增数据/);
    assert.equal(received.length, 2);
    const priorState = readFileSync(join(stateDir, 'state.json'), 'utf8');
    writeLog(5, []);
    const future = await sync();
    assert.match(future.stderr, /format version 5/);
    assert.equal(received.length, 2);
    assert.equal(readFileSync(join(stateDir, 'state.json'), 'utf8'), priorState);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
