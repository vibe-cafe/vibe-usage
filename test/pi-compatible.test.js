import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseCraftAgent } from '../src/parsers/craft-agent.js';
import { parse as parseOmp } from '../src/parsers/omp.js';
import { parse as parsePi } from '../src/parsers/pi-coding-agent.js';
import { getOmpSessionDirs, getPiSessionDirs } from '../src/pi-roots.js';

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
    { type: 'session', id: sessionId, timestamp: '2026-07-27T13:19:57.000Z', cwd },
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
