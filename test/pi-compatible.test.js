import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseCraftAgent } from '../src/parsers/craft-agent.js';
import { parse as parseOmp } from '../src/parsers/omp.js';
import { parse as parsePi } from '../src/parsers/pi-coding-agent.js';
import { getOmpSessionDirs, getPiSessionDirs } from '../src/pi-roots.js';
import { validateExtraRoot, piSessionsDir } from '../src/extra-roots.js';

const previousCindyDirs = process.env.VIBE_USAGE_CINDY_DIRS;
process.env.VIBE_USAGE_CINDY_DIRS = join(tmpdir(), 'vibe-usage-cindy-disabled');
test.after(() => {
  if (previousCindyDirs === undefined) delete process.env.VIBE_USAGE_CINDY_DIRS;
  else process.env.VIBE_USAGE_CINDY_DIRS = previousCindyDirs;
});

function restoreEnv(name, value) {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

// Mirrors a real Pi store: the header carries a full SessionHeader
// (version/id/timestamp/cwd) and message records carry id/parentId/timestamp.
function sessionLines({
  sessionId = 'session-1',
  cwd = '/work/project',
  input = 100,
  titleSlot = false,
} = {}) {
  return [
    ...(titleSlot ? [{
      type: 'title',
      v: 1,
      title: 'Current OMP v3 title slot',
      updatedAt: '2026-07-27T13:19:56.000Z',
      pad: '',
    }] : []),
    { type: 'session', version: 3, id: sessionId, timestamp: '2026-07-27T13:19:57.000Z', cwd },
    {
      type: 'message',
      id: 'user-1',
      parentId: sessionId,
      timestamp: '2026-07-27T13:20:00.000Z',
      message: { role: 'user', content: [] },
    },
    {
      type: 'message',
      id: 'assistant-1',
      parentId: 'user-1',
      timestamp: '2026-07-27T13:20:05.000Z',
      message: {
        role: 'assistant',
        model: 'test-model',
        usage: {
          input,
          output: 20,
          cacheRead: 30,
          cacheWrite: 10,
          reasoningTokens: 4,
        },
      },
    },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n';
}

function writeSession(sessionsDir, relativePath, options) {
  const path = join(sessionsDir, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, sessionLines(options));
  return path;
}

test('Pi-compatible parsers count cache writes as input tokens', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-pi-compatible-'));
  const previousPi = process.env.VIBE_USAGE_PI_SESSION_DIRS;
  const previousCraft = process.env.CRAFT_AGENT_DIR;
  try {
    const piSessions = join(root, 'pi-sessions');
    writeSession(piSessions, join('--work-project--', 'pi.jsonl'));
    process.env.VIBE_USAGE_PI_SESSION_DIRS = piSessions;

    const pi = await parsePi();
    assert.equal(pi.buckets.length, 1);
    assert.equal(pi.buckets[0].source, 'pi-coding-agent');
    assert.equal(pi.buckets[0].inputTokens, 110);
    assert.equal(pi.buckets[0].cachedInputTokens, 30);
    assert.equal(pi.buckets[0].reasoningOutputTokens, 4);
    assert.equal(pi.buckets[0].outputTokens, 16);
    assert.equal(pi.buckets[0].totalTokens, 130);

    const craftRoot = join(root, 'craft');
    writeSession(
      join(craftRoot, 'workspaces'),
      join('workspace', 'sessions', 'branch-name', '.pi-sessions', 'craft.jsonl'),
      { cwd: null },
    );
    process.env.CRAFT_AGENT_DIR = craftRoot;

    const craft = await parseCraftAgent();
    assert.equal(craft.buckets.length, 1);
    assert.equal(craft.buckets[0].source, 'craft-agent');
    assert.equal(craft.buckets[0].project, 'branch-name');
    assert.equal(craft.buckets[0].inputTokens, 110);
  } finally {
    restoreEnv('VIBE_USAGE_PI_SESSION_DIRS', previousPi);
    restoreEnv('CRAFT_AGENT_DIR', previousCraft);
    rmSync(root, { recursive: true, force: true });
  }
});

test('OMP scans multiple stores and deduplicates copied records', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-omp-dedup-'));
  const previous = process.env.VIBE_USAGE_OMP_SESSION_DIRS;
  try {
    const first = join(root, 'first');
    const second = join(root, 'second');
    writeSession(first, join('project', 'copy.jsonl'), { titleSlot: true });
    writeSession(second, join('project', 'copy.jsonl'), { titleSlot: true });
    process.env.VIBE_USAGE_OMP_SESSION_DIRS = `${first}${delimiter}${second}`;

    const result = await parseOmp();
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0].source, 'omp');
    assert.equal(result.buckets[0].inputTokens, 110);
    assert.equal(result.buckets[0].outputTokens, 16);
    assert.equal(result.buckets[0].reasoningOutputTokens, 4);
    assert.equal(result.buckets[0].totalTokens, 130);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].messageCount, 2);
  } finally {
    restoreEnv('VIBE_USAGE_OMP_SESSION_DIRS', previous);
    rmSync(root, { recursive: true, force: true });
  }
});

test('OMP discovers XDG profiles and does not also label its agent store as Pi', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-omp-roots-'));
  const previous = Object.fromEntries([
    'VIBE_USAGE_OMP_SESSION_DIRS',
    'VIBE_USAGE_PI_SESSION_DIRS',
    'PI_CODING_AGENT_DIR',
    'PI_CONFIG_DIR',
    'XDG_DATA_HOME',
  ].map((name) => [name, process.env[name]]));
  try {
    delete process.env.VIBE_USAGE_OMP_SESSION_DIRS;
    delete process.env.VIBE_USAGE_PI_SESSION_DIRS;
    process.env.PI_CONFIG_DIR = '.vibe-usage-test-missing-omp-config';
    process.env.XDG_DATA_HOME = join(root, 'xdg');
    const xdgSession = join(root, 'xdg', 'omp', 'sessions');
    const xdgProfile = join(root, 'xdg', 'omp', 'profiles', 'work', 'sessions');
    mkdirSync(xdgSession, { recursive: true });
    mkdirSync(xdgProfile, { recursive: true });

    const ompAgent = join(root, '.omp', 'agent');
    const overriddenSession = join(ompAgent, 'sessions');
    mkdirSync(overriddenSession, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = ompAgent;

    const ompDirs = getOmpSessionDirs();
    assert.ok(ompDirs.includes(xdgSession));
    assert.ok(ompDirs.includes(xdgProfile));
    assert.ok(ompDirs.includes(overriddenSession));
    assert.deepEqual(getPiSessionDirs(), []);
    // The OMP guard suppresses discovery of an OMP store as Pi; it must not
    // discard a root the user added explicitly. The root has to be a real
    // store: `add-root` never persists a directory holding no Pi sessions.
    const piStore = join(root, 'pi-sessions');
    mkdirSync(piStore, { recursive: true });
    writeFileSync(join(piStore, 'session-explicit.jsonl'), sessionLines({ sessionId: 'explicit' }));
    assert.deepEqual(getPiSessionDirs([piStore]), [piStore]);
  } finally {
    for (const [name, value] of Object.entries(previous)) restoreEnv(name, value);
    rmSync(root, { recursive: true, force: true });
  }
});

function reasoningSession(usage) {
  return [
    { type: 'session', id: 'reasoning-1', timestamp: '2026-07-27T13:19:57.000Z', cwd: '/work/project' },
    {
      type: 'message',
      id: 'user-1',
      timestamp: '2026-07-27T13:20:00.000Z',
      message: { role: 'user', content: [] },
    },
    {
      type: 'message',
      id: 'assistant-1',
      timestamp: '2026-07-27T13:20:05.000Z',
      message: { role: 'assistant', model: 'test-model', usage },
    },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n';
}

test('Pi reasoning tokens are split out of output using Pi\'s own usage.reasoning field', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-pi-reasoning-'));
  const previous = process.env.VIBE_USAGE_PI_SESSION_DIRS;
  try {
    const sessions = join(root, 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, 'pi.jsonl'),
      reasoningSession({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 8 }),
    );
    process.env.VIBE_USAGE_PI_SESSION_DIRS = sessions;

    const result = await parsePi();
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0].reasoningOutputTokens, 8);
    assert.equal(result.buckets[0].outputTokens, 12);
    // Reasoning is a subset of output, so the total must not change.
    assert.equal(result.buckets[0].totalTokens, 120);
  } finally {
    restoreEnv('VIBE_USAGE_PI_SESSION_DIRS', previous);
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pi still reads the legacy reasoningTokens spelling', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-pi-reasoning-legacy-'));
  const previous = process.env.VIBE_USAGE_PI_SESSION_DIRS;
  try {
    const sessions = join(root, 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, 'pi.jsonl'),
      reasoningSession({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoningTokens: 8 }),
    );
    process.env.VIBE_USAGE_PI_SESSION_DIRS = sessions;

    const result = await parsePi();
    assert.equal(result.buckets[0].reasoningOutputTokens, 8);
    assert.equal(result.buckets[0].outputTokens, 12);
  } finally {
    restoreEnv('VIBE_USAGE_PI_SESSION_DIRS', previous);
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pi discovery honors PI_CODING_AGENT_SESSION_DIR alongside the agent store', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-pi-session-dir-'));
  const previous = Object.fromEntries([
    'VIBE_USAGE_PI_SESSION_DIRS',
    'PI_CODING_AGENT_DIR',
    'PI_CODING_AGENT_SESSION_DIR',
  ].map((name) => [name, process.env[name]]));
  try {
    delete process.env.VIBE_USAGE_PI_SESSION_DIRS;
    const agentDir = join(root, 'agent');
    const agentSessions = join(agentDir, 'sessions');
    const relocated = join(root, 'relocated');
    mkdirSync(agentSessions, { recursive: true });
    mkdirSync(relocated, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_SESSION_DIR = relocated;

    const dirs = getPiSessionDirs();
    assert.ok(dirs.includes(agentSessions));
    assert.ok(dirs.includes(relocated));
  } finally {
    for (const [name, value] of Object.entries(previous)) restoreEnv(name, value);
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pi scans an explicitly configured extra session root that discovery cannot see', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-pi-extra-root-'));
  const previous = Object.fromEntries([
    'VIBE_USAGE_PI_SESSION_DIRS',
    'PI_CODING_AGENT_DIR',
    'PI_CODING_AGENT_SESSION_DIR',
  ].map((name) => [name, process.env[name]]));
  try {
    delete process.env.VIBE_USAGE_PI_SESSION_DIRS;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    const agentDir = join(root, 'agent');
    const agentSessions = join(agentDir, 'sessions');
    // A harness that runs `pi --session <file>` writes a flat store with no
    // agent directory above it, so nothing in Pi's own settings names it.
    const harnessStore = join(root, 'harness-sessions');
    mkdirSync(agentSessions, { recursive: true });
    mkdirSync(harnessStore, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeSession(agentSessions, 'default/session-default.jsonl', { sessionId: 'session-default' });
    writeFileSync(join(harnessStore, 'session-harness.jsonl'), sessionLines({
      sessionId: 'session-harness',
      cwd: '/work/harness',
    }));

    // Discovery alone still stops at the default store.
    assert.deepEqual(getPiSessionDirs(), [agentSessions]);
    assert.equal(validateExtraRoot('pi-coding-agent', harnessStore).ok, true);
    assert.deepEqual(getPiSessionDirs([harnessStore]), [agentSessions, harnessStore]);

    const result = await parsePi({ extraRoots: [harnessStore] });
    assert.equal(result.skipped, undefined);
    // Sessions are reported hashed, so assert on the project each store maps to.
    assert.deepEqual(result.sessions.map(({ project }) => project).sort(), ['harness', 'project']);
    assert.deepEqual(result.buckets.map(({ project }) => project).sort(), ['harness', 'project']);
    assert.equal(new Set(result.sessions.map(({ sessionHash }) => sessionHash)).size, 2);
    // A Pi agent directory is accepted too, and resolves to its sessions/
    // child only, so the nested walk cannot read the same file twice.
    assert.deepEqual(getPiSessionDirs([agentDir]), [agentSessions]);
  } finally {
    for (const [name, value] of Object.entries(previous)) restoreEnv(name, value);
    rmSync(root, { recursive: true, force: true });
  }
});

// A store written by a harness that only ever appends (or by an older Pi) can
// contain usage records with no `obj.id`, which record-level dedup cannot see.
function anonymousSessionLines({ sessionId = 'anonymous-1', input = 10 } = {}) {
  return [
    { type: 'session', version: 3, id: sessionId, timestamp: '2026-07-27T13:19:57.000Z', cwd: '/work/project' },
    {
      type: 'message',
      timestamp: '2026-07-27T13:20:05.000Z',
      message: {
        role: 'assistant',
        model: 'test-model',
        usage: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n';
}

test('Pi skips a configured agent root whose sessions/ child disappears', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-pi-extra-root-shape-'));
  const previous = Object.fromEntries([
    'VIBE_USAGE_PI_SESSION_DIRS',
    'PI_CODING_AGENT_DIR',
    'PI_CODING_AGENT_SESSION_DIR',
  ].map((name) => [name, process.env[name]]));
  try {
    delete process.env.VIBE_USAGE_PI_SESSION_DIRS;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, 'no-default-store');

    const agentDir = join(root, 'agent');
    const agentSessions = join(agentDir, 'sessions');
    mkdirSync(agentSessions, { recursive: true });
    writeFileSync(join(agentSessions, 'session-1.jsonl'), sessionLines({ sessionId: 'session-1' }));
    assert.equal(validateExtraRoot('pi-coding-agent', agentDir).ok, true);

    const before = await parsePi({ extraRoots: [agentDir] });
    assert.equal(before.skipped, undefined);
    assert.equal(before.buckets.length, 1);

    // Only the nested sessions/ goes away; the configured root itself stays.
    // Resolving to the root instead would report an empty-but-successful sync
    // and prune the incremental state for a store that is still configured.
    rmSync(agentSessions, { recursive: true, force: true });
    const after = await parsePi({ extraRoots: [agentDir] });
    assert.equal(after.skipped, true);
    assert.deepEqual(after.buckets, []);
    assert.match(after.warnings.join('\n'), /额外根目录不可用/);
  } finally {
    for (const [name, value] of Object.entries(previous)) restoreEnv(name, value);
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pi extra-root validation requires real Pi session files, not just .jsonl', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-pi-extra-root-shape-check-'));
  try {
    const notPi = join(root, 'unrelated-logs');
    mkdirSync(notPi, { recursive: true });
    writeFileSync(join(notPi, 'events.jsonl'), '{"kind":"not-a-pi-session"}\n');
    // Accepting this would persist a root the parser then ignores in silence,
    // which is the failure mode extra roots exist to remove.
    assert.equal(validateExtraRoot('pi-coding-agent', notPi).ok, false);

    const nested = join(root, 'container', 'task-1');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'session-1.jsonl'), sessionLines({ sessionId: 'session-1' }));
    assert.equal(validateExtraRoot('pi-coding-agent', join(root, 'container')).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pi extra-root validation rejects malformed Pi lookalikes that parse to zero', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-pi-extra-root-malformed-'));
  const previous = Object.fromEntries([
    'VIBE_USAGE_PI_SESSION_DIRS',
    'PI_CODING_AGENT_DIR',
    'PI_CODING_AGENT_SESSION_DIR',
  ].map((name) => [name, process.env[name]]));
  try {
    delete process.env.VIBE_USAGE_PI_SESSION_DIRS;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, 'no-default-store');

    // Matching on the `type` name alone accepted both of these. Pi's session
    // format requires a full SessionHeader, and a message record carries
    // id/parentId/timestamp plus a role the parser consumes — so each of these
    // would have been stored as a valid root that forever syncs zero.
    const samples = {
      'header-without-fields': '{"type":"session"}\n',
      'message-without-fields': '{"type":"message","message":{}}\n',
      // A role the parser produces neither usage nor an event for.
      'unsupported-role': JSON.stringify({
        type: 'message',
        id: 'm1',
        parentId: 's1',
        timestamp: '2026-07-27T13:20:05.000Z',
        message: { role: 'system', content: [] },
      }) + '\n',
    };
    for (const [name, body] of Object.entries(samples)) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'store.jsonl'), body);
      assert.equal(validateExtraRoot('pi-coding-agent', dir).ok, false, name);
      // Confirm the rejection matches reality: the parser reads nothing here.
      const result = await parsePi({ extraRoots: [dir] });
      assert.deepEqual(result.buckets, [], name);
    }

    // A complete header still validates, and so does a header-less store whose
    // message records carry the base fields (an appended-to third-party store).
    const headerless = join(root, 'headerless');
    mkdirSync(headerless, { recursive: true });
    writeFileSync(join(headerless, 'store.jsonl'), JSON.stringify({
      type: 'message',
      id: 'assistant-1',
      parentId: 'user-1',
      timestamp: '2026-07-27T13:20:05.000Z',
      message: {
        role: 'assistant',
        model: 'test-model',
        usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    }) + '\n');
    assert.equal(validateExtraRoot('pi-coding-agent', headerless).ok, true);
    const parsed = await parsePi({ extraRoots: [headerless] });
    assert.equal(parsed.buckets.length, 1);
    assert.equal(parsed.buckets[0].inputTokens, 10);
  } finally {
    for (const [name, value] of Object.entries(previous)) restoreEnv(name, value);
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pi keeps scanning a bare store when an unrelated sessions/ child appears', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-pi-extra-root-bare-'));
  const previous = Object.fromEntries([
    'VIBE_USAGE_PI_SESSION_DIRS',
    'PI_CODING_AGENT_DIR',
    'PI_CODING_AGENT_SESSION_DIR',
  ].map((name) => [name, process.env[name]]));
  try {
    delete process.env.VIBE_USAGE_PI_SESSION_DIRS;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, 'no-default-store');

    // The shape `pi --session <file>` writes: session files in the root itself.
    const store = join(root, 'store');
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, 's1.jsonl'), anonymousSessionLines({ input: 10 }));
    assert.equal(piSessionsDir(store), store);
    const before = await parsePi({ extraRoots: [store] });
    assert.equal(before.buckets[0].inputTokens, 10);

    // Preferring a readable `sessions/` by name alone meant this bare mkdir
    // silently redirected the scan to an empty directory: a successful sync
    // reporting zero, which prunes the source's already-uploaded state.
    mkdirSync(join(store, 'sessions'));
    assert.equal(piSessionsDir(store), store);
    const after = await parsePi({ extraRoots: [store] });
    assert.equal(after.skipped, undefined);
    assert.equal(after.buckets[0].inputTokens, 10);

    // The same name-only preference rejected a mixed store outright, even
    // though its root plainly holds sessions. Canonical-path dedup in the
    // parser keeps the recursive read from counting the nested file twice.
    const mixed = join(root, 'mixed');
    const mixedNested = join(mixed, 'sessions');
    mkdirSync(mixedNested, { recursive: true });
    writeFileSync(join(mixed, 'root.jsonl'), anonymousSessionLines({ sessionId: 'r', input: 10 }));
    writeFileSync(join(mixedNested, 'nested.jsonl'), anonymousSessionLines({ sessionId: 'n', input: 7 }));
    assert.equal(validateExtraRoot('pi-coding-agent', mixed).ok, true);
    assert.equal(piSessionsDir(mixed), mixed);
    const mixedResult = await parsePi({ extraRoots: [mixed] });
    assert.equal(mixedResult.skipped, undefined);
    assert.equal(
      mixedResult.buckets.reduce((sum, { inputTokens }) => sum + inputTokens, 0),
      17,
    );

    // An agent home is still resolved to its confirmed sessions/ child.
    const agentDir = join(root, 'agent');
    const agentSessions = join(agentDir, 'sessions');
    mkdirSync(agentSessions, { recursive: true });
    writeFileSync(join(agentSessions, 's1.jsonl'), sessionLines({ sessionId: 'agent-1' }));
    assert.equal(piSessionsDir(agentDir), agentSessions);
  } finally {
    for (const [name, value] of Object.entries(previous)) restoreEnv(name, value);
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pi counts an anonymous record once when extra roots overlap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-pi-extra-root-overlap-'));
  const previous = Object.fromEntries([
    'VIBE_USAGE_PI_SESSION_DIRS',
    'PI_CODING_AGENT_DIR',
    'PI_CODING_AGENT_SESSION_DIR',
  ].map((name) => [name, process.env[name]]));
  try {
    delete process.env.VIBE_USAGE_PI_SESSION_DIRS;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, 'no-default-store');

    const parent = join(root, 'store');
    const child = join(parent, 'nested');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, 'session-anonymous.jsonl'), anonymousSessionLines({ input: 10 }));
    // Both shapes validate on their own, so a user can legitimately end up with
    // an ancestor and a descendant configured at the same time.
    assert.equal(validateExtraRoot('pi-coding-agent', parent).ok, true);
    assert.equal(validateExtraRoot('pi-coding-agent', child).ok, true);
    assert.deepEqual(getPiSessionDirs([parent, child]), [parent, child]);

    const result = await parsePi({ extraRoots: [parent, child] });
    assert.equal(result.skipped, undefined);
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0].inputTokens, 10);
    assert.equal(result.sessions.length, 1);
  } finally {
    for (const [name, value] of Object.entries(previous)) restoreEnv(name, value);
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pi rejects an extra root with no sessions and skips one that disappears', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-pi-extra-root-invalid-'));
  const previous = process.env.VIBE_USAGE_PI_SESSION_DIRS;
  try {
    delete process.env.VIBE_USAGE_PI_SESSION_DIRS;
    const empty = join(root, 'empty');
    mkdirSync(empty, { recursive: true });
    assert.equal(validateExtraRoot('pi-coding-agent', empty).ok, false);
    assert.equal(validateExtraRoot('pi-coding-agent', join(root, 'missing')).ok, false);

    // A configured root that vanishes must not report an empty result: that
    // would prune already-uploaded state and force a full re-upload.
    const result = await parsePi({ extraRoots: [join(root, 'missing')] });
    assert.equal(result.skipped, true);
    assert.deepEqual(result.buckets, []);
    assert.match(result.warnings.join('\n'), /额外根目录不可用/);
  } finally {
    restoreEnv('VIBE_USAGE_PI_SESSION_DIRS', previous);
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pi discovery honors sessionDir from settings.json and ignores relative values', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-pi-settings-dir-'));
  const previous = Object.fromEntries([
    'VIBE_USAGE_PI_SESSION_DIRS',
    'PI_CODING_AGENT_DIR',
    'PI_CODING_AGENT_SESSION_DIR',
  ].map((name) => [name, process.env[name]]));
  try {
    delete process.env.VIBE_USAGE_PI_SESSION_DIRS;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    const agentDir = join(root, 'agent');
    const configured = join(root, 'configured');
    mkdirSync(join(agentDir, 'sessions'), { recursive: true });
    mkdirSync(configured, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;

    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ sessionDir: configured }));
    assert.ok(getPiSessionDirs().includes(configured));

    // Project-relative values resolve against a cwd the scanner does not have.
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ sessionDir: '.pi/sessions' }));
    assert.deepEqual(getPiSessionDirs(), [join(agentDir, 'sessions')]);

    // A malformed settings file must not break discovery.
    writeFileSync(join(agentDir, 'settings.json'), '{ not json');
    assert.deepEqual(getPiSessionDirs(), [join(agentDir, 'sessions')]);
  } finally {
    for (const [name, value] of Object.entries(previous)) restoreEnv(name, value);
    rmSync(root, { recursive: true, force: true });
  }
});
