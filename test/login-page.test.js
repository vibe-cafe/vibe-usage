import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import {
  DEVICE_VERIFICATION_ORIGINS, browserCommand, planLoginPage, printableText, runBrowserCommand, trustedLoginUrl,
} from '../src/login-page.js';

const PROD = 'https://vibefriends.com';
const LOGIN = `${PROD}/usage/device?code=ABCD-EFGH`;

test('the reviewed verification origins mirror the server contract', () => {
  // vibe-cafe apps/web/src/lib/device-origins.ts DEVICE_ORIGINS
  assert.deepEqual([...DEVICE_VERIFICATION_ORIGINS].sort(), ['https://vibecafe.ai', 'https://vibefriends.com']);
});

test('a genuine login link is trusted as the server sends it', () => {
  const cases = [
    [PROD, LOGIN],
    // The old production name forwards to the new host, which answers with its own origin.
    ['https://vibecafe.ai', LOGIN],
    // USAGE_DEVICE_VERIFICATION_ORIGIN may point at either reviewed origin.
    [PROD, 'https://vibecafe.ai/usage/device?code=ABCD-EFGH'],
    // Self-hosted and local servers answer with the origin the request reached.
    ['http://192.168.1.5:3000', 'http://192.168.1.5:3000/usage/device?code=ABCD-EFGH'],
    ['http://localhost:3456', 'http://localhost:3456/usage/device?code=ABCD-EFGH'],
    ['http://[::1]:3000', 'http://[::1]:3000/usage/device?code=ABCD-EFGH'],
    ['https://example.com/vibe/', 'https://example.com/usage/device?code=ABCD-EFGH'],
  ];
  for (const [apiUrl, link] of cases) assert.equal(trustedLoginUrl(link, apiUrl), link, `${apiUrl} ${link}`);
});

test('a link outside the device-flow origins, or not http(s), is never trusted', () => {
  const rejected = [
    'file:///C:/Windows/System32/calc.exe',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ms-settings:',
    'vscode://vibefriends.com/usage/device',
    'smb://vibefriends.com/share',
    'https://evil.example/usage/device?code=ABCD-EFGH',
    'https://vibefriends.com.evil.test/usage/device?code=ABCD-EFGH',
    'https://www.vibefriends.com/usage/device?code=ABCD-EFGH',
    'https://vibefriends.com:8443/usage/device?code=ABCD-EFGH',
    'http://vibefriends.com/usage/device?code=ABCD-EFGH',
    'https://user:pass@vibefriends.com/usage/device?code=ABCD-EFGH',
    'https://evil@vibefriends.com/usage/device?code=ABCD-EFGH',
    '/usage/device?code=ABCD-EFGH',
    '',
    // Whitespace and control characters the URL parser would quietly drop or trim.
    `${LOGIN}\n|calc`,
    `${LOGIN}\t`,
    ` ${LOGIN}`,
    `${PROD}/usage/device?code=A B`,
    `${LOGIN}\u001b]8;;https://evil.example\u0007`,
    `${LOGIN}\u0085`,
  ];
  for (const link of rejected) assert.equal(trustedLoginUrl(link, PROD), null, JSON.stringify(link));
  for (const link of [undefined, null, 42, {}, ['x']]) assert.equal(trustedLoginUrl(link, PROD), null, String(link));
  // A self-hosted server can only send its own origin (or a reviewed one).
  assert.equal(trustedLoginUrl('http://192.168.1.6:3000/usage/device?code=ABCD-EFGH', 'http://192.168.1.5:3000'), null);
  assert.equal(trustedLoginUrl('https://192.168.1.5:3000/usage/device?code=ABCD-EFGH', 'http://192.168.1.5:3000'), null);
  // An unparsable server URL leaves only the reviewed origins.
  assert.equal(trustedLoginUrl(LOGIN, 'not a url'), LOGIN);
  assert.equal(trustedLoginUrl('http://localhost:3000/usage/device?code=ABCD-EFGH', 'not a url'), null);
});

test('Windows hands cmd the genuine link byte for byte and refuses cmd syntax', () => {
  assert.deepEqual(browserCommand(LOGIN, 'win32'), {
    file: 'cmd', args: ['/c', 'start', '', LOGIN], options: { windowsHide: true },
  });
  assert.deepEqual(browserCommand(`${LOGIN}&lang=zh`, 'win32').args, ['/c', 'start', '', `${LOGIN}^&lang=zh`]);
  assert.deepEqual(browserCommand('http://[::1]:3000/usage/device?code=ABCD-EFGH', 'win32').args[3],
    'http://[::1]:3000/usage/device?code=ABCD-EFGH');
  // On a trusted origin, everything cmd would read as syntax survives the URL
  // parser in path, query or fragment (or turns into %xx): none of it reaches cmd.
  const withCmdSyntax = [
    `${PROD}/usage/device?code=A|calc`,
    `${PROD}/usage/device?code=A^&calc`,
    `${PROD}/usage/device?code=%PATH%`,
    `${PROD}/usage/device?code=A<B`,
    `${PROD}/usage/device?code=A>B`,
    `${PROD}/usage/device?code=A"B`,
    `${PROD}/usage/device?code=A!B!`,
    `${PROD}/usage/device?code=(A)`,
    `${PROD}/usage/device?code=A,B`,
    `${PROD}/usage/device?code=A;B`,
    `${PROD}/usage/device?code=A%20B`,
    `${PROD}/a|b`,
    `${PROD}/a^b`,
    `${LOGIN}#a|b`,
  ];
  for (const link of withCmdSyntax) {
    const windows = planLoginPage(link, PROD, 'win32');
    assert.notEqual(windows.url, null, link);
    assert.equal(windows.command, null, link);
    // open / xdg-open get the URL as one argv entry, with no shell in between.
    assert.deepEqual(planLoginPage(link, PROD, 'darwin').command.args, [windows.url], link);
  }
});

test('macOS and Linux pass the trusted URL as a single argument', () => {
  assert.deepEqual(browserCommand(LOGIN, 'darwin'), { file: 'open', args: [LOGIN], options: {} });
  assert.deepEqual(browserCommand(LOGIN, 'linux'), { file: 'xdg-open', args: [LOGIN], options: {} });
  assert.deepEqual(browserCommand(LOGIN, 'freebsd'), { file: 'xdg-open', args: [LOGIN], options: {} });
});

test('a malicious reply opens nothing on any platform; a genuine one opens everywhere', () => {
  const malicious = [
    'file:///C:/Windows/System32/calc.exe',
    'https://evil.example/usage/device?code=ABCD-EFGH',
    'https://vibefriends.com&calc',
    'https://vibefriends.com/usage/device?code=x" & calc & "',
    `${LOGIN}\r\ncalc`,
  ];
  for (const os of ['win32', 'darwin', 'linux']) {
    for (const link of malicious) assert.equal(planLoginPage(link, PROD, os).command, null, `${os} ${JSON.stringify(link)}`);
    assert.deepEqual(planLoginPage(LOGIN, PROD, os).url, LOGIN);
    assert.notEqual(planLoginPage(LOGIN, PROD, os).command, null, os);
  }
});

test('untrusted text from the reply is printed without control characters', () => {
  assert.equal(printableText(`https://evil.example/\u001b]8;;x\u0007y\r\n\u009b31m`), 'https://evil.example/]8;;xy31m');
  assert.equal(printableText(undefined), '');
});

test('runBrowserCommand passes file, args and options to execFile', () => {
  const calls = [];
  runBrowserCommand(browserCommand(LOGIN, 'win32'), (...args) => calls.push(args));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ['cmd', ['/c', 'start', '', LOGIN], { windowsHide: true }]);
  assert.equal(typeof calls[0][3], 'function');
});

test('cmd reads every character a trusted link may carry as plain text', { skip: process.platform !== 'win32' }, () => {
  // Same cmd /c parsing as `start "" <url>`, but echo prints instead of opening a browser.
  const links = [
    LOGIN,
    `${LOGIN}&lang=zh&x=1`,
    'http://[::1]:3000/usage/device?code=ABCD-EFGH',
    'https://vibefriends.com/a-b_c.d~e:f/g@h=i+j?k=l&m=n#o[p]q',
  ];
  for (const link of links) {
    const command = browserCommand(link, 'win32');
    assert.notEqual(command, null, link);
    const echoed = execFileSync('cmd', ['/c', 'echo', command.args[3]], { encoding: 'utf8', windowsHide: true });
    assert.equal(echoed.replace(/\r?\n$/, ''), link);
  }
});

// End to end through `init`: a stand-in server answers the device request, and
// `open` / `xdg-open` on PATH are stubs that record what they were asked to
// open. Windows' cmd cannot be stubbed this way; its argv is covered above.
test('init opens only a trusted login link', { skip: process.platform === 'win32' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-login-page-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  for (const dir of [home, bin]) mkdirSync(dir, { recursive: true });
  const openLog = join(root, 'open.log');
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$OPEN_LOG"\n');
    chmodSync(join(bin, name), 0o755);
  }

  let link = '';
  let userCode = 'ABCD-EFGH';
  let polls = 0;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/usage/device/code') {
      res.end(JSON.stringify({ deviceCode: 'dev', userCode, verificationUriComplete: link, expiresIn: 60, interval: 0.02 }));
      return;
    }
    if (req.url === '/api/usage/device/poll') {
      // Keep the flow alive until the stub has run (or long enough that it
      // would have), then end it: the CLI exits 1 without writing a config.
      polls += 1;
      res.end(JSON.stringify({ error: existsSync(openLog) || polls >= 25 ? 'access_denied' : 'authorization_pending' }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const apiUrl = `http://127.0.0.1:${server.address().port}`;

  const init = () => new Promise((resolve, reject) => {
    polls = 0;
    rmSync(openLog, { force: true });
    const child = spawn(process.execPath, ['--input-type=module', '-e', `const { runInit } = await import('./src/init.js'); await runInit({ noDaemon: true });`], {
      cwd: new URL('..', import.meta.url),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: [bin, dirname(process.execPath)].join(delimiter),
        HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, OPEN_LOG: openLog,
        VIBE_USAGE_DEV: '0', VIBE_USAGE_API_URL: apiUrl,
        VIBE_USAGE_CONFIG_DIR: join(root, 'config'), VIBE_USAGE_STATE_DIR: join(root, 'state'),
        VIBE_USAGE_QUOTA_CACHE_DIR: join(root, 'quota'), VIBE_USAGE_CACHE_DIR: join(root, 'cache'),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  const waitForLog = async () => {
    for (let i = 0; i < 100 && !existsSync(openLog); i++) await new Promise(resolve => setTimeout(resolve, 20));
    return existsSync(openLog) ? readFileSync(openLog, 'utf8') : null;
  };

  link = `${apiUrl}/usage/device?code=ABCD-EFGH`;
  const genuine = await init();
  assert.equal(genuine.code, 1, genuine.stderr);
  assert.match(genuine.stderr, /请求被拒绝/);
  assert.match(genuine.stdout, /浏览器会自动打开/);
  assert.doesNotMatch(genuine.stdout, /明文 http/);
  assert.equal(await waitForLog(), `${link}\n`);

  const malicious = [
    'https://evil.example/usage/device?code=ABCD-EFGH',
    'file:///etc/passwd',
    `${apiUrl}/usage/device?code=ABCD-EFGH\u001b]8;;https://evil.example\u0007`,
  ];
  for (const bad of malicious) {
    link = bad;
    // The user code comes from the same reply and is printed too.
    userCode = 'ABCD-EFGH\u001b[2J\u0007';
    const result = await init();
    assert.equal(result.code, 1, result.stderr);
    assert.equal(existsSync(openLog), false, `opened ${JSON.stringify(bad)}`);
    assert.equal(polls >= 25, true, 'the flow stayed open long enough for a launcher to have run');
    assert.match(result.stdout, /没有自动打开浏览器/);
    assert.doesNotMatch(result.stdout, /浏览器会自动打开/);
    assert.ok(result.stdout.includes(printableText(bad)), 'the link is still printed for the user to copy');
    assert.doesNotMatch(result.stdout, /\u001b|\u0007/);
  }
});
