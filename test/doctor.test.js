import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const bin = join(testDir, '..', 'bin', 'vibe-usage.js');

// In-process imports resolve their directories at load time: point them at a
// scratch directory first, never at the developer's real ~/.vibe-usage.
const scratch = mkdtempSync(join(tmpdir(), 'vibe-usage-doctor-unit-'));
process.env.VIBE_USAGE_STATE_DIR = join(scratch, 'state');
process.env.VIBE_USAGE_CONFIG_DIR = join(scratch, 'config');
process.env.VIBE_USAGE_DEV = '0';
const {
  DOCTOR_SCHEMA_VERSION, deviceTag, probeErrorCode, probeUrl, renderDoctorText, scrubDeep, scrubText,
} = await import('../src/doctor.js');
const { inspectStateIdentity, stateIdentity, getStatePath } = await import('../src/state.js');
const { sqliteImplementation } = await import('../src/parsers/sqlite.js');
test.after(() => rmSync(scratch, { recursive: true, force: true }));

// Synthetic sensitive values. None may appear in any doctor output.
const KEY = 'vbu_doctor_secret_key_0123456789';
const SECRETS = [KEY, '张 三', '秘密项目', '-Users-张-三-Coding', 'MacBook', 'sk-ant-api03-fake', 'proxy-password'];

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`, port);
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[full] = `${statSync(full).mtimeMs}:${readFileSync(full, 'utf8')}`;
    }
  };
  walk(dir);
  return out;
}

function historyEntry(overrides) {
  return {
    id: 'a',
    startedAt: '2026-11-09T06:00:00.000Z',
    endedAt: '2026-11-09T06:00:18.000Z',
    surface: 'mac-app',
    cliVersion: '0.14.11',
    runtime: { name: 'node', version: '22.23.1' },
    result: 'success',
    durationMs: 18_000,
    uploaded: { buckets: 12, sessions: 3 },
    failure: null,
    tools: {},
    ...overrides,
  };
}

/** A fully populated synthetic machine: config, state, history, one Codex home. */
function setupMachine(apiUrl) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-doctor-'));
  const home = join(root, 'home');
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const codexHome = join(root, 'codex 张 三');
  for (const dir of [home, configDir, stateDir, join(codexHome, 'sessions')]) mkdirSync(dir, { recursive: true });
  const extraClaude = join(root, '备份', '.claude');
  mkdirSync(join(extraClaude, 'projects'), { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    apiKey: KEY,
    apiUrl,
    hostname: '张 三-MacBook-Pro',
    lastUploadProject: false,
    lastUploadProjectApiUrl: apiUrl,
    magpieStartAt: 'none',
    extraRoots: { 'claude-code': [extraClaude] },
  }));
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({
    buckets: {
      'codex|gpt-5|秘密项目|张 三-MacBook-Pro|2026-11-09T00:00:00.000Z': 'h1',
      'codex|gpt-5|秘密项目|张 三-MacBook-Pro|2026-11-09T00:30:00.000Z': 'h2',
    },
    sessions: { 'codex|秘密项目|s1': 'h3' },
    identity: stateIdentity({ apiUrl, apiKey: KEY }),
  }));
  writeFileSync(join(stateDir, 'sync-history.json'), JSON.stringify({
    schemaVersion: 1,
    entries: [
      historyEntry({ id: 'd', startedAt: '2026-11-09T04:00:00.000Z', surface: 'daemon', result: null, endedAt: null, durationMs: null }),
      historyEntry({
        id: 'c', startedAt: '2026-11-09T05:00:00.000Z', surface: 'cli', result: 'failed',
        failure: { code: 'server_error', status: 502 }, uploaded: { buckets: 0, sessions: 0 },
      }),
      historyEntry({
        id: 'b',
        tools: {
          codex: { buckets: 0, sessions: 0, skipped: true, indexing: { completed: 120, total: 400 } },
          'kimi-code': { buckets: 0, sessions: 0, skipped: true, warnings: { read_failed: 2 } },
          cursor: { buckets: 0, sessions: 0, skipped: true, warnings: { cursor_token_encrypted: 1 } },
          kilo: { buckets: 30, sessions: 0, serverDropped: 30 },
        },
      }),
    ],
  }));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    VIBE_USAGE_DEV: '0',
    VIBE_USAGE_CONFIG_DIR: configDir,
    VIBE_USAGE_STATE_DIR: stateDir,
    CODEX_HOME: codexHome,
    npm_config_registry: `${apiUrl}/registry/`,
    VIBE_USAGE_SURFACE: '',
    HTTPS_PROXY: 'http://user:proxy-password@127.0.0.1:9',
  };
  return { root, env };
}

function recordingServer() {
  const requests = [];
  const handler = (req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null });
    req.resume();
    res.writeHead(req.url === '/api/usage/settings' ? 401 : 200, { 'content-type': 'application/json' });
    res.end(req.url === '/api/usage/settings' ? '{"error":"sk-ant-api03-fake"}' : '{}');
  };
  return { requests, handler };
}

test('doctor --json emits the versioned contract and reads nothing it may not', async () => {
  const { requests, handler } = recordingServer();
  await withServer(handler, async (apiUrl) => {
    const { root, env } = setupMachine(apiUrl);
    try {
      const before = snapshot(root);
      const { stdout, stderr } = await execFileAsync(process.execPath, [bin, 'doctor', '--json'], { env });
      assert.equal(stderr, '');
      assert.deepEqual(snapshot(root), before, 'doctor writes nothing');

      const report = JSON.parse(stdout);
      assert.equal(report.schemaVersion, 1);
      assert.equal(DOCTOR_SCHEMA_VERSION, 1);
      assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(report.cli.surface, 'cli');
      assert.equal(report.runtime.name, process.versions.bun ? 'bun' : 'node');
      assert.ok(['node:sqlite', 'sqlite3-cli', 'none'].includes(report.sqlite));
      assert.deepEqual(report.account, {
        configured: true,
        server: 'custom',
        uploadState: 'match',
        lastSyncRejected: false,
        deviceTag: createHash('sha256').update('张 三-MacBook-Pro').digest('hex').slice(0, 4),
      });
      assert.equal(report.network.server.reachable, true);
      assert.equal(report.network.server.error, null);
      assert.equal(typeof report.network.server.latencyMs, 'number');
      assert.equal(report.network.npmRegistry.registry, 'custom');
      assert.equal(report.network.npmRegistry.reachable, true);
      assert.deepEqual(report.settings, { uploadProject: false, extraRoots: 1, kikiStartAt: 'unset', magpieStartAt: 'none' });
      assert.equal(typeof report.daemon.installed, 'boolean');

      assert.equal(report.syncHistory.available, true);
      assert.deepEqual(report.syncHistory.entries.map(entry => entry.result), ['success', 'failed', null]);
      assert.deepEqual(report.syncHistory.entries[1].failure, { code: 'server_error', status: 502 });
      assert.equal(report.syncHistory.entries[0].tools, undefined, 'tool details live under tools[]');

      const codex = report.tools.find(tool => tool.id === 'codex');
      assert.equal(codex.detected, true);
      assert.deepEqual(codex.uploaded, { buckets: 2, sessions: 1 });
      assert.deepEqual(codex.lastSync.indexing, { completed: 120, total: 400 });
      const kimi = report.tools.find(tool => tool.id === 'kimi-code');
      assert.equal(kimi.detected, false);
      assert.deepEqual(kimi.lastSync.warnings, { read_failed: 2 });
      assert.equal(report.tools.find(tool => tool.id === 'kilo').lastSync.serverDropped, 30);
      const claude = report.tools.find(tool => tool.id === 'claude-code');
      assert.equal(claude.extraRoots, 1);

      for (const secret of SECRETS) assert.ok(!stdout.includes(secret), secret);
      assert.ok(!stdout.includes(root), 'no temporary path');
      // Connectivity only: two unauthenticated GETs, no upload.
      assert.deepEqual(requests.map(r => `${r.method} ${r.url}`).sort(), ['GET /api/usage/settings', 'GET /registry/-/ping']);
      assert.ok(requests.every(r => r.authorization === null), 'the API key is never sent');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('doctor prints a pasteable text report with only fixed fields', async () => {
  const { handler } = recordingServer();
  await withServer(handler, async (apiUrl) => {
    const { root, env } = setupMachine(apiUrl);
    try {
      const { stdout } = await execFileAsync(process.execPath, [bin, 'doctor'], { env });
      assert.match(stdout, /^Vibe Usage 诊断报告 v1（CLI doctor）· \d{4}-\d{2}-\d{2} \d{2}:\d{2}（UTC[+-]\d/);
      assert.match(stdout, /运行环境（本终端）：(Node|Bun) /);
      assert.match(stdout, /账号：已配置 Key · 服务器：自定义 · 上传记录与当前 Key 一致 · 最近一次同步未被服务器拒绝 · 设备标签 [0-9a-f]{4}/);
      assert.match(stdout, /网络：服务器可达 \d/);
      assert.match(stdout, /npm 源（自定义）可达/);
      assert.match(stdout, /设置：项目名：已隐藏 · 额外数据目录 1 个 · Kiki 切点：未设 · Magpie 切点：全部历史/);
      assert.match(stdout, /Mac App · 成功 18s · 上传 12 buckets \/ 3 sessions · CLI 0\.14\.11/);
      assert.match(stdout, /终端 · 失败 18s · 服务器错误 502/);
      assert.match(stdout, /后台服务 · 未记录结束，原因未知/);
      assert.match(stdout, /最近一次后台同步 \d{2}-\d{2} \d{2}:\d{2} 未记录结束/);
      assert.match(stdout, /Codex CLI\s+已检测 · 上次 0 buckets · 正在建立本地索引 120\/400 · 累计已上传 2 buckets \/ 1 sessions/);
      assert.match(stdout, /Kimi Code\s+未检测到数据目录 · 上次 0 buckets · 读文件失败 ×2（read_failed）/);
      assert.match(stdout, /本地登录令牌已加密 ×1（cursor_token_encrypted）/);
      assert.match(stdout, /服务端丢弃 30（服务端还没收录这个来源）/);
      assert.match(stdout, /—— 只含固定字段和错误码/);
      assert.doesNotMatch(stdout, /\x1b\[/, 'no terminal colors in a pasteable report');
      for (const secret of SECRETS) assert.ok(!stdout.includes(secret), secret);
      assert.ok(!stdout.includes(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('doctor on an unconfigured machine without history still reports', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-doctor-empty-'));
  try {
    await withServer((req, res) => { req.resume(); res.writeHead(404).end(); }, async (apiUrl) => {
      // No key yet; the URL only keeps the probe off the production server.
      mkdirSync(join(root, 'config'));
      writeFileSync(join(root, 'config', 'config.json'), JSON.stringify({ apiUrl }));
      const before = snapshot(root);
      const env = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        VIBE_USAGE_DEV: '0',
        VIBE_USAGE_CONFIG_DIR: join(root, 'config'),
        VIBE_USAGE_STATE_DIR: join(root, 'state'),
        npm_config_registry: apiUrl,
        VIBE_USAGE_SURFACE: 'windows-app',
      };
      const { stdout } = await execFileAsync(process.execPath, [bin, 'doctor', '--json'], { env });
      const report = JSON.parse(stdout);
      assert.equal(report.account.configured, false);
      assert.equal(report.account.uploadState, 'none');
      assert.equal(report.account.lastSyncRejected, null);
      assert.equal(report.cli.surface, 'windows-app');
      assert.deepEqual(report.syncHistory, { available: false, entries: [] });
      assert.deepEqual(snapshot(root), before, 'nothing created or changed');
      assert.equal(report.network.server.reachable, true);

      const text = renderDoctorText(report);
      assert.match(text, /账号：尚未配置 Key/);
      assert.match(text, /运行环境（本次调用）/);
      assert.match(text, /最近同步（新的在前）：\n  暂无同步记录/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor rejects unknown options', () => {
  const result = spawnSync(process.execPath, [bin, 'doctor', '--upload'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: vibe-usage doctor \[--json\]/);
});

test('a refused, silent or unresolvable host maps to a fixed probe error', async () => {
  // Refused: a port that was just closed.
  const port = await new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port: free } = server.address();
      server.close(() => resolve(free));
    });
  });
  assert.deepEqual(await probeUrl(`http://127.0.0.1:${port}/`), { reachable: false, latencyMs: null, error: 'connection_refused' });

  // Silent: accepts the connection but never answers.
  await withServer(() => {}, async (apiUrl) => {
    assert.deepEqual(await probeUrl(apiUrl, { timeoutMs: 200 }), { reachable: false, latencyMs: null, error: 'timeout' });
  });

  assert.deepEqual(await probeUrl(''), { reachable: false, latencyMs: null, error: 'network_failed' });
  // DNS, resets and TLS by error code (a real lookup depends on the local
  // resolver: fake-IP proxies answer even for .invalid).
  const codeOf = code => probeErrorCode(Object.assign(new Error('x'), { code }));
  assert.equal(codeOf('ENOTFOUND'), 'dns_failed');
  assert.equal(codeOf('EAI_AGAIN'), 'dns_failed');
  assert.equal(codeOf('ECONNRESET'), 'connection_reset');
  assert.equal(codeOf('CERT_HAS_EXPIRED'), 'tls_failed');
  assert.equal(codeOf('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), 'tls_failed');
  assert.equal(codeOf('ETIMEDOUT'), 'timeout');
  assert.equal(codeOf(undefined), 'network_failed');
});

test('the last-line scrub replaces home, keys, tokens, emails and long strings', () => {
  const home = '/Users/张 三';
  const text = [
    `${home}/.claude/projects/-Users-张-三-Coding-秘密项目`,
    'vbu_abcdef123', 'sk-ant-api03-xyz', 'Bearer abc.def', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
    'zhang.san@example.com', 'A'.repeat(40), 'task-runner risk-free',
  ].join(' | ');
  const scrubbed = scrubText(text, home);
  assert.equal(scrubbed, '~/.claude/projects/-Users-张-三-Coding-秘密项目 | *** | *** | *** | *** | *** | *** | task-runner risk-free');
  assert.deepEqual(scrubDeep({ a: ['vbu_x', 1, null, { b: 'sk-1' }] }, home), { a: ['***', 1, null, { b: '***' }] });
});

test('device tags are 4 hex chars of the hostname hash', () => {
  assert.match(deviceTag('Hogan-MacBook-Pro'), /^[0-9a-f]{4}$/);
  assert.equal(deviceTag('a'), deviceTag('a'));
  assert.notEqual(deviceTag('a'), deviceTag('b'));
  assert.equal(deviceTag(''), null);
  assert.equal(deviceTag(undefined), null);
});

test('the SQLite implementation is the one queryDbJson would use', () => {
  assert.equal(sqliteImplementation({ nodeSqliteAvailable: () => true, cliAvailable: () => assert.fail('not probed') }), 'node:sqlite');
  assert.equal(sqliteImplementation({ nodeSqliteAvailable: () => false, cliAvailable: () => true }), 'sqlite3-cli');
  assert.equal(sqliteImplementation({ nodeSqliteAvailable: () => false, cliAvailable: () => false }), 'none');
});

test('state.json is compared with the current key without being changed', () => {
  const identity = stateIdentity({ apiUrl: 'https://vibecafe.ai', apiKey: KEY });
  const file = getStatePath();
  rmSync(file, { force: true });
  assert.equal(inspectStateIdentity(identity), 'none');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ buckets: {}, sessions: {} }));
  assert.equal(inspectStateIdentity(identity), 'unrecorded');
  writeFileSync(file, JSON.stringify({ buckets: {}, sessions: {}, identity }));
  assert.equal(inspectStateIdentity(identity), 'match');
  const other = stateIdentity({ apiUrl: 'https://vibecafe.ai', apiKey: 'vbu_other' });
  assert.equal(inspectStateIdentity(other), 'mismatch');
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify({ buckets: {}, sessions: {}, identity }));
  writeFileSync(file, '{ corrupt');
  assert.equal(inspectStateIdentity(identity), 'none');
});

test('docs/doctor-json.md documents every code the report can contain', async () => {
  const doc = readFileSync(join(testDir, '..', 'docs', 'doctor-json.md'), 'utf8');
  const { WARNING_CODES } = await import('../src/warning-codes.js');
  const { SYNC_FAILURE_CODES } = await import('../src/sync-history.js');
  const { PROBE_ERRORS } = await import('../src/doctor.js');
  for (const code of [...Object.keys(WARNING_CODES), ...Object.keys(SYNC_FAILURE_CODES), ...Object.keys(PROBE_ERRORS)]) {
    assert.ok(doc.includes(`| \`${code}\` |`), `undocumented code ${code}`);
  }
  for (const field of [
    'schemaVersion', 'generatedAt', 'cli.version', 'cli.surface', 'system.platform', 'system.arch', 'system.release',
    'runtime.name', 'runtime.version', 'sqlite', 'account.configured', 'account.server', 'account.uploadState',
    'account.lastSyncRejected', 'account.deviceTag', 'network.server', 'network.npmRegistry', 'daemon.platform',
    'daemon.installed', 'daemon.mode', 'settings.uploadProject', 'settings.extraRoots', 'settings.kikiStartAt',
    'settings.magpieStartAt', 'syncHistory.available', 'syncHistory.entries[]', 'tools[]',
  ]) {
    assert.ok(doc.includes(`| \`${field}\` |`), `undocumented field ${field}`);
  }
});
