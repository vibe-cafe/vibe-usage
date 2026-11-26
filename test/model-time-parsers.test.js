// Model time (approved 2026-11-25) for parsers on the 'events' rule that have
// each reply's output tokens: the reply is capped at 30 s + output / 20 per
// second instead of the 2-minute unknown cap, and a recorded output of 0
// counts nothing. All synthetic; every test uses its own temporary root.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function withEnv(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  return Promise.resolve(run()).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const at = seconds => new Date(T0 + seconds * 1000).toISOString();

test('Gemini CLI replies are timed with their output tokens, thoughts included', async () => {
  // Gemini's directory is read from the home directory when the module loads.
  const home = mkdtempSync(join(tmpdir(), 'vibe-usage-gemini-time-'));
  try {
    const chats = join(home, '.gemini', 'tmp', 'project-hash', 'chats');
    mkdirSync(chats, { recursive: true });
    writeFileSync(join(chats, 'session-2026-11-20T10-00-abc.json'), JSON.stringify({
      sessionId: 'abc',
      messages: [
        { type: 'user', timestamp: at(0), content: 'x' },
        { type: 'gemini', timestamp: at(200), model: 'gemini-3-pro', tokens: { input: 10, output: 20, thoughts: 4 } },
        { type: 'user', timestamp: at(300), content: 'y' },
        { type: 'gemini', timestamp: at(500), model: 'gemini-3-pro', tokens: { input: 10, output: 0 } },
      ],
    }));
    await withEnv({ HOME: home, USERPROFILE: home }, async () => {
      const { parse } = await import(`../src/parsers/gemini-cli.js?home=${encodeURIComponent(home)}`);
      const result = await parse();
      assert.equal(result.sessions.length, 1);
      // 20 output tokens (thoughts within them): 31 s; an output of 0: nothing.
      assert.equal(result.sessions[0].activeSeconds, 31);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('OpenClaw replies are timed with their output tokens; a usage without an output count is unknown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-openclaw-time-'));
  try {
    const sessions = join(root, 'agents', 'main', 'sessions');
    mkdirSync(sessions, { recursive: true });
    const message = (seconds, role, usage) => JSON.stringify({
      type: 'message', timestamp: at(seconds), message: { role, model: 'claw-model', ...(usage ? { usage } : {}) },
    });
    writeFileSync(join(sessions, 'session.jsonl'), [
      message(0, 'user'),
      message(100, 'assistant', { input: 10, output: 20 }),
      message(200, 'user'),
      message(300, 'assistant', { input: 10 }),
    ].join('\n') + '\n');
    await withEnv({ VIBE_USAGE_OPENCLAW_DIRS: root }, async () => {
      const { parse } = await import('../src/parsers/openclaw.js');
      const result = await parse();
      assert.equal(result.sessions.length, 1);
      // 31 s for the 20-token reply, then 100 s (under the 2-minute cap).
      assert.equal(result.sessions[0].activeSeconds, 31 + 100);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('WorkBuddy replies take the output of the copy whose usage is kept', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-workbuddy-time-'));
  try {
    const record = (usage) => ({
      id: 'reply-1', timestamp: at(100), type: 'message', role: 'assistant', status: 'completed',
      cwd: '/repo/project', message: { role: 'assistant', usage },
      providerData: { requestModelId: 'hy3', usage },
    });
    const user = { id: 'user-1', timestamp: at(0), type: 'message', role: 'user', cwd: '/repo/project', message: { role: 'user' } };
    for (const [dir, usage] of [['a', { inputTokens: 10, outputTokens: 20 }], ['b', { inputTokens: 0, outputTokens: 0 }]]) {
      const project = join(root, dir, 'projects', 'project');
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, 'session-a.jsonl'), [user, record(usage)].map(r => JSON.stringify(r)).join('\n') + '\n');
    }
    await withEnv({ VIBE_USAGE_WORKBUDDY_DIRS: [join(root, 'a'), join(root, 'b')].join(process.platform === 'win32' ? ';' : ':') }, async () => {
      const { parse } = await import('../src/parsers/workbuddy.js');
      const result = await parse();
      assert.equal(result.sessions.length, 1);
      assert.equal(result.sessions[0].activeSeconds, 31);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pi copies of one reply are timed with the output of the copy whose usage is kept, in either order', async () => {
  const { parse } = await import('../src/parsers/pi-coding-agent.js');
  const lines = (output) => [
    { type: 'session', version: 3, id: 'session-1', timestamp: at(0), cwd: '/work/project' },
    { type: 'message', id: 'user-1', parentId: 'session-1', timestamp: at(0), message: { role: 'user', content: [] } },
    { type: 'message', id: 'assistant-1', parentId: 'user-1', timestamp: at(100),
      message: { role: 'assistant', model: 'test-model', usage: { input: output ? 10 : 0, output } } },
  ].map(line => JSON.stringify(line)).join('\n') + '\n';
  for (const order of [[20, 0], [0, 20]]) {
    const root = mkdtempSync(join(tmpdir(), 'vibe-usage-pi-copies-time-'));
    try {
      const dirs = order.map((output, index) => {
        const dir = join(root, `home-${index}`, '--work-project--');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'session.jsonl'), lines(output));
        return join(root, `home-${index}`);
      });
      await withEnv({ VIBE_USAGE_PI_SESSION_DIRS: dirs.join(process.platform === 'win32' ? ';' : ':') }, async () => {
        const result = await parse();
        assert.equal(result.sessions.length, 1, String(order));
        assert.equal(result.sessions[0].activeSeconds, 31, String(order));
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
