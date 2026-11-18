// An older collector and this one, alternating over rollouts that keep growing,
// each with a bounded work budget.
//
// A daemon started before an upgrade keeps running the old parser until it is
// restarted, while a desktop app already runs the new one, and both keep their
// Codex parse state under the same cache directory. If they share cache files,
// each overwrites the other's summary and append tail for every rollout that
// grew in between, so both read those rollouts from the first byte on every
// run. With a few long sessions open, a run then never fits its work budget:
// it returns `skipped` every time and Codex stops uploading (the 0.14.8
// incident). This test drives exactly that loop and requires the new collector
// to finish and then stay cheap.
//
// Time is simulated: reading a whole rollout costs FULL_READ_MS on a fake
// clock, proportionally less for a partial read, so the budget is exhausted
// deterministically. The older collector is emulated by what it leaves on disk
// after a run -- algorithm-6 summaries and tails for the current file states,
// at the paths versions up to 6 use -- which is all the new collector can see
// of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from '../src/parsers/codex.js';
import { MODEL, ULTRAFAST_TIER_VALUE, sessionMeta, turnContext } from './fixtures/codex-ultrafast/rollout.js';

const FULL_READ_MS = 20_000;
const BUDGET_MS = 45_000;
const ACTIVE = ['rollout-a.jsonl', 'rollout-b.jsonl', 'rollout-c.jsonl'];
const IDLE = 'rollout-idle.jsonl';

// ------------------------------------------------------------ simulated time ---
const realCreateReadStream = fs.createReadStream;
const realNow = Date.now;
const clock = { now: realNow(), charging: false };
fs.createReadStream = (path, options) => {
  const stream = realCreateReadStream(path, options);
  if (clock.charging && String(path).endsWith('.jsonl')) {
    const size = statSync(path).size;
    stream.on('data', (chunk) => { clock.now += (Buffer.byteLength(chunk) / size) * FULL_READ_MS; });
  }
  return stream;
};
syncBuiltinESMExports();
Date.now = () => clock.now;

const savedEnv = {};
for (const key of ['CODEX_HOME', 'VIBE_USAGE_CACHE_DIR', 'VIBE_USAGE_CODEX_CACHE', 'VIBE_USAGE_CODEX_WORK_BUDGET_MS', 'VIBE_USAGE_CINDY_DIRS']) {
  savedEnv[key] = process.env[key];
}
const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codex-coexistence-'));
test.after(() => {
  fs.createReadStream = realCreateReadStream;
  syncBuiltinESMExports();
  Date.now = realNow;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------------ fixtures ---
const sessionsDir = join(root, 'sessions', '2026', '11', '10');
const sharedCache = join(root, 'cache');
mkdirSync(sessionsDir, { recursive: true });
process.env.CODEX_HOME = root;
process.env.VIBE_USAGE_CINDY_DIRS = join(root, 'absent');

const totals = {};
/** `count` model calls of 10 tokens each, padded so a rollout spans many read chunks. */
function calls(name, count) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    const n = (totals[name] = (totals[name] || 0) + 1);
    const timestamp = new Date(Date.parse('2026-11-10T10:00:00.000Z') + n * 1000).toISOString();
    lines.push(JSON.stringify({
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        pad: 'x'.repeat(900),
        info: {
          total_token_usage: { total_tokens: n * 10 },
          last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 10 },
        },
      },
    }));
  }
  return `${lines.join('\n')}\n`;
}
function seed(name, serviceTier) {
  const t = '2026-11-10T10:00:00.000Z';
  writeFileSync(join(sessionsDir, name), `${[
    sessionMeta(t, name),
    turnContext(t, { model: MODEL, serviceTier }),
  ].map(JSON.stringify).join('\n')}\n${calls(name, 1000)}`);
}
const grow = () => { for (const name of ACTIVE) appendFileSync(join(sessionsDir, name), calls(name, 40)); };

async function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** One run of the new collector on the shared cache, with the clock running. */
async function newCollectorRun() {
  const startedAt = clock.now;
  clock.charging = true;
  try {
    const result = await withEnv(
      { VIBE_USAGE_CACHE_DIR: sharedCache, VIBE_USAGE_CODEX_WORK_BUDGET_MS: String(BUDGET_MS) },
      () => parse(),
    );
    return { result, elapsedMs: clock.now - startedAt };
  } finally {
    clock.charging = false;
  }
}
const uncached = () => withEnv({ VIBE_USAGE_CODEX_CACHE: '0', VIBE_USAGE_CACHE_DIR: join(root, 'unused') }, () => parse());

// What an algorithm-6 collector stored: Ultrafast folded into the plain model,
// the tier forgotten, version 6.
function asAlgorithm6(data) {
  const fold = (owner) => {
    const merged = new Map();
    for (const bucket of [...(owner.buckets || []), ...(owner.ultrafastBuckets || [])]) {
      const key = `${bucket.model}|${bucket.project}|${bucket.bucketStart}`;
      const sum = merged.get(key);
      if (!sum) { merged.set(key, { ...bucket }); continue; }
      for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'totalTokens']) {
        sum[field] = (sum[field] || 0) + (bucket[field] || 0);
      }
    }
    owner.buckets = [...merged.values()];
    delete owner.ultrafastBuckets;
  };
  data.algorithmVersion = 6;
  if (data.result) fold(data.result);
  if (data.tail) { fold(data.tail); if (data.tail.serviceTier === 'ultrafast') data.tail.serviceTier = null; }
  return `${JSON.stringify(data)}\n`;
}
function jsonFiles(dir) {
  const found = [];
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...jsonFiles(path));
    else if (entry.name.endsWith('.json')) found.push(path);
  }
  return found;
}
/** The per-home directory versions up to 6 keep their files in (`cache/codex/root-<hash>`). */
function olderDir(cacheDir) {
  const codexDir = join(cacheDir, 'codex');
  const [home] = existsSync(codexDir) ? readdirSync(codexDir).filter(name => name.startsWith('root-')) : [];
  return home ? join(codexDir, home) : null;
}
let scratchRun = 0;
/** Leave the cache as an algorithm-6 collector does after a complete run over the current files. */
async function olderCollectorRun() {
  const scratch = join(root, `older-scratch-${++scratchRun}`);
  await withEnv({ VIBE_USAGE_CACHE_DIR: scratch, VIBE_USAGE_CODEX_WORK_BUDGET_MS: String(3_600_000) }, () => parse());
  const target = olderDir(sharedCache) || join(sharedCache, 'codex', basename(olderDir(scratch)));
  mkdirSync(target, { recursive: true });
  for (const path of jsonFiles(scratch)) {
    writeFileSync(join(target, basename(path)), asAlgorithm6(JSON.parse(readFileSync(path, 'utf8'))));
  }
  rmSync(scratch, { recursive: true, force: true });
}
/** Content of every file directly in the older collector's directory. */
function olderFiles() {
  const dir = olderDir(sharedCache);
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => [entry.name, readFileSync(join(dir, entry.name), 'utf8')]));
}
const tokens = result => result.buckets.reduce((sum, b) => sum + b.inputTokens + b.outputTokens, 0);

// ------------------------------------------------------------------ scenario ---
test('alternating with an older collector over growing rollouts: the new one finishes and then stays cheap', async () => {
  seed(ACTIVE[0], null);
  seed(ACTIVE[1], ULTRAFAST_TIER_VALUE);
  seed(ACTIVE[2], 'fast');
  seed(IDLE, null);
  // The machine was on the older version: its cache is complete.
  await olderCollectorRun();

  const runs = [];
  for (let round = 1; round <= 5; round++) {
    grow();
    await olderCollectorRun();
    grow(); // the rollouts move on between the two collectors' runs
    const before = olderFiles();
    const run = await newCollectorRun();
    // The older collector's summaries and tails are exactly as it left them.
    assert.deepEqual(olderFiles(), before, `round ${round}: the older collector's files were rewritten`);
    runs.push({
      round,
      done: !run.result.skipped,
      elapsedMs: Math.round(run.elapsedMs),
      tailHits: run.result.cache?.tailHits,
      indexing: run.result.indexing ? `${run.result.indexing.phase} ${run.result.indexing.completed}/${run.result.indexing.total}` : null,
    });
  }
  const trace = JSON.stringify(runs);

  // Three rollouts changed and each costs 20s to read whole: the first run
  // cannot fit a 45s budget, which is the situation being tested.
  assert.equal(runs[0].done, false, trace);
  // It must not stay that way: what a run read is kept, so the work is finished
  // within three runs although every rollout kept growing in between ...
  const firstDone = runs.findIndex(run => run.done);
  assert.ok(firstDone !== -1 && firstDone <= 2, `never finished: ${trace}`);
  // ... and from then on every run only reads what was appended.
  for (const run of runs.slice(firstDone + 1)) {
    assert.equal(run.done, true, trace);
    assert.equal(run.tailHits, ACTIVE.length, trace);
    assert.ok(run.elapsedMs < FULL_READ_MS, `a steady-state run re-read a rollout from the start: ${trace}`);
  }

  // The finished result is exactly what the logs say.
  const final = await newCollectorRun();
  const expected = await uncached();
  assert.equal(final.result.skipped, undefined);
  const sorted = result => [...result.buckets].sort((a, b) => `${a.model}|${a.bucketStart}`.localeCompare(`${b.model}|${b.bucketStart}`));
  assert.deepEqual(sorted(final.result), sorted(expected));
  assert.deepEqual(final.result.sessions.length, expected.sessions.length);
  assert.equal(tokens(final.result), (4 * 1000 + 3 * 40 * 10) * 10);
});
