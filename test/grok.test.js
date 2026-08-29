import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from '../src/parsers/grok.js';

test('parse reads Grok session turn_completed usage and session timings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-grok-test-'));
  const sessionsDir = join(root, 'sessions');
  const group = encodeURIComponent('/Users/demo/Projects/my-app');
  const sessionId = '019f68b5-d856-7c20-9916-229c9fc365f9';
  const sessionPath = join(sessionsDir, group, sessionId);
  mkdirSync(sessionPath, { recursive: true });

  writeFileSync(join(sessionPath, 'summary.json'), JSON.stringify({
    info: {
      id: sessionId,
      cwd: '/Users/demo/Projects/my-app',
    },
    created_at: '2026-07-16T02:16:15.779835Z',
    updated_at: '2026-07-16T02:17:18.187735Z',
    current_model_id: 'grok-4.5',
  }));

  // timestamps are Unix seconds (Grok updates.jsonl)
  writeFileSync(join(sessionPath, 'updates.jsonl'), [
    JSON.stringify({
      timestamp: 1784168190,
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'hello' },
          _meta: { modelId: 'grok-4.5', promptIndex: 0 },
        },
      },
    }),
    JSON.stringify({
      timestamp: 1784168195,
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hi' },
        },
      },
    }),
    JSON.stringify({
      timestamp: 1784168200,
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: '7316038c-9d46-48b2-8ef0-c572c990c1d4',
          stop_reason: 'end_turn',
          usage: {
            inputTokens: 46896,
            outputTokens: 1000,
            totalTokens: 47896,
            cachedReadTokens: 32512,
            reasoningTokens: 82,
            modelCalls: 2,
            modelUsage: {
              'grok-4.5': {
                inputTokens: 46896,
                outputTokens: 1000,
                totalTokens: 47896,
                cachedReadTokens: 32512,
                reasoningTokens: 82,
                modelCalls: 2,
              },
            },
            numTurns: 2,
          },
        },
      },
    }),
    // Second turn with a different model, no modelUsage map
    JSON.stringify({
      timestamp: 1784168300,
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'again' },
        },
      },
    }),
    JSON.stringify({
      timestamp: 1784168310,
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'aaaa',
          stop_reason: 'end_turn',
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cachedReadTokens: 20,
            reasoningTokens: 10,
          },
        },
      },
    }),
  ].join('\n') + '\n');

  const prev = process.env.VIBE_USAGE_GROK_SESSIONS;
  process.env.VIBE_USAGE_GROK_SESSIONS = sessionsDir;

  try {
    const result = await parse();

    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].source, 'grok');
    assert.equal(result.sessions[0].project, 'my-app');
    assert.ok(result.sessions[0].userMessageCount >= 2);

    // Two turns → may land in same or different half-hour buckets; sum tokens.
    const buckets = result.buckets.filter((b) => b.source === 'grok');
    assert.ok(buckets.length >= 1);

    const sum = (key) => buckets.reduce((a, b) => a + (b[key] || 0), 0);
    // input = (46896-32512) + (100-20) = 14384 + 80
    assert.equal(sum('inputTokens'), 14384 + 80);
    // output = (1000-82) + (50-10) = 918 + 40
    assert.equal(sum('outputTokens'), 918 + 40);
    assert.equal(sum('cachedInputTokens'), 32512 + 20);
    assert.equal(sum('reasoningOutputTokens'), 82 + 10);

    const models = new Set(buckets.map((b) => b.model));
    assert.ok(models.has('grok-4.5'));
  } finally {
    if (prev !== undefined) {
      process.env.VIBE_USAGE_GROK_SESSIONS = prev;
    } else {
      delete process.env.VIBE_USAGE_GROK_SESSIONS;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('parse falls back to events.jsonl timing and group .cwd project', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-grok-cwd-'));
  const sessionsDir = join(root, 'sessions');
  // Long-path style group name with .cwd sidecar
  const group = 'my-project-a1b2c3d4';
  const sessionId = 'sess-events-only';
  const groupPath = join(sessionsDir, group);
  const sessionPath = join(groupPath, sessionId);
  mkdirSync(sessionPath, { recursive: true });
  writeFileSync(join(groupPath, '.cwd'), '/work/awesome-repo\n');
  writeFileSync(join(sessionPath, 'summary.json'), JSON.stringify({
    info: { id: sessionId },
    current_model_id: 'grok-3',
  }));
  writeFileSync(join(sessionPath, 'updates.jsonl'), '\n');
  writeFileSync(join(sessionPath, 'events.jsonl'), [
    JSON.stringify({ ts: '2026-07-16T01:00:00.000Z', type: 'turn_started', session_id: sessionId }),
    JSON.stringify({ ts: '2026-07-16T01:00:05.000Z', type: 'first_token' }),
    JSON.stringify({ ts: '2026-07-16T01:00:10.000Z', type: 'turn_ended', outcome: 'completed' }),
  ].join('\n') + '\n');

  const prev = process.env.VIBE_USAGE_GROK_SESSIONS;
  process.env.VIBE_USAGE_GROK_SESSIONS = sessionsDir;
  try {
    const result = await parse();
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].project, 'awesome-repo');
    assert.equal(result.sessions[0].source, 'grok');
    assert.equal(result.buckets.length, 0);
  } finally {
    if (prev !== undefined) process.env.VIBE_USAGE_GROK_SESSIONS = prev;
    else delete process.env.VIBE_USAGE_GROK_SESSIONS;
    rmSync(root, { recursive: true, force: true });
  }
});

test('parse merges configured Grok homes and keeps the more complete copy of a session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-grok-multi-root-'));
  const primaryHome = join(root, 'primary');
  const extraHome = join(root, 'extra');

  const writeSession = (home, sessionId, turns) => {
    const sessionPath = join(home, 'sessions', 'project', sessionId);
    mkdirSync(sessionPath, { recursive: true });
    writeFileSync(join(sessionPath, 'summary.json'), JSON.stringify({
      info: { id: sessionId, cwd: '/work/project' },
      current_model_id: 'grok-test',
    }));
    const lines = [];
    for (let index = 0; index < turns; index += 1) {
      lines.push(JSON.stringify({
        timestamp: 1784168190 + index * 10,
        params: { update: { sessionUpdate: 'user_message_chunk' } },
      }));
      lines.push(JSON.stringify({
        timestamp: 1784168195 + index * 10,
        params: { update: {
          sessionUpdate: 'turn_completed',
          usage: { inputTokens: 10, outputTokens: 2 },
        } },
      }));
    }
    writeFileSync(join(sessionPath, 'updates.jsonl'), `${lines.join('\n')}\n`);
  };

  writeSession(primaryHome, 'copied-session', 1);
  writeSession(primaryHome, 'primary-only', 1);
  writeSession(extraHome, 'copied-session', 2);
  writeSession(extraHome, 'extra-only', 1);

  const previousHome = process.env.GROK_HOME;
  const previousFixture = process.env.VIBE_USAGE_GROK_SESSIONS;
  process.env.GROK_HOME = primaryHome;
  delete process.env.VIBE_USAGE_GROK_SESSIONS;
  try {
    const result = await parse({ extraRoots: [extraHome] });
    assert.equal(result.sessions.length, 3);
    assert.equal(result.buckets.reduce((sum, bucket) => sum + bucket.inputTokens, 0), 40);
    assert.equal(result.buckets.reduce((sum, bucket) => sum + bucket.outputTokens, 0), 8);
  } finally {
    if (previousHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousHome;
    if (previousFixture === undefined) delete process.env.VIBE_USAGE_GROK_SESSIONS;
    else process.env.VIBE_USAGE_GROK_SESSIONS = previousFixture;
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing configured Grok home skips the source to protect upload state', async () => {
  const missing = join(tmpdir(), 'vibe-usage-grok-missing-root');
  const result = await parse({ extraRoots: [missing] });
  assert.equal(result.skipped, true);
  assert.deepEqual(result.buckets, []);
  assert.match(result.warnings[0], /额外根目录不可用/);
});
