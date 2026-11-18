// An older collector and this one, alternating over rollouts that keep growing,
// each with a bounded work budget.
//
// A daemon started before an upgrade keeps running the old parser until it is
// restarted, and a desktop app that cannot reach npm runs its cached old CLI,
// while another collector on the machine is already the new version. Both keep
// their Codex parse state under the same cache directory. Two ways this went
// wrong, both ending with the new collector reading every growing rollout from
// the first byte on every run, never fitting its work budget, returning
// `skipped` forever and Codex not uploading (the 0.14.8 incident):
//
//   - shared files: each version overwrote the other's summary and append tail;
//   - shadowing: the older collector refreshes its summary after every append,
//     so it nearly always has one for the current file state; looked up first,
//     it hid the new collector's own append tail, and on a machine with an
//     Ultrafast cut that summary is then unusable (post-cut windows).
//
// The matrix below drives that loop in every combination of: cut registered or
// not, which collector runs first after an append, and whether the rollouts
// grow again between the two runs. Three more situations run through the same
// orders: the cut only gets registered in the second round (summaries taken
// over from the older collector stop being usable mid-way), a rollout is
// archived between the two runs (its path, and with it every cache key,
// changes), and a session keeps switching between the standard tier and
// Ultrafast (the tier has to survive in the append tail). In all of them the
// new collector has to finish within three runs of the last such change and
// from then on only read what was appended.
//
// Time is simulated: reading a whole rollout costs FULL_READ_MS on a fake
// clock, proportionally less for a partial read, so the budget is exhausted
// deterministically.
//
// The older collector is, by default, emulated by what it leaves on disk after
// a complete run -- algorithm-6 summaries and tails for the current file
// states, at the paths versions up to 6 use -- which is all the new collector
// can see of it. Set VIBE_USAGE_OLDER_CHECKOUT to a checkout of a release
// before algorithm 7 (0.14.12 or earlier) to run that release's real parser
// instead, on the same clock and budget; the test then also requires the older
// collector to keep resuming from its own tails.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parse } from '../src/parsers/codex.js';
import { MODEL, ULTRAFAST_TIER_VALUE, sessionMeta, turnContext } from './fixtures/codex-ultrafast/rollout.js';

const FULL_READ_MS = 20_000;
const BUDGET_MS = 45_000;
const ROUNDS = 8;
const ACTIVE = ['rollout-a.jsonl', 'rollout-b.jsonl', 'rollout-c.jsonl'];
const IDLE = 'rollout-idle.jsonl';
const SWITCHING = ACTIVE[0]; // the session that changes tier, in the tier-switching variant
const ARCHIVED = ACTIVE[2]; // the session that gets archived, in the archive variant
// Every fixture record is after this instant, so with it registered as the cut
// no algorithm-6 summary of these rollouts is usable.
const CUT = '2026-11-10T10:00:00.000Z';

const olderCheckout = process.env.VIBE_USAGE_OLDER_CHECKOUT?.trim();
const olderParse = olderCheckout
  ? (await import(pathToFileURL(join(olderCheckout, 'src', 'parsers', 'codex.js')).href)).parse
  : null;

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

const ENV_KEYS = ['CODEX_HOME', 'VIBE_USAGE_CACHE_DIR', 'VIBE_USAGE_CODEX_CACHE', 'VIBE_USAGE_CODEX_WORK_BUDGET_MS', 'VIBE_USAGE_CINDY_DIRS'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const roots = [];
test.after(() => {
  fs.createReadStream = realCreateReadStream;
  syncBuiltinESMExports();
  Date.now = realNow;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

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
const sorted = result => [...result.buckets].sort((a, b) => `${a.model}|${a.bucketStart}`.localeCompare(`${b.model}|${b.bucketStart}`));

/** One machine: four rollouts, a cache shared by both collectors. */
function createMachine({ switching = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codex-coexistence-'));
  roots.push(root);
  const sessionsDir = join(root, 'sessions', '2026', '11', '10');
  const sharedCache = join(root, 'cache');
  mkdirSync(sessionsDir, { recursive: true });
  const base = { CODEX_HOME: root, VIBE_USAGE_CINDY_DIRS: join(root, 'absent'), VIBE_USAGE_CODEX_CACHE: undefined };
  const totals = {};
  const tierInForce = {};
  const location = {}; // rollout name -> its current directory
  let ultrafastCalls = 0;
  let scratchRuns = 0;
  const instant = name => new Date(Date.parse(CUT) + (totals[name] || 0) * 1000 + 500).toISOString();

  /** `count` model calls of 10 tokens each, padded so a rollout spans many read chunks. */
  function calls(name, count) {
    const lines = [];
    for (let i = 0; i < count; i++) {
      const n = (totals[name] = (totals[name] || 0) + 1);
      if (tierInForce[name] === ULTRAFAST_TIER_VALUE) ultrafastCalls++;
      lines.push(JSON.stringify({
        timestamp: new Date(Date.parse(CUT) + n * 1000).toISOString(),
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
    tierInForce[name] = serviceTier;
    location[name] = sessionsDir;
    writeFileSync(join(sessionsDir, name), `${[
      sessionMeta(CUT, name),
      turnContext(CUT, { model: MODEL, serviceTier }),
    ].map(JSON.stringify).join('\n')}\n${calls(name, 1000)}`);
  }
  /**
   * 40 more calls. In the switching session the first 10 are still served at
   * the tier the previous append ended in -- only the append tail knows it --
   * then the tier flips for the remaining 30.
   */
  function appended(name) {
    if (!switching || name !== SWITCHING) return calls(name, 40);
    const head = calls(name, 10);
    tierInForce[name] = tierInForce[name] === ULTRAFAST_TIER_VALUE ? null : ULTRAFAST_TIER_VALUE;
    const flip = JSON.stringify(turnContext(instant(name), { model: MODEL, serviceTier: tierInForce[name] }));
    return `${head}${flip}\n${calls(name, 30)}`;
  }
  seed(ACTIVE[0], null);
  seed(ACTIVE[1], ULTRAFAST_TIER_VALUE);
  seed(ACTIVE[2], 'fast');
  seed(IDLE, null);

  async function timed(env, run) {
    const startedAt = clock.now;
    clock.charging = true;
    try {
      const result = await withEnv({ ...base, ...env }, run);
      return {
        result,
        done: !result.skipped,
        elapsedMs: Math.round(clock.now - startedAt),
        tailHits: result.cache?.tailHits,
        filesRead: result.cache?.filesRead,
        indexing: result.indexing ? `${result.indexing.phase} ${result.indexing.completed}/${result.indexing.total}` : null,
      };
    } finally {
      clock.charging = false;
    }
  }
  const shared = { VIBE_USAGE_CACHE_DIR: sharedCache, VIBE_USAGE_CODEX_WORK_BUDGET_MS: String(BUDGET_MS) };

  const growing = () => ACTIVE.filter(name => location[name] === sessionsDir);
  return {
    grow() { for (const name of growing()) appendFileSync(join(sessionsDir, name), appended(name)); },
    /** How many rollouts are still being appended to. */
    growingCount: () => growing().length,
    /** Codex archives a finished session by moving its rollout; it does not grow afterwards. */
    archive(name) {
      const archivedDir = join(root, 'archived_sessions');
      mkdirSync(archivedDir, { recursive: true });
      renameSync(join(sessionsDir, name), join(archivedDir, name));
      location[name] = archivedDir;
    },
    tokens: () => Object.values(totals).reduce((sum, n) => sum + n, 0) * 10,
    ultrafastTokens: () => ultrafastCalls * 10,
    /** One run of this version on the shared cache, clock running, budget applied. */
    newRun: cut => timed(shared, () => parse({ codexUltrafastStartAt: cut })),
    uncached: cut => withEnv({ ...base, VIBE_USAGE_CODEX_CACHE: '0', VIBE_USAGE_CACHE_DIR: join(root, 'unused') },
      () => parse({ codexUltrafastStartAt: cut })),
    /**
     * One run of the older collector. With a real older checkout: its parser,
     * same clock and budget (`unlimited` for the state the machine starts in).
     * Otherwise: leave the cache as an algorithm-6 collector does after a
     * complete run over the current files.
     */
    async olderRun({ unlimited = false } = {}) {
      if (olderParse) {
        return timed(unlimited ? { ...shared, VIBE_USAGE_CODEX_WORK_BUDGET_MS: String(3_600_000) } : shared, () => olderParse());
      }
      const scratch = join(root, `older-scratch-${++scratchRuns}`);
      await withEnv({ ...base, VIBE_USAGE_CACHE_DIR: scratch, VIBE_USAGE_CODEX_WORK_BUDGET_MS: String(3_600_000) }, () => parse());
      const target = olderDir(sharedCache) || join(sharedCache, 'codex', basename(olderDir(scratch)));
      mkdirSync(target, { recursive: true });
      for (const path of jsonFiles(scratch)) {
        writeFileSync(join(target, basename(path)), asAlgorithm6(JSON.parse(readFileSync(path, 'utf8'))));
      }
      rmSync(scratch, { recursive: true, force: true });
      return null;
    },
    /** Content of every file directly in the older collector's directory. */
    olderFiles() {
      const dir = olderDir(sharedCache);
      return Object.fromEntries(readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => [entry.name, readFileSync(join(dir, entry.name), 'utf8')]));
    },
  };
}

const summary = run => ({ done: run.done, s: Math.round(run.elapsedMs / 1000), tails: run.tailHits, read: run.filesRead, at: run.indexing });

// ------------------------------------------------------------------- matrix ---
const ORDERS = ['older-first', 'new-first'];
const VARIANTS = [
  ...[null, CUT].map(cut => ({ label: cut ? 'cut registered' : 'no cut', cutAt: () => cut })),
  // No cut in round 1, registered from round 2 on.
  { label: 'cut registered in round 2', cutAt: round => (round >= 2 ? CUT : null), cutFromRound: 2 },
  { label: 'cut registered, a rollout archived between the two runs of round 2', cutAt: () => CUT, archiveInRound: 2 },
  { label: 'cut registered, a session switching between standard and Ultrafast', cutAt: () => CUT, switching: true },
];

for (const variant of VARIANTS) {
  for (const order of ORDERS) {
    for (const growsBetween of [false, true]) {
      const name = `${variant.label}, ${order === 'older-first' ? 'older collector first' : 'new collector first'}, `
        + `${growsBetween ? 'rollouts grow between the two runs' : 'no append between the two runs'}`;
      test(`${name}: the new collector finishes and then only reads appends`, async () => {
        const machine = createMachine({ switching: !!variant.switching });
        // The machine was on the older version: its cache is complete.
        await machine.olderRun({ unlimited: true });

        const newRuns = [];
        const olderRuns = [];
        let archivedJustNow = false;
        const runNew = async (round) => {
          const before = machine.olderFiles();
          const run = await machine.newRun(variant.cutAt(round));
          assert.deepEqual(machine.olderFiles(), before, `round ${round}: the older collector's files were rewritten`);
          newRuns.push({ ...run, growing: machine.growingCount() });
        };
        const runOlder = async () => {
          const run = await machine.olderRun();
          if (run) olderRuns.push({ ...run, growing: machine.growingCount(), afterArchive: archivedJustNow });
          archivedJustNow = false;
        };
        for (let round = 1; round <= ROUNDS; round++) {
          machine.grow();
          if (order === 'older-first') await runOlder(); else await runNew(round);
          if (variant.archiveInRound === round) { machine.archive(ARCHIVED); archivedJustNow = true; }
          if (growsBetween) machine.grow();
          if (order === 'older-first') await runNew(round); else await runOlder();
        }
        const trace = `new ${JSON.stringify(newRuns.map(summary))}${olderRuns.length ? ` | older ${JSON.stringify(olderRuns.map(summary))}` : ''}`;
        if (process.env.VIBE_USAGE_COEXISTENCE_TRACE) console.log(`TRACE ${name}: ${trace}`);

        // Only without a cut, right after the older collector, with nothing
        // appended since, can its summaries stand in. Everywhere else three
        // changed rollouts at 20s each cannot fit a 45s budget on the first run
        // -- which is what makes this a test of the loop at all.
        const startsCold = variant.cutAt(1) !== null || order === 'new-first' || growsBetween;
        if (startsCold) assert.equal(newRuns[0].done, false, trace);

        // The last run in which something other than an append changed under
        // the new collector: a newly registered cut, or a rollout that moved
        // (which it first sees in the next round when it ran before the move).
        const settlesFrom = Math.max(
          variant.cutFromRound ? variant.cutFromRound - 1 : 0,
          variant.archiveInRound ? variant.archiveInRound - (order === 'older-first' ? 1 : 0) : 0,
        );
        // It must not stay unfinished: what a run reads is kept, so the work is
        // done within three runs although the rollouts kept growing ...
        const offset = newRuns.slice(settlesFrom).findIndex(run => run.done);
        assert.ok(offset !== -1 && offset <= 2, `the new collector never finished: ${trace}`);
        // ... and from then on a run only reads what was appended (or nothing,
        // where an older summary for the unchanged file is exact).
        const steady = newRuns.slice(settlesFrom + offset + 1);
        assert.ok(steady.length >= 2, trace);
        for (const run of steady) {
          assert.equal(run.done, true, trace);
          assert.ok(run.elapsedMs < FULL_READ_MS, `a steady-state run read a rollout from the start: ${trace}`);
          assert.ok(run.tailHits === run.growing || run.filesRead === 0, trace);
        }
        // The older collector is not disturbed either: it keeps resuming. (The
        // run right after an archive reads the moved rollout once, like ours.)
        for (const run of olderRuns) {
          assert.equal(run.done, true, trace);
          assert.equal(run.tailHits, run.growing, trace);
          if (!run.afterArchive) assert.ok(run.elapsedMs < FULL_READ_MS, trace);
        }

        // The finished result is exactly what the logs say, for the cut in force.
        const cut = variant.cutAt(ROUNDS);
        const final = await machine.newRun(cut);
        const expected = await machine.uncached(cut);
        assert.equal(final.done, true);
        assert.deepEqual(sorted(final.result), sorted(expected));
        assert.deepEqual(final.result.sessions, expected.sessions);
        const tokens = buckets => buckets.reduce((sum, b) => sum + b.inputTokens + b.outputTokens, 0);
        assert.equal(tokens(final.result.buckets), machine.tokens());
        // Every fixture record is after the cut, so with a cut exactly the
        // calls made at the Ultrafast tier are split out, and without one none.
        assert.equal(
          tokens(final.result.buckets.filter(b => b.model.endsWith('-ultrafast'))),
          cut === null ? 0 : machine.ultrafastTokens(),
        );
      });
    }
  }
}

// ------------------------------- duplicate sessions across two Codex homes ---
// The same session id in two homes (two accounts of a multi-account launcher
// that share one history, a copied home added as an extra root) is read as one
// group. Its usage is stored once, on the group's entry; the entry of each
// physical file holds only that file's header and replay index and never gets
// a summary of its own.
//
// 0.15.0 took an older entry over only when it carried a summary. On such a
// machine the first runs after the upgrade therefore read every one of those
// files from the first byte for its header and again for its index, 45 seconds
// at a time -- about a dozen syncs with Codex `skipped` on a machine with 9,891
// such sessions -- although the group summaries those passes lead to were all
// still usable. Headers and indexes are computed by algorithm 7 exactly as by
// algorithm 6, so they are taken over as well.
const TWO_HOME_CUT = '2026-11-10T10:00:00.000Z';
const isGroupEntry = entry => entry.filePath.includes('/.vibe-usage-session-');

async function timedRun(env, run) {
  const startedAt = clock.now;
  clock.charging = true;
  try {
    const result = await withEnv(env, run);
    return {
      result,
      done: !result.skipped,
      elapsedMs: Math.round(clock.now - startedAt),
      filesRead: result.cache?.filesRead,
      indexing: result.indexing ? `${result.indexing.phase} ${result.indexing.completed}/${result.indexing.total}` : null,
    };
  } finally {
    clock.charging = false;
  }
}

/**
 * One machine, two homes. Four sessions exist in both (identical copies), one
 * only in the first. All usage is before the cut except the last 701 calls of
 * `late`, which are Ultrafast.
 */
function createTwoHomeMachine() {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codex-two-homes-'));
  roots.push(root);
  const homes = [join(root, 'home-a'), join(root, 'home-b')];
  const sharedCache = join(root, 'cache');
  const day = home => join(home, 'sessions', '2026', '11', '10');
  for (const home of homes) mkdirSync(day(home), { recursive: true });
  const base = { CODEX_HOME: homes[0], VIBE_USAGE_CINDY_DIRS: join(root, 'absent'), VIBE_USAGE_CODEX_CACHE: undefined };
  const shared = { ...base, VIBE_USAGE_CACHE_DIR: sharedCache, VIBE_USAGE_CODEX_WORK_BUDGET_MS: String(BUDGET_MS) };
  const unlimited = { VIBE_USAGE_CODEX_WORK_BUDGET_MS: String(3_600_000) };
  const options = cut => ({ extraRoots: [homes[1]], codexUltrafastStartAt: cut });
  let tokens = 0;
  let ultrafastTokensAfterCut = 0;

  /** 1,000 calls of 10 tokens, one per second, padded so the file spans many read chunks. */
  function rollout(id, serviceTier, startsAt) {
    const lines = [sessionMeta(startsAt, id), turnContext(startsAt, { model: MODEL, serviceTier })].map(JSON.stringify);
    for (let n = 1; n <= 1000; n++) {
      const at = Date.parse(startsAt) + n * 1000;
      tokens += 10;
      if (serviceTier === ULTRAFAST_TIER_VALUE && at >= Date.parse(TWO_HOME_CUT)) ultrafastTokensAfterCut += 10;
      lines.push(JSON.stringify({
        timestamp: new Date(at).toISOString(),
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
  const inBothHomes = [
    ['std', null, '2026-11-10T08:00:00.000Z'],
    ['uf', ULTRAFAST_TIER_VALUE, '2026-11-10T08:20:00.000Z'],
    ['fast', 'fast', '2026-11-10T08:40:00.000Z'],
    ['late', ULTRAFAST_TIER_VALUE, '2026-11-10T09:55:00.000Z'],
  ];
  for (const [id, serviceTier, startsAt] of inBothHomes) {
    const content = rollout(id, serviceTier, startsAt);
    for (const home of homes) writeFileSync(join(day(home), `rollout-${id}.jsonl`), content);
  }
  writeFileSync(join(day(homes[0]), 'rollout-solo.jsonl'), rollout('solo', null, '2026-11-10T09:00:00.000Z'));

  const olderDirs = () => readdirSync(join(sharedCache, 'codex')).map(home => join(sharedCache, 'codex', home));
  /** Every file directly in the older collector's directories: `{ path: content }`. */
  const olderFiles = () => Object.fromEntries(olderDirs().flatMap(dir => readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => [join(dir, entry.name), readFileSync(join(dir, entry.name), 'utf8')])));
  const olderSummaries = () => Object.entries(olderFiles())
    .filter(([path]) => !path.endsWith('.tail.json'))
    .map(([path, content]) => ({ path, entry: JSON.parse(content) }));

  return {
    physicalFiles: inBothHomes.length * 2 + 1,
    duplicateCopies: inBothHomes.length * 2,
    groups: inBothHomes.length,
    tokens: () => tokens,
    ultrafastTokensAfterCut: () => ultrafastTokensAfterCut,
    olderFiles,
    olderSummaries,
    /** The machine as the older version left it: a complete algorithm-6 cache. */
    async olderRun() {
      if (olderParse) {
        await withEnv({ ...shared, ...unlimited }, () => olderParse({ extraRoots: [homes[1]] }));
        return;
      }
      const scratch = join(root, 'older-scratch');
      await withEnv({ ...base, ...unlimited, VIBE_USAGE_CACHE_DIR: scratch }, () => parse({ extraRoots: [homes[1]] }));
      for (const home of readdirSync(join(scratch, 'codex'))) {
        const target = join(sharedCache, 'codex', home);
        mkdirSync(target, { recursive: true });
        for (const path of jsonFiles(join(scratch, 'codex', home))) {
          writeFileSync(join(target, basename(path)), asAlgorithm6(JSON.parse(readFileSync(path, 'utf8'))));
        }
      }
      rmSync(scratch, { recursive: true, force: true });
    },
    /** Restamp what the older version left as another algorithm version. */
    restampOlder(algorithmVersion) {
      for (const { path, entry } of olderSummaries()) writeFileSync(path, `${JSON.stringify({ ...entry, algorithmVersion })}\n`);
    },
    /**
     * What 0.15.0 left when its 45 seconds ran out during the header and index
     * passes: its own entry for every file it had to read -- the header for
     * each, the index for only some.
     */
    leaveHalfRebuilt() {
      let written = 0;
      for (const { path, entry } of olderSummaries()) {
        if (isGroupEntry(entry) || entry.result) continue;
        const ownDir = join(path, '..', 'v7');
        mkdirSync(ownDir, { recursive: true });
        writeFileSync(join(ownDir, basename(path)), `${JSON.stringify({
          ...entry, algorithmVersion: 7, index: written % 2 === 0 ? null : entry.index, result: null,
        })}\n`);
        written++;
      }
      return written;
    },
    newRun: cut => timedRun(shared, () => parse(options(cut))),
    uncached: cut => withEnv({ ...base, VIBE_USAGE_CODEX_CACHE: '0', VIBE_USAGE_CACHE_DIR: join(root, 'unused') },
      () => parse(options(cut))),
  };
}

/** The older cache has the shape this section is about. */
function assertOlderLayout(machine) {
  const summaries = machine.olderSummaries().map(({ entry }) => entry);
  const copies = summaries.filter(entry => !isGroupEntry(entry) && entry.header && entry.index && !entry.result);
  const groups = summaries.filter(entry => isGroupEntry(entry) && entry.index && entry.result);
  assert.equal(copies.length, machine.duplicateCopies, 'every physical copy has a header and an index, and no summary');
  assert.equal(groups.length, machine.groups, 'every duplicated session has its summary on the group entry');
  assert.ok(summaries.every(entry => entry.algorithmVersion === 6));
}

async function assertFinishesOnFirstRun(machine) {
  const before = machine.olderFiles();
  const first = await machine.newRun(TWO_HOME_CUT);
  const trace = JSON.stringify({ done: first.done, s: Math.round(first.elapsedMs / 1000), at: first.indexing, cache: first.result.cache });
  assert.equal(first.done, true, `the first run after the upgrade did not finish: ${trace}`);
  const cache = first.result.cache;
  // No header is read and no replay index is rebuilt from a rollout.
  assert.equal(cache.headerHits, machine.physicalFiles, trace);
  // Every physical copy, and the three groups whose summary is still exact.
  assert.equal(cache.indexHits, machine.duplicateCopies + (machine.groups - 1), trace);
  assert.equal(cache.resultHits, (machine.groups - 1) + 1, trace);
  // The one session with usage after the cut is the only thing read: its two
  // copies, merged once.
  assert.equal(cache.filesRead, 2, trace);
  assert.equal(first.elapsedMs, 2 * FULL_READ_MS, trace);
  assert.deepEqual(machine.olderFiles(), before, 'the older collector\'s files were rewritten');

  const expected = await machine.uncached(TWO_HOME_CUT);
  assert.deepEqual(sorted(first.result), sorted(expected));
  assert.deepEqual(first.result.sessions, expected.sessions);
  const sum = buckets => buckets.reduce((total, b) => total + b.inputTokens + b.outputTokens, 0);
  assert.equal(sum(first.result.buckets), machine.tokens());
  assert.equal(machine.ultrafastTokensAfterCut(), 7010);
  assert.equal(sum(first.result.buckets.filter(b => b.model.endsWith('-ultrafast'))), machine.ultrafastTokensAfterCut());

  const second = await machine.newRun(TWO_HOME_CUT);
  assert.equal(second.done, true);
  assert.equal(second.filesRead, 0);
  assert.equal(second.elapsedMs, 0);
  assert.deepEqual(sorted(second.result), sorted(expected));
}

test('duplicate sessions in two homes: the first run after the upgrade takes headers and indexes from the older entries', async () => {
  const machine = createTwoHomeMachine();
  await machine.olderRun();
  assertOlderLayout(machine);
  await assertFinishesOnFirstRun(machine);
});

test('duplicate sessions in two homes: a rebuild that 0.15.0 left half-done is completed from the older entries', async () => {
  const machine = createTwoHomeMachine();
  await machine.olderRun();
  assertOlderLayout(machine);
  assert.equal(machine.leaveHalfRebuilt(), machine.duplicateCopies);
  await assertFinishesOnFirstRun(machine);
});

test('duplicate sessions in two homes: headers and indexes written by algorithm 5 are not taken over', async () => {
  // Algorithm 5 hashed durable usage records without their response id and
  // kept no model provider, so its headers and indexes are not what this
  // version computes. (Its summaries still stand in where Magpie was never
  // active.) Such a machine reads the copies again, across several runs.
  const machine = createTwoHomeMachine();
  await machine.olderRun();
  machine.restampOlder(5);
  const first = await machine.newRun(TWO_HOME_CUT);
  assert.equal(first.done, false);
  // Header discovery reads each copy only up to its first record (it used to
  // keep reading every file to its end in the background, which this clock
  // charged as a full read), so the budget runs out in the replay index.
  assert.match(first.indexing, /^replay-index /);
  // Only the session that exists once: its algorithm-5 summary is usable whole.
  assert.equal(first.result.cache.headerHits, 1);
  assert.equal(first.result.cache.indexHits, 0);
});
