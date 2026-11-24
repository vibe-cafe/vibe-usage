import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { DEFAULT_API_URL } from '../src/api-url.js';
import { resolveInitApiUrl, runDeviceFlow } from '../src/init.js';

test('resolveInitApiUrl normalizes legacy production origins and preserves custom servers', () => {
  assert.equal(resolveInitApiUrl('https://vibecafe.ai'), DEFAULT_API_URL);
  assert.equal(resolveInitApiUrl('https://www.vibecafe.ai/'), DEFAULT_API_URL);
  assert.equal(resolveInitApiUrl('  https://VibeCafe.ai  '), DEFAULT_API_URL);
  assert.equal(resolveInitApiUrl('https://tenant.example.com', 'https://vibefriends.com'), 'https://tenant.example.com');
  assert.equal(resolveInitApiUrl('', 'http://localhost:3000'), 'http://localhost:3000');
  assert.equal(resolveInitApiUrl(undefined, 'http://localhost:3000'), 'http://localhost:3000');
  assert.equal(resolveInitApiUrl('   ', 'https://vibecafe.ai'), DEFAULT_API_URL);
});

test('runDeviceFlow returns both apiKey and apiUrl from device poll', async (t) => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/usage/device/code') {
      res.end(JSON.stringify({
        deviceCode: 'dev_1',
        userCode: 'ABCD-EFGH',
        verificationUriComplete: 'https://evil.example/untrusted',
        expiresIn: 60,
        interval: 0.02,
      }));
      return;
    }
    if (req.url === '/api/usage/device/poll') {
      res.end(JSON.stringify({ apiKey: 'vbu_device_key', apiUrl: 'https://vibecafe.ai' }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const result = await runDeviceFlow(`http://127.0.0.1:${server.address().port}`, 'test-host');
  assert.deepEqual(result, { apiKey: 'vbu_device_key', apiUrl: 'https://vibecafe.ai' });
});

test('runInit saves poll res.apiUrl into config.json and falls back to requested apiUrl when omitted', { skip: process.platform === 'win32' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-init-api-url-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  for (const dir of [home, bin]) mkdirSync(dir, { recursive: true });
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, name), 0o755);
  }

  const targetHits = [];
  const targetServer = createServer((req, res) => {
    targetHits.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/usage/ingest') {
      res.end(JSON.stringify({ inserted: 0 }));
      return;
    }
    if (req.url?.startsWith('/api/usage/settings')) {
      res.end(JSON.stringify({ uploadProject: true }));
      return;
    }
    if (req.url?.startsWith('/api/usage')) {
      res.end(JSON.stringify({ account: { handle: 'tester', name: 'Tester' } }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise(resolve => targetServer.listen(0, '127.0.0.1', resolve));
  t.after(() => targetServer.close());
  const targetUrl = `http://127.0.0.1:${targetServer.address().port}`;

  let pollReplyUrl;
  const authServer = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/usage/device/code') {
      res.end(JSON.stringify({
        deviceCode: 'dev_2',
        userCode: 'WXYZ-1234',
        verificationUriComplete: 'https://evil.example/untrusted',
        expiresIn: 60,
        interval: 0.02,
      }));
      return;
    }
    if (req.url === '/api/usage/device/poll') {
      res.end(JSON.stringify(pollReplyUrl ? { apiKey: 'vbu_init_test', apiUrl: pollReplyUrl } : { apiKey: 'vbu_init_test' }));
      return;
    }
    if (req.url === '/api/usage/ingest') {
      res.end(JSON.stringify({ inserted: 0 }));
      return;
    }
    if (req.url?.startsWith('/api/usage/settings')) {
      res.end(JSON.stringify({ uploadProject: true }));
      return;
    }
    if (req.url?.startsWith('/api/usage')) {
      res.end(JSON.stringify({ account: { handle: 'fallback', name: null } }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise(resolve => authServer.listen(0, '127.0.0.1', resolve));
  t.after(() => authServer.close());
  const authUrl = `http://127.0.0.1:${authServer.address().port}`;

  const runInitCase = (caseName) => new Promise((resolve, reject) => {
    const caseDir = join(root, caseName);
    const configDir = join(caseDir, 'config');
    const stateDir = join(caseDir, 'state');
    const child = spawn(process.execPath, ['--input-type=module', '-e', `const { runInit } = await import('./src/init.js'); await runInit({ noDaemon: true });`], {
      cwd: new URL('..', import.meta.url),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: [bin, dirname(process.execPath)].join(delimiter),
        HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
        VIBE_USAGE_DEV: '0', VIBE_USAGE_API_URL: authUrl,
        VIBE_USAGE_CONFIG_DIR: configDir, VIBE_USAGE_STATE_DIR: stateDir,
        VIBE_USAGE_QUOTA_CACHE_DIR: join(caseDir, 'quota'), VIBE_USAGE_CACHE_DIR: join(caseDir, 'cache'),
      },
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr, configDir }));
  });

  pollReplyUrl = targetUrl;
  const withReply = await runInitCase('with-reply');
  assert.equal(withReply.code, 0, withReply.stderr);
  const savedReplyConfig = JSON.parse(readFileSync(join(withReply.configDir, 'config.json'), 'utf8'));
  assert.equal(savedReplyConfig.apiKey, 'vbu_init_test');
  assert.equal(savedReplyConfig.apiUrl, targetUrl);
  assert.ok(targetHits.includes('/api/usage/ingest'));

  pollReplyUrl = undefined;
  const withoutReply = await runInitCase('without-reply');
  assert.equal(withoutReply.code, 0, withoutReply.stderr);
  const savedFallbackConfig = JSON.parse(readFileSync(join(withoutReply.configDir, 'config.json'), 'utf8'));
  assert.equal(savedFallbackConfig.apiKey, 'vbu_init_test');
  assert.equal(savedFallbackConfig.apiUrl, authUrl);
});
