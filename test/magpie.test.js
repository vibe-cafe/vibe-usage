import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseOmp } from '../src/parsers/omp.js';
import { parse as parsePi } from '../src/parsers/pi-coding-agent.js';

function fixture(t, records, messages) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-magpie-'));
  const names = ['VIBE_USAGE_OMP_SESSION_DIRS', 'VIBE_USAGE_PI_SESSION_DIRS', 'VIBE_USAGE_MAGPIE_USAGE_FILE', 'VIBE_USAGE_MAGPIE_OTHERS_DIR', 'XDG_CONFIG_HOME', 'VIBE_USAGE_CINDY_DIRS'];
  const previous = names.map(name => [name, process.env[name]]);
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const sessions = join(root, 'sessions');
  mkdirSync(sessions);
  process.env.VIBE_USAGE_OMP_SESSION_DIRS = sessions;
  process.env.VIBE_USAGE_PI_SESSION_DIRS = sessions;
  process.env.VIBE_USAGE_CINDY_DIRS = join(root, 'no-cindy');
  process.env.VIBE_USAGE_MAGPIE_USAGE_FILE = join(root, 'usage.jsonl');
  process.env.VIBE_USAGE_MAGPIE_OTHERS_DIR = join(root, 'usage-others');
  process.env.XDG_CONFIG_HOME = join(root, 'xdg');
  writeFileSync(process.env.VIBE_USAGE_MAGPIE_USAGE_FILE, records.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(sessions, 'session.jsonl'), [
    { type: 'session', id: 'session-1', cwd: '/work/example', timestamp: '2026-11-04T00:00:00Z' },
    { type: 'message', id: 'user-1', timestamp: '2026-11-04T00:01:00Z', message: { role: 'user', content: [] } },
    ...messages.map((message, i) => ({ type: 'message', id: `assistant-${i}`, timestamp: '2026-11-04T00:01:05Z', message })),
  ].map(JSON.stringify).join('\n') + '\n');
  return root;
}

function history(directory, name, calls) {
  const device = join(directory, 'synthetic-device');
  mkdirSync(device, { recursive: true });
  writeFileSync(join(device, name), JSON.stringify({ calls }));
}

const usage = { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, reasoning: 4 };
const message = (responseId, extra = {}) => ({ role: 'assistant', provider: 'magpie', model: 'group/pi', responseId, usage, ...extra });
const ledger = (response_id, extra = {}) => ({ response_id, req: 'group/pi', model: 'gpt-6-astra', in: 100, out: 20, cache_read: 30, cache_write: 10, status: 200, ...extra });

test('Pi and OMP attribute Magpie responses to actual models without changing token or session accounting', async t => {
  fixture(t, [ledger('response-1')], [message('response-1')]);
  for (const parse of [parseOmp, parsePi]) {
    const result = await parse();
    assert.deepEqual(result.buckets.map(b => ({ model: b.model, input: b.inputTokens, output: b.outputTokens, cached: b.cachedInputTokens, reasoning: b.reasoningOutputTokens })), [
      { model: 'gpt-6-astra', input: 110, output: 16, cached: 30, reasoning: 4 },
    ]);
    assert.equal(result.sessions[0].messageCount, 2);
    assert.deepEqual(result.info.magpie, { resolved: 1, unresolved: 0 });
  }
});

test('missing, conflicting, failed and token-mismatched responses remain grouped; unrelated providers stay unchanged', async t => {
  fixture(t, [
    ledger('good'), ledger('good'),
    ledger('conflict'), ledger('conflict', { model: 'claude-opus-5-5' }),
    ledger('mismatch', { in: 101 }),
    ledger('failed', { status: 500 }),
    ledger('wrong-group', { req: 'group/other' }),
    ledger('unrelated'),
  ], ['good', 'missing', 'conflict', 'mismatch', 'failed', 'wrong-group'].map(id => message(id)).concat([
    message('unrelated', { provider: 'another-proxy' }),
    message('good', { model: 'explicit-model' }),
  ]));
  const result = await parseOmp();
  assert.deepEqual(Object.fromEntries(result.buckets.map(b => [b.model, b.inputTokens])), {
    'gpt-6-astra': 110, 'group/pi': 660, 'explicit-model': 110,
  });
  assert.deepEqual(result.info.magpie, { resolved: 1, unresolved: 5 });
});

test('failed and unrelated records without accounting do not invalidate successful routing', async t => {
  fixture(t, [
    ledger('good'),
    { req: 'group/pi', response_id: 'failed', status: 503 },
    { req: 'unrelated-model', status: 200 },
  ], [message('good'), message('failed')]);
  for (const parse of [parseOmp, parsePi]) {
    const result = await parse();
    assert.deepEqual(result.info.magpie, { resolved: 1, unresolved: 1 });
    assert.deepEqual(result.warnings || [], []);
  }
});

test('an unfinished trailing append leaves complete routing records usable until the next parse', async t => {
  fixture(t, [], [message('complete'), message('appending')]);
  const complete = JSON.stringify(ledger('complete')) + '\n';
  const appending = JSON.stringify(ledger('appending'));
  writeFileSync(process.env.VIBE_USAGE_MAGPIE_USAGE_FILE, complete + appending.slice(0, -10));
  for (const parse of [parseOmp, parsePi]) {
    const result = await parse();
    assert.deepEqual(result.info.magpie, { resolved: 1, unresolved: 1 });
    assert.deepEqual(result.warnings || [], []);
  }
  writeFileSync(process.env.VIBE_USAGE_MAGPIE_USAGE_FILE, complete + appending + '\n');
  for (const parse of [parseOmp, parsePi]) {
    assert.deepEqual((await parse()).info.magpie, { resolved: 2, unresolved: 0 });
  }
});

test('legacy daily JSON restores models with an absent or empty live ledger', async t => {
  fixture(t, [], [message('archived')]);
  history(process.env.VIBE_USAGE_MAGPIE_OTHERS_DIR, '2026-11-03.json', [ledger('archived')]);
  for (const missing of [false, true]) {
    if (missing) rmSync(process.env.VIBE_USAGE_MAGPIE_USAGE_FILE);
    for (const parse of [parseOmp, parsePi]) {
      const result = await parse();
      assert.equal(result.buckets[0].model, 'gpt-6-astra');
      assert.deepEqual(result.info.magpie, { resolved: 1, unresolved: 0 });
      assert.deepEqual(result.warnings || [], []);
    }
  }
});

test('live and legacy copies agree once and conflicting models remain grouped', async t => {
  fixture(t, [ledger('copy'), ledger('conflict'), ledger('history-conflict')], [message('copy'), message('conflict'), message('history-conflict')]);
  history(process.env.VIBE_USAGE_MAGPIE_OTHERS_DIR, '2026-11-02.json', [
    ledger('copy'), ledger('conflict', { model: 'claude-opus-5-5' }), ledger('history-conflict'),
  ]);
  history(process.env.VIBE_USAGE_MAGPIE_OTHERS_DIR, '2026-11-03.json', [
    ledger('copy'), ledger('history-conflict', { model: 'claude-opus-5-5' }), ledger('history-conflict'),
  ]);
  for (const parse of [parseOmp, parsePi]) {
    const result = await parse();
    assert.deepEqual(result.info.magpie, { resolved: 1, unresolved: 2 });
    assert.deepEqual(Object.fromEntries(result.buckets.map(b => [b.model, b.inputTokens])), {
      'gpt-6-astra': 110, 'group/pi': 220,
    });
  }
});

test('matching requires every accounting dimension and successful status', async t => {
  fixture(t, [
    ledger('input', { in: 101 }), ledger('output', { out: 21 }),
    ledger('read', { cache_read: 31 }), ledger('write', { cache_write: 11 }),
    ledger('request', { req: 'group/other' }), ledger('failed', { status: 400 }),
    ledger('other-response'),
  ], ['input', 'output', 'read', 'write', 'request', 'failed', 'missing-response'].map(id => message(id)));
  for (const parse of [parseOmp, parsePi]) {
    const result = await parse();
    assert.deepEqual(result.info.magpie, { resolved: 0, unresolved: 7 });
    assert.equal(result.buckets[0].model, 'group/pi');
  }
});

test('served supplies the model only when the explicit model is absent', async t => {
  fixture(t, [
    ledger('explicit', { served: 'claude-opus-5-5' }),
    ledger('served', { model: undefined, served: 'claude-opus-5-5' }),
    ledger('null', { model: null, served: 'claude-opus-5-5' }),
    ledger('group', { model: 'group/pi', served: 'claude-opus-5-5' }),
    ledger('blank', { model: '', served: 'claude-opus-5-5' }),
  ], ['explicit', 'served', 'null', 'group', 'blank'].map(id => message(id)));
  for (const parse of [parseOmp, parsePi]) {
    const result = await parse();
    assert.deepEqual(Object.fromEntries(result.buckets.map(b => [b.model, b.inputTokens])), {
      'gpt-6-astra': 110, 'claude-opus-5-5': 220, 'group/pi': 220,
    });
  }
});

test('malformed live data cannot contribute a partial model decision and valid history survives', async t => {
  fixture(t, [ledger('partial'), 'invalid synthetic secret'], [message('partial'), message('archived')]);
  history(process.env.VIBE_USAGE_MAGPIE_OTHERS_DIR, 'good.json', [ledger('archived')]);
  for (const parse of [parseOmp, parsePi]) {
    const result = await parse();
    assert.deepEqual(result.info.magpie, { resolved: 1, unresolved: 1 });
    assert.equal(result.warnings.length, 1);
    assert.ok(!result.warnings.join('').includes('synthetic secret'));
  }
  rmSync(process.env.VIBE_USAGE_MAGPIE_USAGE_FILE);
  mkdirSync(process.env.VIBE_USAGE_MAGPIE_USAGE_FILE);
  for (const parse of [parseOmp, parsePi]) {
    const result = await parse();
    assert.deepEqual(result.info.magpie, { resolved: 1, unresolved: 1 });
    assert.equal(result.warnings.length, 1);
  }
});

test('legacy failures warn once without exposing paths or using partial files', async t => {
  fixture(t, [ledger('live')], [message('live'), message('partial'), message('archived')]);
  const directory = process.env.VIBE_USAGE_MAGPIE_OTHERS_DIR;
  history(directory, 'good.json', [ledger('archived')]);
  history(directory, 'partial.json', [ledger('partial'), ledger('bad', { in: '100' })]);
  const device = join(directory, 'synthetic-device');
  writeFileSync(join(device, 'synthetic-secret.json'), '{');
  mkdirSync(join(device, 'unreadable.json'));
  for (const parse of [parseOmp, parsePi]) {
    const result = await parse();
    assert.deepEqual(result.info.magpie, { resolved: 2, unresolved: 1 });
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes('3'));
    assert.ok(!result.warnings[0].includes('synthetic-secret'));
    assert.ok(!result.warnings[0].includes(directory));
  }
});

test('malformed counters cannot match through numeric coercion or clamping', async t => {
  fixture(t, [], [message('bad', { usage: { ...usage, input: 0 } })]);
  for (const invalid of [-1, '0', null, undefined, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    writeFileSync(process.env.VIBE_USAGE_MAGPIE_USAGE_FILE, JSON.stringify(ledger('bad', { in: invalid })) + '\n');
    for (const parse of [parseOmp, parsePi]) {
      const result = await parse();
      assert.equal(result.buckets[0].model, 'group/pi');
      assert.deepEqual(result.info.magpie, { resolved: 0, unresolved: 1 });
    }
  }
});

test('explicit live and history overrides isolate configured machine defaults even when absent', async t => {
  const root = fixture(t, [], [message('default')]);
  const defaults = join(process.env.XDG_CONFIG_HOME, 'magpie');
  mkdirSync(defaults, { recursive: true });
  writeFileSync(join(defaults, 'usage.jsonl'), JSON.stringify(ledger('default')) + '\n');
  history(join(defaults, 'usage-others'), 'default.json', [ledger('default')]);
  rmSync(process.env.VIBE_USAGE_MAGPIE_USAGE_FILE);
  for (const parse of [parseOmp, parsePi]) {
    assert.equal((await parse()).buckets[0].model, 'group/pi');
  }
  // Without a history override, history follows the selected live file's directory.
  delete process.env.VIBE_USAGE_MAGPIE_OTHERS_DIR;
  history(join(root, 'usage-others'), 'selected.json', [ledger('default', { model: 'selected-history' })]);
  for (const parse of [parseOmp, parsePi]) {
    assert.equal((await parse()).buckets[0].model, 'selected-history');
  }
  // A missing explicit history directory also suppresses adjacent history.
  process.env.VIBE_USAGE_MAGPIE_OTHERS_DIR = join(root, 'missing-history');
  for (const parse of [parseOmp, parsePi]) {
    assert.equal((await parse()).buckets[0].model, 'group/pi');
  }
});

test('XDG config selects the live ledger and adjacent legacy history', async t => {
  fixture(t, [], [message('live'), message('archived')]);
  delete process.env.VIBE_USAGE_MAGPIE_USAGE_FILE;
  delete process.env.VIBE_USAGE_MAGPIE_OTHERS_DIR;
  const directory = join(process.env.XDG_CONFIG_HOME, 'magpie');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'usage.jsonl'), JSON.stringify(ledger('live')) + '\n');
  history(join(directory, 'usage-others'), 'day.json', [ledger('archived')]);
  for (const parse of [parseOmp, parsePi]) {
    const result = await parse();
    assert.deepEqual(result.info.magpie, { resolved: 2, unresolved: 0 });
    assert.equal(result.buckets[0].inputTokens, 220);
  }
});

test('missing ledger preserves grouping and a subsequent parse reads newly available responses', async t => {
  fixture(t, [], [message('later')]);
  rmSync(process.env.VIBE_USAGE_MAGPIE_USAGE_FILE);
  const before = await parseOmp();
  assert.equal(before.buckets[0].model, 'group/pi');
  assert.deepEqual(before.info.magpie, { resolved: 0, unresolved: 1 });
  writeFileSync(process.env.VIBE_USAGE_MAGPIE_USAGE_FILE, JSON.stringify(ledger('later')) + '\n');
  const after = await parseOmp();
  assert.equal(after.buckets[0].model, 'gpt-6-astra');
  assert.equal(after.buckets[0].inputTokens, before.buckets[0].inputTokens);
});

test('a broken Magpie store warns without losing session accounting', async t => {
  fixture(t, [], [message('unavailable')]);
  rmSync(process.env.VIBE_USAGE_MAGPIE_USAGE_FILE);
  mkdirSync(process.env.VIBE_USAGE_MAGPIE_USAGE_FILE);
  const result = await parseOmp();
  assert.equal(result.buckets[0].model, 'group/pi');
  assert.equal(result.buckets[0].inputTokens, 110);
  assert.ok(result.warnings.some(w => w.includes('Magpie')));
});

test('sync uploads actual Magpie models from real Pi/OMP session files and remains incremental', async t => {
  const root = fixture(t, [ledger('response-1')], [message('response-1')]);
  const config = join(root, 'config');
  mkdirSync(config);
  const received = [];
  const server = createServer((req, res) => {
    if (req.url === '/api/usage/settings') {
      res.end(JSON.stringify({ uploadProject: false }));
      return;
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const payload = JSON.parse(gunzipSync(Buffer.concat(chunks)));
      received.push(payload);
      res.end(JSON.stringify({ ingested: payload.buckets.length, sessions: payload.sessions?.length || 0 }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  writeFileSync(join(config, 'config.json'), JSON.stringify({
    apiKey: 'vbu_synthetic_magpie', apiUrl: `http://127.0.0.1:${server.address().port}`, hostname: 'test-host',
  }));
  const command = `
    import { parsers } from './src/parsers/index.js';
    for (const source of Object.keys(parsers)) {
      if (!['omp', 'pi-coding-agent'].includes(source)) delete parsers[source];
    }
    const { run } = await import('./src/index.js');
    await run(['sync']);
  `;
  const env = { ...process.env, VIBE_USAGE_DEV: '0', VIBE_USAGE_CONFIG_DIR: config, VIBE_USAGE_STATE_DIR: config };
  const exec = promisify(execFile);
  await exec(process.execPath, ['--input-type=module', '-e', command], { env, cwd: process.cwd() });
  const buckets = received.flatMap(p => p.buckets);
  assert.deepEqual(buckets.map(b => [b.source, b.model, b.inputTokens, b.outputTokens, b.cachedInputTokens, b.reasoningOutputTokens]).sort(), [
    ['omp', 'gpt-6-astra', 110, 16, 30, 4], ['pi-coding-agent', 'gpt-6-astra', 110, 16, 30, 4],
  ]);
  assert.ok(buckets.every(b => b.project === 'unknown'));
  const uploads = received.length;
  await exec(process.execPath, ['--input-type=module', '-e', command], { env, cwd: process.cwd() });
  assert.equal(received.length, uploads, 'unchanged usage must not upload twice');
});
