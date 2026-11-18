// Codex Ultrafast cut, end to end: the real sync (child processes, isolated
// HOME) against a stand-in server that applies the rules the vibe-cafe ingest
// applies -- a stored bucket never shrinks, the cut is registered once with the
// server-side floor, Codex windows whose format disagrees with the cut are
// refused (409 for a collector that declares nothing, `rejected` otherwise),
// and the CLI reset's delete rewinds an existing cut to the epoch.
//
// A collector older than this feature is emulated by posting the merged format
// without a declaration; its bytes are what `syncMerged()` (this version with
// no cut) produces, which the parser tests pin to the pre-change output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import {
  MODEL, W1000, W1030, W1100, at, mixedSession, tokenCount, turnContext, usage, ULTRAFAST_TIER_VALUE,
} from './fixtures/codex-ultrafast/rollout.js';

const exec = promisify(execFile);
const UF = `${MODEL}-ultrafast`;
const EPOCH = '1970-01-01T00:00:00.000Z';
const HALF_HOUR = 1_800_000;
const HOST = 'fixture-host';
const sixTotal = b => (b.inputTokens || 0) + (b.outputTokens || 0) + (b.cachedInputTokens || 0)
  + (b.reasoningOutputTokens || 0) + (b.cacheCreation5mTokens || 0) + (b.cacheCreation1hTokens || 0);

// ------------------------------------------------------------ stand-in server ---
async function startServer(t) {
  const s = {
    rows: new Map(), // key -> bucket
    cuts: new Map(), // hostname -> ISO
    requests: [],
    reportCut: true, // false: a server that predates the feature (or was rolled back)
    registration: 'ok', // 'down' -> 503
    failNextIngest: 0,
    failDelete: false,
    settingsDown: false,
    afterSettings: null,
  };
  const splits = (cut, window) => cut != null && Date.parse(window) >= Date.parse(cut);
  const latestCodexWindow = (hostname) => {
    let latest = null;
    for (const row of s.rows.values()) {
      if (row.source === 'codex' && row.hostname === hostname && (!latest || row.bucketStart > latest)) latest = row.bucketStart;
    }
    return latest;
  };
  s.register = (hostname, proposedStartAt) => {
    if (s.cuts.has(hostname)) return { startAt: s.cuts.get(hostname), created: false };
    const ceiling = (Math.floor(Date.now() / HALF_HOUR) + 1) * HALF_HOUR;
    const latest = latestCodexWindow(hostname);
    const startAt = new Date(Math.max(
      Math.min(Date.parse(proposedStartAt), ceiling),
      latest ? Date.parse(latest) + HALF_HOUR : 0,
    )).toISOString();
    s.cuts.set(hostname, startAt);
    return { startAt, created: true };
  };
  s.ingest = (payload) => {
    const declared = payload.client && Object.hasOwn(payload.client, 'codexUltrafastStartAt');
    const requestCut = declared ? payload.client.codexUltrafastStartAt : null;
    let rejected = 0;
    let written = 0;
    for (const bucket of payload.buckets || []) {
      if (bucket.source === 'codex'
        && splits(s.cuts.get(bucket.hostname), bucket.bucketStart) !== splits(requestCut, bucket.bucketStart)) {
        rejected++;
        continue;
      }
      const key = [bucket.source, bucket.model, bucket.project, bucket.hostname, bucket.bucketStart].join('|');
      const existing = s.rows.get(key);
      if (!existing || sixTotal(bucket) >= sixTotal(existing)) s.rows.set(key, bucket);
      written++;
    }
    const body = {
      ingested: written,
      sessions: payload.sessions?.length || 0,
      ...(rejected > 0 && { rejected: { buckets: rejected, sources: ['codex'], reason: 'codex-ultrafast-cut', startAt: s.cuts.get(HOST) ?? null } }),
    };
    return rejected > 0 && !declared
      ? { status: 409, body: { error: '请升级：npx @vibe-cafe/vibe-usage@latest', code: 'codex-ultrafast-cut', ...body } }
      : { status: 200, body };
  };
  /** `{ '<model>@<HH:MM>': tokens }` for one machine's Codex rows. */
  s.codex = (hostname = HOST) => Object.fromEntries([...s.rows.values()]
    .filter(row => row.source === 'codex' && row.hostname === hostname)
    .map(row => [`${row.model}@${row.bucketStart.slice(11, 16)}`, sixTotal(row)]).sort());
  s.total = () => Object.values(s.codex()).reduce((sum, n) => sum + n, 0);
  s.sent = (method, path) => s.requests.filter(r => r.method === method && r.path === path);

  const http = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const payload = raw.length
        ? JSON.parse(req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw)
        : null;
      s.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), payload });
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'GET' && url.pathname === '/api/usage/settings') {
        if (s.settingsDown) return send(500, { error: 'down' });
        const hostname = url.searchParams.get('hostname');
        send(200, {
          uploadProject: true,
          ...(s.reportCut && hostname ? { codexUltrafast: { startAt: s.cuts.get(hostname) ?? null } } : {}),
        });
        if (s.afterSettings) { const hook = s.afterSettings; s.afterSettings = null; hook(); }
        return undefined;
      }
      if (req.method === 'POST' && url.pathname === '/api/usage/codex-ultrafast-start') {
        if (s.registration === 'down') return send(503, { error: 'unavailable' });
        return send(200, s.register(payload.hostname, payload.proposedStartAt));
      }
      if (req.method === 'POST' && url.pathname === '/api/usage/ingest') {
        if (s.failNextIngest > 0) { s.failNextIngest--; return send(500, { error: 'boom' }); }
        const { status, body } = s.ingest(payload);
        return send(status, body);
      }
      if (req.method === 'DELETE' && url.pathname === '/api/usage/ingest') {
        if (s.failDelete) return send(500, { error: 'boom' });
        const hostname = url.searchParams.get('hostname');
        let deleted = 0;
        for (const [key, row] of s.rows) if (!hostname || row.hostname === hostname) { s.rows.delete(key); deleted++; }
        for (const name of s.cuts.keys()) if (!hostname || name === hostname) s.cuts.set(name, EPOCH);
        return send(200, { deleted, sessions: 0 });
      }
      return send(200, {});
    });
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  s.apiUrl = `http://127.0.0.1:${http.address().port}`;
  return s;
}

// ------------------------------------------------------------------ machine ---
function machine(t, server) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-codex-ultrafast-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
    XDG_CONFIG_HOME: join(root, 'xdg'), XDG_DATA_HOME: join(root, 'data'),
    VIBE_USAGE_CONFIG_DIR: root, VIBE_USAGE_STATE_DIR: root, VIBE_USAGE_CACHE_DIR: join(root, 'cache'),
    CODEX_HOME: join(root, 'codex'), VIBE_USAGE_CINDY_DIRS: join(root, 'absent'),
    VIBE_USAGE_MAGPIE_TEST_FILE: join(root, 'absent-ledger.jsonl'), VIBE_USAGE_DEV: '0',
    VIBE_USAGE_API_URL: server.apiUrl,
    VIBE_USAGE_OMP_SESSION_DIRS: join(root, 'omp'),
  };
  const rollout = join(env.CODEX_HOME, 'sessions', '2026', '11', '10', 'rollout-mixed.jsonl');
  const run = code => exec(process.execPath, ['--input-type=module', '-e', code], { env, cwd: process.cwd() });
  const onlyCodex = `
    const { parsers } = await import('./src/parsers/index.js');
    for (const key of Object.keys(parsers)) if (key !== 'codex') delete parsers[key];
  `;
  const m = {
    root, env, run,
    configure(apiKey = 'vbu_fixture') {
      writeFileSync(join(root, 'config.json'), JSON.stringify({ apiKey, apiUrl: server.apiUrl, hostname: HOST }));
    },
    write(records) {
      mkdirSync(dirname(rollout), { recursive: true });
      writeFileSync(rollout, records.map(JSON.stringify).join('\n') + '\n');
    },
    append(records) { appendFileSync(rollout, records.map(JSON.stringify).join('\n') + '\n'); },
    state() { return JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')); },
    history() { return JSON.parse(readFileSync(join(root, 'sync-history.json'), 'utf8')).entries; },
    /** Another tool's log on this machine: one Oh My Pi call of 150 tokens. */
    writeOtherTool(timestamp = at('10:31')) {
      const file = join(env.VIBE_USAGE_OMP_SESSION_DIRS, 'session.jsonl');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, [
        { type: 'session', id: `fixture-${timestamp}`, timestamp, cwd: '/Users/x/proj' },
        { type: 'message', id: `reply-${timestamp}`, timestamp, message: { role: 'assistant', provider: 'fixture', model: 'fixture-model',
          responseId: `reply-${timestamp}`, usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0 } } },
      ].map(JSON.stringify).join('\n') + '\n');
    },
    /**
     * `vibe-usage sync` exactly as a desktop app runs it: the real entry point,
     * every parser, piped output. Resolves with what the app gets to see.
     */
    async appSync() {
      try {
        const { stdout, stderr } = await exec(process.execPath, ['bin/vibe-usage.js', 'sync'], { env, cwd: process.cwd() });
        return { exitCode: 0, stdout, stderr };
      } catch (err) {
        return { exitCode: err.code, stdout: err.stdout, stderr: err.stderr };
      }
    },
    codexStateKeys() {
      return existsSync(join(root, 'state.json'))
        ? Object.keys(m.state().buckets).filter(key => key.startsWith('codex|')).map(key => key.split('|')).map(p => `${p[1]}@${p.at(-1).slice(11, 16)}`).sort()
        : [];
    },
    sync({ surface = 'cli', extra = '' } = {}) {
      return run(`${onlyCodex}${extra}
        const { runSync } = await import('./src/sync.js');
        await runSync({ quiet: true, surface: ${JSON.stringify(surface)}, throws: true });`);
    },
    /** The merged format with no cut: registration is unavailable for this one run. */
    async syncMerged() {
      const previous = server.registration;
      server.registration = 'down';
      try { return await m.sync(); } finally { server.registration = previous; }
    },
    reset(args = ['--local']) {
      return run(`${onlyCodex}
        const { runReset } = await import('./src/reset.js');
        await runReset(${JSON.stringify(args)}, { prompt: async () => 'y' });`);
    },
    /** Pretend a background service is registered for this HOME. */
    installService() {
      for (const file of [
        join(root, 'Library', 'LaunchAgents', 'ai.vibecafe.vibe-usage.plist'),
        join(root, '.config', 'systemd', 'user', 'vibe-usage.service'),
      ]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'fixture'); }
    },
    async serviceDetected() {
      const { stdout } = await run(`const { isDaemonInstalled } = await import('./src/daemon-service.js'); process.stdout.write(String(isDaemonInstalled()));`);
      return stdout === 'true';
    },
  };
  m.configure();
  return m;
}

const earlyOnly = () => mixedSession().slice(0, 3); // 50 standard at 10:05
const rest = () => mixedSession().slice(3); // +5 UF at 10:29, 60 standard + 40 UF in 10:30
const legacyBucket = (bucketStart, total) => ({
  source: 'codex', model: MODEL, project: 'proj', hostname: HOST, bucketStart,
  inputTokens: total, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: total,
});
/** What a pre-feature collector sends: merged buckets, no declaration. */
const legacyUpload = (server, buckets) => server.ingest({ buckets, client: { collectorVersion: '0.14.12', surface: 'mac-app', hostname: HOST } });

// ---------------------------------------------------------------- scenarios ---
test('upgrade on a machine with history: the cut lands after the last uploaded window and stays there', async (t) => {
  const server = await startServer(t);
  const m = machine(t, server);
  m.write(earlyOnly());
  await m.syncMerged();
  assert.deepEqual(server.codex(), { [`${MODEL}@10:00`]: 50 });
  assert.equal(server.cuts.size, 0);

  // First sync that may register (no background service): the 10:00 window was
  // uploaded, so the cut is 10:30. A late 10:29 Ultrafast call still grows the
  // merged 10:00 bucket; 10:30 is split.
  m.append(rest());
  const first = await m.sync();
  assert.match(first.stderr, /已登记这台设备的 Ultrafast 档位起点，2026-11-10T10:30:00.000Z 之前保持原名/);
  assert.equal(server.cuts.get(HOST), W1030);
  assert.deepEqual(server.codex(), { [`${MODEL}@10:00`]: 55, [`${MODEL}@10:30`]: 60, [`${UF}@10:30`]: 40 });
  assert.equal(server.total(), 155);
  const uploads = server.sent('POST', '/api/usage/ingest');
  assert.equal(uploads.at(-1).payload.client.codexUltrafastStartAt, W1030);
  assert.equal(server.sent('GET', '/api/usage/settings').at(-1).query.hostname, HOST);

  // Later syncs read the cut and never ask again.
  const registrations = server.sent('POST', '/api/usage/codex-ultrafast-start').length;
  m.append([turnContext(at('11:05'), { model: MODEL, serviceTier: ULTRAFAST_TIER_VALUE }), tokenCount(at('11:06'), usage(9), 164)]);
  await m.sync();
  assert.equal(server.sent('POST', '/api/usage/codex-ultrafast-start').length, registrations);
  assert.equal(server.cuts.get(HOST), W1030);
  assert.deepEqual(server.codex(), {
    [`${MODEL}@10:00`]: 55, [`${MODEL}@10:30`]: 60, [`${UF}@10:30`]: 40, [`${UF}@11:00`]: 9,
  });

  // An older collector on the same machine (a desktop app on its cached CLI)
  // cannot fold 10:30 back together, however often it retries.
  for (let attempt = 0; attempt < 2; attempt++) {
    const refused = legacyUpload(server, [legacyBucket(W1000, 55), legacyBucket(W1030, 100), legacyBucket(W1100, 9)]);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.rejected.buckets, 2);
  }
  assert.equal(server.total(), 164);
});

test('a fresh machine starts at the epoch: all local history is split from the first upload', async (t) => {
  const server = await startServer(t);
  const m = machine(t, server);
  m.write(mixedSession());
  const result = await m.sync();
  assert.match(result.stderr, /全部本地历史的 Ultrafast 用量单独计价/);
  assert.equal(server.cuts.get(HOST), EPOCH);
  assert.deepEqual(server.codex(), {
    [`${MODEL}@10:00`]: 50, [`${UF}@10:00`]: 5, [`${MODEL}@10:30`]: 60, [`${UF}@10:30`]: 40,
  });
});

test('with a background service installed only the service registers; other collectors keep the merged format', async (t) => {
  const server = await startServer(t);
  const m = machine(t, server);
  m.installService();
  if (!await m.serviceDetected()) return t.skip('no supported service manager on this platform');
  m.write(mixedSession());

  // The desktop app got the new CLI first. It may not register, and uploads
  // exactly what the still-old daemon uploads; the two alternate freely.
  for (let round = 0; round < 2; round++) {
    await m.sync({ surface: 'cli' });
    assert.equal(legacyUpload(server, [legacyBucket(W1000, 55), legacyBucket(W1030, 100)]).status, 200);
  }
  assert.equal(server.sent('POST', '/api/usage/codex-ultrafast-start').length, 0);
  assert.equal(server.sent('POST', '/api/usage/ingest').at(-1).payload.client.codexUltrafastStartAt, null);
  assert.deepEqual(server.codex(), { [`${MODEL}@10:00`]: 55, [`${MODEL}@10:30`]: 100 });

  // The daemon restarts on the new version: it registers, after everything uploaded.
  await m.sync({ surface: 'daemon' });
  assert.equal(server.cuts.get(HOST), W1100);
  assert.deepEqual(server.codex(), { [`${MODEL}@10:00`]: 55, [`${MODEL}@10:30`]: 100 });
  m.append([turnContext(at('11:05'), { model: MODEL, serviceTier: ULTRAFAST_TIER_VALUE }), tokenCount(at('11:06'), usage(9), 164)]);
  await m.sync({ surface: 'cli' });
  assert.deepEqual(server.codex(), { [`${MODEL}@10:00`]: 55, [`${MODEL}@10:30`]: 100, [`${UF}@11:00`]: 9 });
  // The app falls back to its cached old CLI: refused, nothing changes.
  assert.equal(legacyUpload(server, [legacyBucket(W1100, 9)]).status, 409);
  assert.equal(server.total(), 164);
});

test('losing state.json and config.json, or changing the API key, never moves the cut or adds a key', async (t) => {
  const server = await startServer(t);
  const m = machine(t, server);
  m.write(earlyOnly());
  await m.syncMerged();

  // "Reset configuration" in the Windows app before any cut exists: the local
  // state says nothing was uploaded, the server knows better.
  rmSync(join(m.root, 'state.json'));
  rmSync(join(m.root, 'config.json'));
  m.configure();
  m.append(rest());
  await m.sync();
  assert.equal(server.cuts.get(HOST), W1030);
  const expected = { [`${MODEL}@10:00`]: 55, [`${MODEL}@10:30`]: 60, [`${UF}@10:30`]: 40 };
  assert.deepEqual(server.codex(), expected);
  const keys = [...server.rows.keys()].sort();
  const registrations = server.sent('POST', '/api/usage/codex-ultrafast-start').length;

  // The same again with the cut registered: a full re-upload of identical rows.
  rmSync(join(m.root, 'state.json'));
  rmSync(join(m.root, 'config.json'));
  m.configure();
  const before = server.sent('POST', '/api/usage/ingest').length;
  await m.sync();
  assert.ok(server.sent('POST', '/api/usage/ingest').length > before, 'the history was re-sent');
  // A new key for the same account: state.json is discarded as another identity's.
  m.configure('vbu_rotated_key');
  await m.sync();
  assert.equal(server.cuts.get(HOST), W1030);
  assert.deepEqual(server.codex(), expected);
  assert.deepEqual([...server.rows.keys()].sort(), keys);
  assert.equal(server.sent('POST', '/api/usage/codex-ultrafast-start').length, registrations, 'a registered cut is never asked for again');
});

test('right after an upload-identity change the proposal is the end of the current half hour', async (t) => {
  const server = await startServer(t);
  const m = machine(t, server);
  m.write(mixedSession());
  await m.syncMerged();
  server.rows.clear(); // another account on the same server: it holds nothing for this machine
  m.configure('vbu_other_account');
  await m.sync();
  const cut = Date.parse(server.cuts.get(HOST));
  assert.ok(cut > Date.now() && cut <= Date.now() + HALF_HOUR);
  assert.equal(cut % HALF_HOUR, 0);
  // All local history is before that cut: merged, as the rule says.
  assert.deepEqual(server.codex(), { [`${MODEL}@10:00`]: 55, [`${MODEL}@10:30`]: 100 });
});

test('reset: an existing cut is rewound by the delete and the history comes back once, split', async (t) => {
  const server = await startServer(t);
  const m = machine(t, server);
  m.write(earlyOnly());
  await m.syncMerged();
  m.append(rest());
  await m.sync();
  assert.equal(server.cuts.get(HOST), W1030);
  assert.deepEqual(server.codex(), { [`${MODEL}@10:00`]: 55, [`${MODEL}@10:30`]: 60, [`${UF}@10:30`]: 40 });

  // A failed delete changes nothing: rows, cut and local state all stay.
  server.failDelete = true;
  const stateBefore = m.state();
  await assert.rejects(m.reset());
  assert.equal(server.cuts.get(HOST), W1030);
  assert.equal(server.total(), 155);
  assert.deepEqual(m.state(), stateBefore);

  server.failDelete = false;
  await m.reset();
  assert.equal(server.cuts.get(HOST), EPOCH);
  assert.deepEqual(server.codex(), {
    [`${MODEL}@10:00`]: 50, [`${UF}@10:00`]: 5, [`${MODEL}@10:30`]: 60, [`${UF}@10:30`]: 40,
  });
  assert.equal(server.total(), 155);
  assert.deepEqual(m.codexStateKeys(), [`${MODEL}-ultrafast@10:00`, `${MODEL}-ultrafast@10:30`, `${MODEL}@10:00`, `${MODEL}@10:30`]);
  // An older collector replaying its whole history afterwards is refused outright.
  assert.equal(legacyUpload(server, [legacyBucket(W1000, 55), legacyBucket(W1030, 100)]).status, 409);
  assert.equal(server.total(), 155);
});

test('reset on a machine that never had a cut and may register: all history is split, one copy', async (t) => {
  const server = await startServer(t);
  const m = machine(t, server);
  m.write(mixedSession());
  await m.syncMerged();
  assert.deepEqual(server.codex(), { [`${MODEL}@10:00`]: 55, [`${MODEL}@10:30`]: 100 });
  await m.reset();
  assert.equal(server.cuts.get(HOST), EPOCH);
  assert.equal(server.total(), 155);
  assert.equal(Object.keys(server.codex()).length, 4);
});

const lastLine = text => text.trim().split('\n').filter(Boolean).at(-1) || '';

test('no answer about the cut: Codex is held, other tools upload, and the app is told the sync was only partly done', async (t) => {
  const server = await startServer(t);
  const m = machine(t, server);
  m.write(earlyOnly());
  await m.syncMerged();
  const keysBefore = m.codexStateKeys();
  m.append(rest());
  m.writeOtherTool();

  // A server that does not report the cut (not deployed yet, or rolled back).
  server.reportCut = false;
  const held = await m.appSync();
  // The other tool went up and stdout says so, as on any sync ...
  assert.match(held.stdout, /已同步 1 buckets/);
  assert.equal([...server.rows.values()].filter(row => row.source === 'omp').length, 1);
  // ... but the run does not end as a success: exit code 1 and, as the last
  // stderr line (the one the Windows app shows), what was uploaded and what was not.
  assert.equal(held.exitCode, 1);
  assert.match(lastLine(held.stderr), /部分完成（已上传 1 buckets · 1 sessions）: Codex 本次未上传：服务端暂时没有答复这台设备的 Ultrafast 档位起点，其他工具已正常同步，下次同步自动补传。/);
  assert.doesNotMatch(held.stdout, /Codex 本次未上传|Ultrafast/);
  // Nothing of Codex was sent, and nothing of its upload state was dropped.
  assert.deepEqual(server.codex(), { [`${MODEL}@10:00`]: 50 });
  assert.deepEqual(m.codexStateKeys(), keysBefore);
  assert.equal(server.sent('POST', '/api/usage/ingest').at(-1).payload.client.codexUltrafastStartAt, undefined);
  // The local sync history carries the fixed code.
  const entry = m.history().at(-1);
  assert.equal(entry.result, 'partial');
  assert.deepEqual(entry.failure, { code: 'codex_held' });
  assert.equal(entry.uploaded.buckets, 1);
  assert.equal(entry.tools.codex.skipped, true);
  assert.equal(entry.tools.codex.warnings.upload_withheld, 1);

  // The settings endpoint is down and the cached privacy choice stands in.
  // Nothing new from the other tool this time: still not a success.
  server.reportCut = true;
  server.settingsDown = true;
  const offline = await m.appSync();
  assert.equal(offline.exitCode, 1);
  assert.match(lastLine(offline.stderr), /同步未完成: Codex 本次未上传：/);
  assert.doesNotMatch(offline.stdout, /已同步/);
  assert.deepEqual(m.history().at(-1).failure, { code: 'codex_held' });
  assert.equal(m.history().at(-1).result, 'failed');
  assert.deepEqual(server.codex(), { [`${MODEL}@10:00`]: 50 });

  // The daemon (`throws`) gets an error it can log instead of an exit.
  await assert.rejects(m.sync({ surface: 'daemon' }), /CODEX_HELD/);

  // Back to normal: the pause is made up on the next sync, which succeeds.
  server.settingsDown = false;
  const recovered = await m.appSync();
  assert.equal(recovered.exitCode, 0);
  assert.equal(m.history().at(-1).result, 'success');
  assert.deepEqual(server.codex(), { [`${MODEL}@10:00`]: 55, [`${MODEL}@10:30`]: 60, [`${UF}@10:30`]: 40 });
});

test('a machine without Codex is not failed when the server gives no answer about the cut', async (t) => {
  const server = await startServer(t);
  const m = machine(t, server);
  m.writeOtherTool();
  server.reportCut = false;
  const result = await m.appSync();
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /已同步 1 buckets/);
  assert.doesNotMatch(result.stderr, /Codex|Ultrafast/);
  assert.equal(m.history().at(-1).result, 'success');
});

test('a cut registered by another collector mid-sync: refused rows stay uncommitted and are re-sent split', async (t) => {
  const server = await startServer(t);
  const m = machine(t, server);
  m.write(earlyOnly());
  await m.syncMerged();
  m.append(rest());

  // This run reads "no cut" and cannot register; the daemon registers 10:30
  // right after the settings answer went out.
  server.registration = 'down';
  server.afterSettings = () => server.cuts.set(HOST, W1030);
  const stale = await m.sync();
  assert.match(stale.stderr, /codex: 服务端登记的 Ultrafast 档位起点与本次同步不一致，1 个 bucket 未上传/);
  assert.deepEqual(server.codex(), { [`${MODEL}@10:00`]: 55 });
  assert.deepEqual(m.codexStateKeys(), [`${MODEL}@10:00`], 'nothing of the refused batch is recorded as uploaded');

  server.registration = 'ok';
  await m.sync();
  assert.deepEqual(server.codex(), { [`${MODEL}@10:00`]: 55, [`${MODEL}@10:30`]: 60, [`${UF}@10:30`]: 40 });
  assert.deepEqual(m.codexStateKeys(), [`${MODEL}-ultrafast@10:30`, `${MODEL}@10:00`, `${MODEL}@10:30`]);
});

test('a failed upload is retried without double counting; a lost registration answer heals on the next sync', async (t) => {
  const server = await startServer(t);
  const m = machine(t, server);
  m.write(earlyOnly());
  await m.syncMerged();
  m.append(rest());

  // The registration reaches the server but the answer does not come back.
  server.registration = 'down';
  server.afterSettings = () => server.register(HOST, W1030);
  await m.sync();
  assert.equal(server.cuts.get(HOST), W1030);
  assert.deepEqual(server.codex(), { [`${MODEL}@10:00`]: 55 });

  // Next sync: the upload itself fails on every attempt, then succeeds.
  server.registration = 'ok';
  server.failNextIngest = 3;
  await assert.rejects(m.sync());
  assert.deepEqual(server.codex(), { [`${MODEL}@10:00`]: 55 });
  await m.sync();
  await m.sync();
  assert.deepEqual(server.codex(), { [`${MODEL}@10:00`]: 55, [`${MODEL}@10:30`]: 60, [`${UF}@10:30`]: 40 });
  assert.equal(server.total(), 155);
});
