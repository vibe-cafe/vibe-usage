import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  DOCTOR_SCHEMA_VERSION, MERGED_SOURCES, deviceTag, lastSyncRejected, probeErrorCode, probeUrl, renderDoctorText, scrubDeep, scrubText,
} = await import('../src/doctor.js');
const { inspectStateIdentity, stateIdentity, getStatePath } = await import('../src/state.js');
const { sqliteImplementation } = await import('../src/parsers/sqlite.js');
test.after(() => rmSync(scratch, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// The --json contract as data: exact keys (nothing undocumented, nothing
// missing) and types/enums, checked against real reports below.
const { WARNING_CODES: CODES } = await import('../src/warning-codes.js');
const { SYNC_FAILURE_CODES: FAILURES } = await import('../src/sync-history.js');
const { PROBE_ERRORS: PROBES } = await import('../src/doctor.js');
const S = 'string';
const N = 'number';
const B = 'boolean';
const oneOf = (...shapes) => ({ oneOf: shapes });
const enumOf = (...values) => ({ enum: values });
const optional = shape => ({ optional: shape });
const SURFACE = enumOf('cli', 'daemon', 'mac-app', 'windows-app');
const COUNTS = { buckets: N, sessions: N };
const PROBE = { reachable: B, latencyMs: oneOf(N, null), error: oneOf(enumOf(...Object.keys(PROBES)), null) };
const SYNC = {
  startedAt: S,
  endedAt: oneOf(S, null),
  surface: oneOf(SURFACE, null),
  cliVersion: oneOf(S, null),
  runtime: oneOf({ name: enumOf('node', 'bun'), version: oneOf(S, null) }, null),
  result: oneOf(enumOf('success', 'failed', 'partial'), null),
  durationMs: oneOf(N, null),
  uploaded: COUNTS,
  failure: oneOf({ code: enumOf(...Object.keys(FAILURES)), status: optional(N) }, null),
};
const LAST_SYNC = {
  startedAt: S,
  buckets: N,
  sessions: N,
  skipped: B,
  incomplete: B,
  indexing: oneOf({ completed: N, total: N }, null),
  warnings: { mapOf: N, keys: Object.keys(CODES) },
  error: oneOf(enumOf(...Object.keys(CODES)), null),
  serverDropped: N,
};
const TOOL = {
  id: S, name: S, detected: B, extraRoots: N, uploaded: COUNTS, mergedInto: oneOf({ arrayOf: S }, null), lastSync: oneOf(LAST_SYNC, null),
};
const CONTRACT = {
  schemaVersion: enumOf(1),
  generatedAt: S,
  cli: { version: S, surface: SURFACE },
  system: { platform: S, arch: S, release: S },
  runtime: { name: enumOf('node', 'bun'), version: S },
  sqlite: enumOf('node:sqlite', 'sqlite3-cli', 'none'),
  account: {
    configured: B,
    server: enumOf('default', 'custom'),
    uploadState: enumOf('match', 'mismatch', 'unrecorded', 'none'),
    lastSyncRejected: oneOf(B, null),
    deviceTag: oneOf(S, null),
  },
  network: { server: PROBE, npmRegistry: { registry: enumOf('official', 'custom'), ...PROBE } },
  daemon: {
    platform: oneOf(enumOf('launchd', 'systemd', 'taskscheduler'), null),
    installed: B,
    mode: oneOf(enumOf('npx', 'pinned'), null),
    launchPathExists: oneOf(B, null),
  },
  settings: {
    uploadProject: oneOf(B, null),
    extraRoots: N,
    kikiStartAt: enumOf('set', 'unset'),
    magpieStartAt: enumOf('set', 'none', 'unset'),
  },
  syncHistory: { available: B, entries: { arrayOf: SYNC } },
  tools: { arrayOf: TOOL },
};

function contractErrors(value, shape, path = '$') {
  if (shape === null) return value === null ? [] : [`${path}: expected null`];
  if (typeof shape === 'string') return typeof value === shape ? [] : [`${path}: expected ${shape}, got ${JSON.stringify(value)}`];
  if (shape.enum) return shape.enum.includes(value) ? [] : [`${path}: ${JSON.stringify(value)} not in ${shape.enum.join('|')}`];
  if (shape.oneOf) {
    return shape.oneOf.some(branch => contractErrors(value, branch, path).length === 0) ? [] : [`${path}: matches no allowed shape (${JSON.stringify(value)})`];
  }
  if (shape.arrayOf) {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    return value.flatMap((item, index) => contractErrors(item, shape.arrayOf, `${path}[${index}]`));
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path}: expected object`];
  if (shape.mapOf) {
    return Object.entries(value).flatMap(([key, item]) => [
      ...(shape.keys.includes(key) ? [] : [`${path}.${key}: unknown key`]),
      ...contractErrors(item, shape.mapOf, `${path}.${key}`),
    ]);
  }
  const errors = [];
  for (const key of Object.keys(value)) if (!(key in shape)) errors.push(`${path}.${key}: undocumented field`);
  for (const [key, child] of Object.entries(shape)) {
    if (!(key in value)) {
      if (!child?.optional) errors.push(`${path}.${key}: missing`);
      continue;
    }
    errors.push(...contractErrors(value[key], child?.optional ?? child, `${path}.${key}`));
  }
  return errors;
}

function assertContract(report) {
  assert.deepEqual(contractErrors(report, CONTRACT), []);
}

test('the contract checker rejects extra fields, wrong types and unknown codes', () => {
  assert.deepEqual(contractErrors({ a: 1 }, { a: N }), []);
  assert.match(contractErrors({ a: 1, b: 2 }, { a: N })[0], /undocumented field/);
  assert.match(contractErrors({ a: '1' }, { a: N })[0], /expected number/);
  assert.match(contractErrors({}, { a: N })[0], /missing/);
  assert.deepEqual(contractErrors({}, { a: optional(N) }), []);
  assert.match(contractErrors({ w: { nope: 1 } }, { w: LAST_SYNC.warnings })[0], /unknown key/);
});

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
  const cindyDir = join(root, 'cindy');
  for (const dir of [home, configDir, stateDir, join(codexHome, 'sessions'), cindyDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(cindyDir, 'cindy-owner.db'), '');
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
          mcode: { buckets: 0, sessions: 0, skipped: true },
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
    VIBE_USAGE_CINDY_DIRS: cindyDir,
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
      assertContract(report);
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
      // A skip with no warning is a failure; Cursor's skip is its normal partial view.
      assert.equal(report.tools.find(tool => tool.id === 'mcode').lastSync.incomplete, true);
      assert.equal(report.tools.find(tool => tool.id === 'cursor').lastSync.incomplete, false);
      assert.equal(codex.lastSync.incomplete, false, 'an index being built is reported as such');
      const cindy = report.tools.find(tool => tool.id === 'cindy');
      assert.equal(cindy.detected, true);
      assert.deepEqual(cindy.mergedInto, ['codex', 'pi-coding-agent']);
      assert.equal(cindy.lastSync, null);

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
      assert.match(stdout, /后台服务 · 未记录结束，原因未知 · 已上传 12 buckets \/ 3 sessions/);
      assert.match(stdout, /MiniMax Code\s+未检测到数据目录 · 上次 0 buckets · 已跳过，结果不完整/);
      assert.doesNotMatch(stdout, /MiniMax Code[^\n]*正常/);
      assert.match(stdout, /Cindy\s+已检测 · 数据并入 Codex CLI \/ pi/);
      assert.match(stdout, /最近一次后台同步 \d{2}-\d{2} \d{2}:\d{2} 未记录结束/);
      assert.match(stdout, /Codex CLI\s+已检测 · 上次 0 buckets · 正在建立本地索引 120\/400 · 累计已上传 2 buckets \/ 1 sessions/);
      assert.match(stdout, /Kimi Code\s+未检测到数据目录 · 上次 0 buckets · 已跳过，结果不完整 · 读文件失败 ×2（read_failed）/);
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

test('a tool that recovered shows as healthy, a still-pending one keeps its last result', async () => {
  const { handler } = recordingServer();
  await withServer(handler, async (apiUrl) => {
    const { root, env } = setupMachine(apiUrl);
    try {
      writeFileSync(join(env.VIBE_USAGE_STATE_DIR, 'sync-history.json'), JSON.stringify({
        schemaVersion: 1,
        entries: [
          historyEntry({
            id: 'old', startedAt: '2026-11-09T04:00:00.000Z', parsed: true, pending: [],
            tools: {
              codex: { buckets: 0, sessions: 0, error: 'parser_error' },
              cursor: { buckets: 0, sessions: 0, skipped: true, warnings: { auth_rejected: 1 } },
            },
          }),
          // Newest: codex ran and had nothing to say; Cursor was still exporting
          // when the process ended.
          historyEntry({ id: 'new', startedAt: '2026-11-09T05:00:00.000Z', result: null, endedAt: null, durationMs: null, parsed: true, pending: ['cursor'], tools: {} }),
        ],
      }));
      const { stdout } = await execFileAsync(process.execPath, [bin, 'doctor', '--json'], { env });
      const report = JSON.parse(stdout);
      assertContract(report);
      const codex = report.tools.find(tool => tool.id === 'codex');
      assert.deepEqual(codex.lastSync, {
        startedAt: '2026-11-09T05:00:00.000Z', buckets: 0, sessions: 0, skipped: false, incomplete: false,
        indexing: null, warnings: {}, error: null, serverDropped: 0,
      });
      const cursor = report.tools.find(tool => tool.id === 'cursor');
      assert.equal(cursor.lastSync.startedAt, '2026-11-09T04:00:00.000Z');
      assert.deepEqual(cursor.lastSync.warnings, { auth_rejected: 1 });
      assert.equal(report.tools.some(tool => tool.id === 'gemini-cli'), false, 'an absent tool with nothing to report is not listed');
      assert.equal(report.account.lastSyncRejected, null, 'an unfinished newest sync says nothing about the key');

      const text = renderDoctorText(report);
      assert.match(text, /Codex CLI\s+已检测 · 上次无新数据 · 正常/);
      assert.match(text, /账号：已配置 Key · [^\n]*无法判断 Key 是否被拒/);
      assert.match(text, /Cursor\s+未检测到数据目录 · 上次 0 buckets · 登录凭证被拒绝/);
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
      assertContract(report);
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

test('doctor reports an installed service whose launch path is gone', {
  skip: !(process.platform === 'darwin' || (process.platform === 'linux' && existsSync('/run/systemd/system'))),
}, async () => {
  const { generateLaunchdPlist, generateSystemdUnit } = await import('../src/daemon-service.js');
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-doctor-daemon-'));
  try {
    await withServer((req, res) => { req.resume(); res.writeHead(404).end(); }, async (apiUrl) => {
      mkdirSync(join(root, 'config'));
      writeFileSync(join(root, 'config', 'config.json'), JSON.stringify({ apiUrl }));
      const launchd = process.platform === 'darwin';
      const unitFile = launchd
        ? join(root, 'Library', 'LaunchAgents', 'ai.vibecafe.vibe-usage.plist')
        : join(root, '.config', 'systemd', 'user', 'vibe-usage.service');
      mkdirSync(dirname(unitFile), { recursive: true });
      const generate = launchd ? generateLaunchdPlist : generateSystemdUnit;
      const goneNpx = join(root, 'Cellar', 'node', '26.8.2', 'bin', 'npx');
      writeFileSync(unitFile, generate(join(dirname(goneNpx), 'node'), '/x/_npx/h/bin.js', undefined, {},
        { mode: 'npx', npxPath: goneNpx, nodeDir: dirname(goneNpx) }));
      const env = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        VIBE_USAGE_DEV: '0',
        VIBE_USAGE_CONFIG_DIR: join(root, 'config'),
        VIBE_USAGE_STATE_DIR: join(root, 'state'),
        npm_config_registry: apiUrl,
      };
      const broken = JSON.parse((await execFileAsync(process.execPath, [bin, 'doctor', '--json'], { env })).stdout);
      assertContract(broken);
      assert.deepEqual(broken.daemon, { platform: launchd ? 'launchd' : 'systemd', installed: true, mode: 'npx', launchPathExists: false });
      const text = renderDoctorText(broken);
      assert.match(text, /后台：CLI 后台服务：已安装（[^\n]*） · 启动路径已不存在，后台同步已停止[^\n]*daemon install` 重新注册/);
      const plain = (await execFileAsync(process.execPath, [bin, 'doctor'], { env })).stdout;
      assert.match(plain, /启动路径已不存在，后台同步已停止/);
      assert.ok(!plain.includes(root), 'no temporary path in the report');

      writeFileSync(unitFile, generate(process.execPath, bin, undefined, {}));
      const healthy = JSON.parse((await execFileAsync(process.execPath, [bin, 'doctor', '--json'], { env })).stdout);
      assert.equal(healthy.daemon.launchPathExists, true);
      assert.equal(healthy.daemon.mode, 'pinned');
      assert.doesNotMatch(renderDoctorText(healthy), /启动路径已不存在/);
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

test('probes go through the default global agent, like uploads', async () => {
  const { default: http } = await import('node:http');
  const original = http.globalAgent;
  const spy = new http.Agent();
  let connections = 0;
  const create = spy.createConnection.bind(spy);
  spy.createConnection = (...args) => { connections++; return create(...args); };
  http.globalAgent = spy;
  try {
    await withServer((req, res) => { req.resume(); res.writeHead(401).end(); }, async (apiUrl) => {
      const result = await probeUrl(`${apiUrl}/api/usage/settings`);
      assert.equal(result.reachable, true);
    });
  } finally {
    http.globalAgent = original;
    spy.destroy();
  }
  assert.equal(connections, 1, 'a private agent would bypass NODE_USE_ENV_PROXY');
});

// NODE_USE_ENV_PROXY exists from Node 22.21 / 24.5 (CI runs the latest 22.x
// and 24.x); older runtimes skip this end-to-end check.
function supportsEnvProxy(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major > 24 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21);
}

test('with NODE_USE_ENV_PROXY both probes go through the environment proxy', { skip: !supportsEnvProxy() && 'needs Node 22.21+ / 24.5+' }, async () => {
  const seen = [];
  // A plain HTTP proxy: it receives absolute-form requests for hosts that do
  // not resolve, so a direct connection could never succeed.
  await withServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume();
    res.writeHead(req.url.endsWith('/api/usage/settings') ? 401 : 200).end('{}');
  }, async (proxyUrl) => {
    const root = mkdtempSync(join(tmpdir(), 'vibe-usage-doctor-proxy-'));
    try {
      mkdirSync(join(root, 'config'));
      writeFileSync(join(root, 'config', 'config.json'), JSON.stringify({ apiUrl: 'http://doctor-target.invalid' }));
      const env = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        VIBE_USAGE_DEV: '0',
        VIBE_USAGE_CONFIG_DIR: join(root, 'config'),
        VIBE_USAGE_STATE_DIR: join(root, 'state'),
        npm_config_registry: 'http://doctor-registry.invalid/',
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: proxyUrl,
        http_proxy: proxyUrl,
      };
      for (const name of ['NO_PROXY', 'no_proxy', 'HTTPS_PROXY', 'https_proxy']) delete env[name];
      const { stdout } = await execFileAsync(process.execPath, [bin, 'doctor', '--json'], { env });
      const report = JSON.parse(stdout);
      assert.equal(report.network.server.reachable, true);
      assert.equal(report.network.npmRegistry.reachable, true);
      assert.deepEqual(seen.sort(), [
        'GET http://doctor-registry.invalid/-/ping',
        'GET http://doctor-target.invalid/api/usage/settings',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('the last-line scrub replaces home, keys, tokens, emails and long strings', () => {
  const home = '/Users/张 三';
  const text = [
    `${home}/.claude/projects/-Users-张-三-Coding-秘密项目`,
    'vbu_abcdef123', 'sk-ant-api03-xyz', 'Bearer abc.def', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
    'zhang.san@example.com', 'Ab'.repeat(20), 'task-runner risk-free',
  ].join(' | ');
  const scrubbed = scrubText(text, home);
  assert.equal(scrubbed, '~/.claude/projects/-Users-张-三-Coding-秘密项目 | *** | *** | *** | *** | *** | *** | task-runner risk-free');
  assert.deepEqual(scrubDeep({ a: ['vbu_x', 1, null, { b: 'sk-1' }] }, home), { a: ['***', 1, null, { b: '***' }] });
  // A bare environment-variable name is not a secret, even at 40+ characters;
  // anything else of that length still is.
  assert.equal(scrubText('设了 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC、ANTHROPIC_BASE_URL', home),
    '设了 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC、ANTHROPIC_BASE_URL');
  assert.equal(scrubText(`X ${'A'.repeat(50)}b Y`, home), 'X *** Y');
  assert.equal(scrubText(`X ${'A1_'.repeat(20)}= Y`, home), 'X *** Y');
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
    'daemon.installed', 'daemon.mode', 'daemon.launchPathExists', 'settings.uploadProject', 'settings.extraRoots', 'settings.kikiStartAt',
    'settings.magpieStartAt', 'syncHistory.available', 'syncHistory.entries[]', 'tools[]',
  ]) {
    assert.ok(doc.includes(`| \`${field}\` |`), `undocumented field ${field}`);
  }
  for (const key of [...Object.keys(SYNC), ...Object.keys(TOOL)]) {
    assert.ok(doc.includes(`| \`${key}\` |`), `undocumented field ${key}`);
  }
  for (const key of Object.keys(LAST_SYNC)) {
    assert.ok(doc.includes(`\`lastSync.${key}\``) || doc.includes(`\`.${key}\``), `undocumented field lastSync.${key}`);
  }
});

test('the account line reads only the newest sync record', () => {
  const entry = (result, failure = null) => ({ result, failure });
  assert.equal(lastSyncRejected([]), null);
  assert.equal(lastSyncRejected([entry('success'), entry('failed', { code: 'unauthorized' })]), false);
  assert.equal(lastSyncRejected([entry('failed', { code: 'unauthorized' }), entry('success')]), true);
  assert.equal(lastSyncRejected([entry('partial', { code: 'unauthorized' })]), true);
  for (const newest of [
    entry(null),
    entry('failed', { code: 'server_error', status: 502 }),
    entry('failed', { code: 'network_failed' }),
    entry('failed', { code: 'settings_unavailable' }),
    entry('partial', { code: 'unexpected_error' }),
  ]) {
    assert.equal(lastSyncRejected([newest, entry('success')]), null, JSON.stringify(newest));
  }
});

test('every tool has a parser except the ones merged into another source', async () => {
  const { TOOLS } = await import('../src/tools.js');
  const { parsers } = await import('../src/parsers/index.js');
  const withParser = TOOLS.map(tool => tool.id).filter(id => !MERGED_SOURCES[id]).sort();
  assert.deepEqual(withParser, Object.keys(parsers).sort(),
    'doctor zero-fills "ran, no data" for every tool with a parser; a tool without one must be listed in MERGED_SOURCES');
  for (const targets of Object.values(MERGED_SOURCES)) {
    for (const id of targets) assert.ok(parsers[id], id);
  }
});
