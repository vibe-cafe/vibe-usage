import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import zlib from 'node:zlib';
import { parse } from '../src/parsers/codex.js';
import { codexCacheDir, olderCodexCacheDir } from '../src/parsers/codex-cache.js';
import { planCodexSegments } from '../src/parsers/codex-segments.js';
import { ZstdDecodeError, zstdFileCopyOf, zstdFileHeadChunks } from '../src/parsers/zstd-file.js';

// One conversation kept in several Codex homes. Orca links every rollout of
// an account into each account's home (hard links), and Codex Desktop, run on
// `~/.codex`, compresses its own copy after 7 days (`.jsonl.zst`) while the
// plain links elsewhere stay. All fixtures are synthetic.

const previousCindyDirs = process.env.VIBE_USAGE_CINDY_DIRS;
process.env.VIBE_USAGE_CINDY_DIRS = join(tmpdir(), 'vibe-usage-cindy-disabled');
test.after(() => {
  if (previousCindyDirs === undefined) delete process.env.VIBE_USAGE_CINDY_DIRS;
  else process.env.VIBE_USAGE_CINDY_DIRS = previousCindyDirs;
});

const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function';
const needsZstd = HAS_ZSTD ? {} : { skip: 'node:zlib has no zstd before Node 22.15' };

const DAY_DIR = join('sessions', '2026', '07', '10');

function sessionMeta(timestamp, id, extra = {}) {
  return { timestamp, type: 'session_meta', payload: { id, cwd: '/Users/x/proj', timestamp, ...extra } };
}

function tokenCount(timestamp, input, cumulativeTotal, model = 'gpt-5.2') {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model,
        total_token_usage: { total_tokens: cumulativeTotal },
        last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: input + 1 },
      },
    },
  };
}

function jsonl(records) {
  return `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
}

const shared = jsonl([
  sessionMeta('2026-07-10T08:00:00.000Z', 'shared-1'),
  { type: 'turn_context', timestamp: '2026-07-10T08:00:00.000Z', payload: { model: 'gpt-5.2', service_tier: 'priority' } },
  tokenCount('2026-07-10T08:05:00.000Z', 1000, 1001),
  { timestamp: '2026-07-10T08:06:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: '共享的对话 ✓'.repeat(300) } },
  tokenCount('2026-07-10T08:20:00.000Z', 2000, 3002),
]);
const sharedFile = 'rollout-2026-07-10T08-00-00-shared-1.jsonl';
// A fork of the shared conversation, in one home only.
const fork = jsonl([
  sessionMeta('2026-07-17T09:00:00.000Z', 'fork-1', { forked_from_id: 'shared-1' }),
  { ...tokenCount('2026-07-10T08:05:00.000Z', 1000, 1001), timestamp: '2026-07-17T09:00:00.000Z' },
  { ...tokenCount('2026-07-10T08:20:00.000Z', 2000, 3002), timestamp: '2026-07-17T09:00:00.000Z' },
  tokenCount('2026-07-17T09:01:00.000Z', 5, 3008),
]);
const forkFile = 'rollout-2026-07-17T09-00-00-fork-1.jsonl';
// Another conversation in the two Orca homes only; nothing about it changes.
const other = jsonl([
  sessionMeta('2026-07-11T08:00:00.000Z', 'other-1'),
  tokenCount('2026-07-11T08:05:00.000Z', 300, 301),
]);
const otherFile = 'rollout-2026-07-11T08-00-00-other-1.jsonl';

/**
 * `~/.codex` (sorted first, like the real path) and two Orca account homes.
 * The cache and Codex homes live in one temporary directory.
 */
async function withHomes(fn) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codex-shared-'));
  const homes = { codex: join(root, 'a-codex'), orca1: join(root, 'b-orca1'), orca2: join(root, 'c-orca2') };
  for (const home of Object.values(homes)) mkdirSync(join(home, DAY_DIR), { recursive: true });
  const saved = {
    CODEX_HOME: process.env.CODEX_HOME,
    VIBE_USAGE_CACHE_DIR: process.env.VIBE_USAGE_CACHE_DIR,
    VIBE_USAGE_CODEX_WORK_BUDGET_MS: process.env.VIBE_USAGE_CODEX_WORK_BUDGET_MS,
    VIBE_USAGE_CODEX_CACHE: process.env.VIBE_USAGE_CODEX_CACHE,
  };
  process.env.CODEX_HOME = homes.codex;
  process.env.VIBE_USAGE_CACHE_DIR = join(root, 'cache');
  process.env.VIBE_USAGE_CODEX_WORK_BUDGET_MS = '600000';
  delete process.env.VIBE_USAGE_CODEX_CACHE;
  const file = (home, name) => join(homes[home], DAY_DIR, name);
  const run = () => parse({ extraRoots: [homes.orca1, homes.orca2] });
  const uncached = async () => {
    process.env.VIBE_USAGE_CODEX_CACHE = '0';
    try { return await run(); } finally { delete process.env.VIBE_USAGE_CODEX_CACHE; }
  };
  try {
    return await fn({ root, homes, file, run, uncached });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function view(result) {
  return {
    buckets: [...result.buckets].sort((a, b) => `${a.bucketStart}${a.model}${a.project}`.localeCompare(`${b.bucketStart}${b.model}${b.project}`)),
    sessions: [...result.sessions].sort((a, b) => a.sessionHash.localeCompare(b.sessionHash)),
  };
}

function totalInput(result) {
  return result.buckets.reduce((sum, bucket) => sum + bucket.inputTokens, 0);
}

const groupEntries = dir => (existsSync(dir) ? readdirSync(dir) : []).filter(name => name.endsWith('.json') && !name.endsWith('.tail.json'));

test('a compressed copy of a conversation other homes keep plain does not merge its group again', needsZstd, async () => {
  await withHomes(async ({ homes, file, run, uncached }) => {
    // As the previous release left it: the plain links in the Orca homes; the
    // compressed copy in ~/.codex was not read.
    writeFileSync(file('orca1', sharedFile), shared);
    linkSync(file('orca1', sharedFile), file('orca2', sharedFile));
    writeFileSync(file('orca1', otherFile), other);
    linkSync(file('orca1', otherFile), file('orca2', otherFile));
    writeFileSync(file('orca1', forkFile), fork);
    const before = await run();
    assert.equal(before.skipped, undefined);
    const groupCacheBefore = groupEntries(codexCacheDir(homes.orca1));

    // Codex compressed its copy in ~/.codex; Orca linked the .zst into its
    // second home too, beside its plain link (the plain one is read there).
    writeFileSync(file('codex', `${sharedFile}.zst`), zlib.zstdCompressSync(Buffer.from(shared)));
    linkSync(file('codex', `${sharedFile}.zst`), file('orca2', `${sharedFile}.zst`));
    const after = await run();
    assert.equal(after.skipped, undefined, JSON.stringify(after));
    // The compressed copy's header, and one decompression proving it is a
    // copy. The group is not merged again: its summary is still the one the
    // plain links made.
    assert.equal(after.cache.filesRead, 2, JSON.stringify(after.cache));
    assert.equal(after.cache.resultHits, 3, JSON.stringify(after.cache)); // two groups + the fork
    assert.deepEqual(groupEntries(codexCacheDir(homes.codex)).length, 1, 'only the compressed copy\'s own entry');
    assert.deepEqual(groupEntries(codexCacheDir(homes.orca1)).length, groupCacheBefore.length);

    const expected = await uncached();
    assert.deepEqual(view(after), view(expected));
    assert.deepEqual(view(after), view(before));
    // The fork counts only its own record, not the copied history again.
    assert.equal(totalInput(expected), 3000 + 300 + 5);

    const warm = await run();
    assert.equal(warm.cache.filesRead, 0);
    assert.deepEqual(view(warm), view(expected));
  });
});

test('a compressed member that differs from every plain copy is merged with them', needsZstd, async () => {
  await withHomes(async ({ file, run, uncached }) => {
    writeFileSync(file('orca1', sharedFile), shared);
    linkSync(file('orca1', sharedFile), file('orca2', sharedFile));
    await run();
    // Same length, one different digit: the size check passes, the bytes do not.
    const changed = shared.replace('"input_tokens":2000', '"input_tokens":2001');
    assert.equal(changed.length, shared.length);
    writeFileSync(file('codex', `${sharedFile}.zst`), zlib.zstdCompressSync(Buffer.from(changed)));
    const after = await run();
    assert.equal(after.skipped, undefined, JSON.stringify(after));
    const expected = await uncached();
    assert.deepEqual(view(after), view(expected));
    // Header, the failed comparison counted with the index read, and a merge
    // of the two different contents (the two plain links are read once).
    assert.equal(after.cache.filesRead, 1 + 1 + 2, JSON.stringify(after.cache));
  });
});

test('hard links of one rollout are indexed and merged once', async () => {
  await withHomes(async ({ file, run, uncached }) => {
    writeFileSync(file('orca1', sharedFile), shared);
    linkSync(file('orca1', sharedFile), file('orca2', sharedFile));
    const linked = await run();
    // Two headers, one replay index, one merge (summarized in the same step).
    assert.equal(linked.cache.filesRead, 4, JSON.stringify(linked.cache));
    assert.deepEqual(view(linked), view(await uncached()));
    assert.equal(totalInput(linked), 3000);
  });
  await withHomes(async ({ file, run }) => {
    // Separate files with the same bytes are not assumed equal.
    writeFileSync(file('orca1', sharedFile), shared);
    writeFileSync(file('orca2', sharedFile), shared);
    const copied = await run();
    assert.equal(copied.cache.filesRead, 6, JSON.stringify(copied.cache));
    assert.equal(totalInput(copied), 3000);
  });
});

test('a group merged in one run and summarized in a later one is merged only once', async () => {
  await withHomes(async ({ file, run, uncached }) => {
    // Two copies that differ (a live continuation of an older copy), so the
    // merge reads both. A clock that moves 1 ms per file opened and a budget
    // of 1 ms stop every run at the first budget check after a read.
    writeFileSync(file('orca1', sharedFile), shared);
    writeFileSync(file('orca2', sharedFile), shared + jsonl([tokenCount('2026-07-10T08:30:00.000Z', 7, 3010)]));
    process.env.VIBE_USAGE_CODEX_WORK_BUDGET_MS = '1';
    const realNow = Date.now;
    const realCreateReadStream = fs.createReadStream;
    let now = realNow();
    Date.now = () => now;
    fs.createReadStream = (...args) => {
      now++;
      return realCreateReadStream(...args);
    };
    syncBuiltinESMExports();
    let reads = 0;
    let result;
    const phases = [];
    try {
      for (let i = 0; i < 20; i++) {
        result = await run();
        reads += result.cache?.filesRead || 0;
        if (!result.skipped && !result.indexing) break;
        phases.push(`${result.skipped ? 'skipped' : 'partial'} ${result.indexing?.phase}`);
      }
    } finally {
      Date.now = realNow;
      fs.createReadStream = realCreateReadStream;
      syncBuiltinESMExports();
      process.env.VIBE_USAGE_CODEX_WORK_BUDGET_MS = '600000';
    }
    assert.equal(result.skipped, undefined, JSON.stringify(result));
    // Only a run that could not read every header is skipped; after that a run
    // that runs out of budget uploads what is exact and leaves the rest.
    assert.deepEqual(phases, ['skipped discovery', 'partial replay-index', 'partial replay-index', 'partial segments']);
    // Two headers, two indexes, one merge of both copies -- not a second
    // merge in the usage pass of the next run.
    assert.equal(reads, 6);
    assert.deepEqual(view(result), view(await uncached()));
  });
});

const signature = (ino, size = 10) => ({ size, mtimeMs: 1, dev: '1', ino: String(ino) });
const member = (filePath, ino, extra = {}) => ({ filePath, signature: signature(ino), compressed: false, ...extra });
const copyOf = target => ({ compressed: true, cache: { copyOf: { filePath: target.filePath, signature: target.signature } } });
const paths = list => list.map(file => file.filePath);

test('planCodexSegments: one member per content class, identity without proven copies', () => {
  const a = member('/b/a', 1);
  const aLink = member('/c/a', 1);
  // Hard links: one class, the group keeps its identity.
  let plan = planCodexSegments([a, aLink]);
  assert.deepEqual(paths(plan.read), ['/b/a']);
  assert.deepEqual(paths(plan.identity), ['/b/a', '/c/a']);

  // A proven compressed copy sorted first: read the plain file in its place,
  // and name the group by the plain members as before the copy appeared.
  const z = member('/a/z', 9, copyOf(a));
  plan = planCodexSegments([z, a, aLink]);
  assert.deepEqual(paths(plan.read), ['/b/a']);
  assert.deepEqual(paths(plan.identity), ['/b/a', '/c/a']);

  // A different conversation segment between the copy and its twin: the
  // copy's position decides the merge order, so the identity keeps it.
  const other = member('/b/other', 2);
  plan = planCodexSegments([z, other, a]);
  assert.deepEqual(paths(plan.read), ['/b/a', '/b/other']);
  assert.deepEqual(paths(plan.identity), ['/a/z', '/b/other', '/b/a']);
  // ...unless the twin comes first anyway.
  plan = planCodexSegments([a, other, z]);
  assert.deepEqual(paths(plan.read), ['/b/a', '/b/other']);
  assert.deepEqual(paths(plan.identity), ['/b/a', '/b/other']);

  // The twin changed since the comparison, or the copy names a file that is
  // not a plain member: not a copy.
  const stale = member('/a/z', 9, { compressed: true, cache: { copyOf: { filePath: a.filePath, signature: signature(1, 11) } } });
  plan = planCodexSegments([stale, a]);
  assert.deepEqual(paths(plan.read), ['/a/z', '/b/a']);
  assert.deepEqual(paths(plan.identity), ['/a/z', '/b/a']);
  const z2 = member('/a/z2', 8, { compressed: true });
  const ofCompressed = member('/a/z3', 7, copyOf(z2));
  plan = planCodexSegments([ofCompressed, z2]);
  assert.deepEqual(paths(plan.read), ['/a/z3', '/a/z2']);
});

test('zstdFileCopyOf compares decompressed bytes and stops at the first difference', needsZstd, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-usage-zst-copy-'));
  try {
    const write = (name, content) => {
      const path = join(dir, name);
      writeFileSync(path, content);
      return { filePath: path, size: Buffer.byteLength(content) };
    };
    const big = jsonl(Array.from({ length: 4000 }, (_, i) => tokenCount('2026-07-10T08:05:00.000Z', i, i)));
    const compressed = Buffer.concat([
      zlib.zstdCompressSync(Buffer.from(big.slice(0, 100000))),
      zlib.zstdCompressSync(Buffer.from(big.slice(100000))),
    ]);
    const zst = write('x.jsonl.zst', compressed);
    const same = write('same.jsonl', big);
    const differs = write('differs.jsonl', `${big.slice(0, -3)}X}\n`);
    const shorter = write('shorter.jsonl', big.slice(0, -1));
    assert.equal(await zstdFileCopyOf(zst.filePath, zst.size, [same]), same);
    assert.equal(await zstdFileCopyOf(zst.filePath, zst.size, [differs]), null);
    // Only the first candidate of the declared size is compared.
    assert.equal(await zstdFileCopyOf(zst.filePath, zst.size, [shorter, differs, same]), null);
    assert.equal(await zstdFileCopyOf(zst.filePath, zst.size, [shorter, same, differs]), same);
    assert.equal(await zstdFileCopyOf(zst.filePath, zst.size, []), null);
    // A damaged compressed file is an error, not "different".
    const cut = write('cut.jsonl.zst', compressed.subarray(0, compressed.length - 9));
    await assert.rejects(zstdFileCopyOf(cut.filePath, cut.size, [same]), ZstdDecodeError);

    // A header read decodes only the start: damage further on is found by the
    // full read later, not here.
    const head = write('head.jsonl.zst', Buffer.concat([zlib.zstdCompressSync(Buffer.from(big)), Buffer.from('garbage')]));
    let first = '';
    for await (const chunk of zstdFileHeadChunks(head.filePath, head.size)) {
      first += chunk.toString();
      if (first.includes('\n')) break;
    }
    assert.equal(first.split('\n')[0], big.split('\n')[0]);
    const scrambled = write('scrambled.jsonl.zst', Buffer.from('definitely not zstd at all'));
    await assert.rejects(async () => {
      for await (const chunk of zstdFileHeadChunks(scrambled.filePath, scrambled.size)) void chunk;
    }, ZstdDecodeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the copy relation is dropped when the plain twin changes', needsZstd, async () => {
  await withHomes(async ({ file, run, uncached }) => {
    writeFileSync(file('orca1', sharedFile), shared);
    writeFileSync(file('codex', `${sharedFile}.zst`), zlib.zstdCompressSync(Buffer.from(shared)));
    const first = await run();
    assert.equal(totalInput(first), 3000);
    // The plain copy grows (the conversation was reopened in Orca's home).
    writeFileSync(file('orca1', sharedFile), shared + jsonl([tokenCount('2026-07-10T09:00:00.000Z', 40, 3042)]));
    const grown = await run();
    assert.equal(grown.skipped, undefined);
    assert.deepEqual(view(grown), view(await uncached()));
    assert.equal(totalInput(grown), 3040);
    // And the compressed copy disappears again (restored by Codex elsewhere).
    unlinkSync(file('codex', `${sharedFile}.zst`));
    const alone = await run();
    assert.deepEqual(view(alone), view(await uncached()));
  });
});

test('a warm sync looks up no older entry and no tail for the copies of a shared session', async () => {
  await withHomes(async ({ homes, file, run, uncached }) => {
    // One conversation linked into both Orca homes, an unlinked copy of it in
    // ~/.codex, and a fork of it, so its copies are also a fork's parent.
    writeFileSync(file('orca1', sharedFile), shared);
    linkSync(file('orca1', sharedFile), file('orca2', sharedFile));
    writeFileSync(file('codex', sharedFile), shared);
    writeFileSync(file('orca1', forkFile), fork);
    const first = await run();
    // What 0.14 left for exactly these file states, next to each entry of ours:
    // the same entry under algorithm 6.
    let planted = 0;
    for (const home of Object.values(homes)) {
      const dir = codexCacheDir(home);
      for (const name of groupEntries(dir)) {
        const entry = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        writeFileSync(join(olderCodexCacheDir(home), name), JSON.stringify({ ...entry, algorithmVersion: 6 }));
        planted++;
      }
    }
    assert.ok(planted >= 5, `planted ${planted}`);
    const realReadFileSync = fs.readFileSync;
    const reads = [];
    fs.readFileSync = (path, ...rest) => {
      reads.push(String(path));
      return realReadFileSync(path, ...rest);
    };
    syncBuiltinESMExports();
    let second;
    try {
      second = await run();
    } finally {
      fs.readFileSync = realReadFileSync;
      syncBuiltinESMExports();
    }
    // Every copy of the shared session has its own header and index and never a
    // summary (the group's entry holds it); the fork has its own summary.
    // Older entries: anything under a home's cache directory outside this
    // version's own folder (versions up to 6 at the top, version 7 in `v7`).
    const olderReads = reads.filter(path => Object.values(homes).some(home =>
      path.startsWith(olderCodexCacheDir(home) + sep) && !path.startsWith(codexCacheDir(home) + sep)));
    assert.deepEqual(olderReads, []);
    assert.deepEqual(reads.filter(path => path.endsWith('.tail.json')), []);
    assert.equal(second.cache.filesRead, 0);
    assert.equal(second.cache.headerHits, 4);
    assert.deepEqual(view(second), view(first));
    assert.deepEqual(view(second), view(await uncached()));
    assert.equal(totalInput(second), 3005);
  });
});
