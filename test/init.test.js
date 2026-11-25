import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { DEFAULT_API_URL } from '../src/api-url.js';
import { resolveInitApiUrl, runDeviceFlow, trustedReplyApiUrl } from '../src/init.js';

const taken = apiUrl => ({ apiUrl, ignoredReply: null });

test('resolveInitApiUrl takes a production reply on a production login (what #202 is for)', () => {
  assert.deepEqual(resolveInitApiUrl('https://vibefriends.com', DEFAULT_API_URL), taken(DEFAULT_API_URL));
  assert.deepEqual(resolveInitApiUrl('https://vibefriends.com', 'https://vibecafe.ai'), taken(DEFAULT_API_URL));
  assert.deepEqual(resolveInitApiUrl('https://vibecafe.ai'), taken(DEFAULT_API_URL));
  assert.deepEqual(resolveInitApiUrl('https://www.vibecafe.ai/'), taken(DEFAULT_API_URL));
  assert.deepEqual(resolveInitApiUrl('  https://VibeCafe.ai  '), taken(DEFAULT_API_URL));
  assert.deepEqual(resolveInitApiUrl('https://VIBEFRIENDS.com:443'), taken(DEFAULT_API_URL));
  assert.deepEqual(resolveInitApiUrl('https://tenant.example.com', 'https://tenant.example.com'), taken('https://tenant.example.com'));
});

test('resolveInitApiUrl keeps the login server when the reply has no URL', () => {
  assert.deepEqual(resolveInitApiUrl('', 'http://localhost:3000'), taken('http://localhost:3000'));
  assert.deepEqual(resolveInitApiUrl(undefined, 'http://localhost:3000'), taken('http://localhost:3000'));
  assert.deepEqual(resolveInitApiUrl(null, 'https://tenant.example.com'), taken('https://tenant.example.com'));
  assert.deepEqual(resolveInitApiUrl('   ', 'https://vibecafe.ai'), taken(DEFAULT_API_URL));
});

test('resolveInitApiUrl refuses a reply naming another server and keeps the login server', () => {
  const refused = (reply, requested, expected = requested) =>
    assert.deepEqual(resolveInitApiUrl(reply, requested), { apiUrl: expected, ignoredReply: reply.trim() }, reply);
  // Cross-origin: a self-hosted login never moves to production or elsewhere,
  // and a production login never moves to a third party.
  refused('https://tenant.example.com', DEFAULT_API_URL);
  refused('https://evil.example', 'https://tenant.example.com');
  refused('https://vibefriends.com', 'https://tenant.example.com');
  refused('https://vibefriends.com.evil.example', DEFAULT_API_URL);
  refused('https://vibefriends.com:8443', DEFAULT_API_URL);
  refused('https://evil.example', 'https://vibecafe.ai', DEFAULT_API_URL);
  // https downgraded to http, same host or not.
  refused('http://vibefriends.com', DEFAULT_API_URL);
  refused('http://tenant.example.com', 'https://tenant.example.com');
  // User info.
  refused('https://user:pass@vibefriends.com', DEFAULT_API_URL);
  refused('https://user@vibefriends.com', DEFAULT_API_URL);
  // Unparsable or not http(s).
  refused('not a url', DEFAULT_API_URL);
  refused('vibefriends.com', DEFAULT_API_URL);
  refused('https://', DEFAULT_API_URL);
  refused('javascript:alert(1)', DEFAULT_API_URL);
  refused('file:///etc/passwd', DEFAULT_API_URL);
  refused('ftp://vibefriends.com', DEFAULT_API_URL);
  refused('https://vibe\tfriends.com', DEFAULT_API_URL);
  refused('https://vibefriends.com/\u001b[2J', DEFAULT_API_URL);
  // LAN http: only the very origin the login went to.
  refused('http://192.168.1.11:3000', 'http://192.168.1.10:3000');
  refused('http://192.168.1.10:3001', 'http://192.168.1.10:3000');
  refused('https://192.168.1.10:3000', 'http://192.168.1.10:3000');
});

test('trustedReplyApiUrl takes plain http only from the http origin the login went to', () => {
  assert.equal(trustedReplyApiUrl('http://192.168.1.10:3000', 'http://192.168.1.10:3000'), 'http://192.168.1.10:3000');
  assert.equal(trustedReplyApiUrl('http://192.168.1.10:3000/', 'http://192.168.1.10:3000'), 'http://192.168.1.10:3000');
  assert.equal(trustedReplyApiUrl('http://localhost:3000', 'http://localhost:3000'), 'http://localhost:3000');
  assert.equal(trustedReplyApiUrl('http://localhost:3000', 'https://localhost:3000'), null);
  assert.equal(trustedReplyApiUrl('http://192.168.1.10:3000', 'not a url'), null);
  assert.equal(trustedReplyApiUrl(42, DEFAULT_API_URL), null);
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

// End to end through the real runInit in a child process. The login server is
// a local stand-in; a second stand-in on another origin plays the server a
// tampered reply names. Every request that carries the key (ingest, the
// account lookup that fetchAccount makes, the first sync) must reach the login
// server only.
test('runInit sends the new key only to a server the reply may name', { skip: process.platform === 'win32' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-init-api-url-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  for (const dir of [home, bin]) mkdirSync(dir, { recursive: true });
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, name), 0o755);
  }

  let pollReplyUrl;
  const standIn = (hits) => createServer((req, res) => {
    hits.push({ url: req.url, authorization: req.headers.authorization ?? null });
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
      res.end(JSON.stringify(pollReplyUrl === undefined ? { apiKey: 'vbu_init_test' } : { apiKey: 'vbu_init_test', apiUrl: pollReplyUrl }));
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
      res.end(JSON.stringify({ account: { handle: 'tester', name: null } }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  const listen = async (server) => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    return `http://127.0.0.1:${server.address().port}`;
  };
  const loginHits = [];
  const otherHits = [];
  const loginUrl = await listen(standIn(loginHits));
  const otherUrl = await listen(standIn(otherHits));

  const runInitCase = (caseName, replyUrl) => new Promise((resolve, reject) => {
    pollReplyUrl = replyUrl;
    loginHits.length = 0;
    otherHits.length = 0;
    const caseDir = join(root, caseName);
    const configDir = join(caseDir, 'config');
    const child = spawn(process.execPath, ['--input-type=module', '-e', `const { runInit } = await import('./src/init.js'); await runInit({ noDaemon: true });`], {
      cwd: new URL('..', import.meta.url),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: [bin, dirname(process.execPath)].join(delimiter),
        HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
        VIBE_USAGE_DEV: '0', VIBE_USAGE_API_URL: loginUrl,
        VIBE_USAGE_CONFIG_DIR: configDir, VIBE_USAGE_STATE_DIR: join(caseDir, 'state'),
        VIBE_USAGE_QUOTA_CACHE_DIR: join(caseDir, 'quota'), VIBE_USAGE_CACHE_DIR: join(caseDir, 'cache'),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({
      code,
      stdout,
      stderr,
      config: code === 0 ? JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')) : null,
    }));
  });
  const keyedPaths = hits => hits.filter(hit => hit.authorization === 'Bearer vbu_init_test').map(hit => hit.url);
  const assertKeyStayedOnLoginServer = (result, label) => {
    assert.equal(result.code, 0, `${label}: ${result.stderr}`);
    assert.equal(result.config.apiKey, 'vbu_init_test', label);
    assert.equal(result.config.apiUrl, loginUrl, label);
    assert.deepEqual(otherHits, [], `${label}: the other server was contacted`);
    const keyed = keyedPaths(loginHits);
    assert.ok(keyed.includes('/api/usage/ingest'), `${label}: ingest with the key`);
    assert.ok(keyed.includes('/api/usage?days=1&bucketsOnly=true'), `${label}: account lookup with the key`);
  };

  // Trusted reply (same origin as the login): taken, normalized, no warning.
  const sameOrigin = await runInitCase('same-origin', `${loginUrl}/`);
  assertKeyStayedOnLoginServer(sameOrigin, 'same-origin');
  assert.doesNotMatch(sameOrigin.stdout, /已忽略/);

  // Tampered reply naming another server: refused before the key is sent.
  const crossOrigin = await runInitCase('cross-origin', otherUrl);
  assertKeyStayedOnLoginServer(crossOrigin, 'cross-origin');
  assert.match(crossOrigin.stdout, new RegExp(`服务器返回的地址 ${otherUrl} 不是本次登录的服务器，已忽略，继续使用 ${loginUrl}。`));

  // Unparsable reply: refused, config.json keeps the login server.
  const unparsable = await runInitCase('unparsable', 'not a url');
  assertKeyStayedOnLoginServer(unparsable, 'unparsable');
  assert.match(unparsable.stdout, /服务器返回的地址 not a url 不是本次登录的服务器，已忽略/);

  // No apiUrl in the reply (servers before #202): the login server, silently.
  const withoutReply = await runInitCase('without-reply', undefined);
  assertKeyStayedOnLoginServer(withoutReply, 'without-reply');
  assert.doesNotMatch(withoutReply.stdout, /已忽略/);
});
