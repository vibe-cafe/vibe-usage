// Codex model time (algorithm 8, approved 2026-11-25): a reply runs from the
// latest boundary (task start, user message, tool result) to the usage record
// counted for it, within 30 s + output / 20 per second. Tool runs, waits for a
// sub-agent and idle time between tasks are not counted -- before algorithm 8
// a Codex session counted nearly its whole lifetime (494 hours for one
// conversation reopened over three weeks on the maintainer's Mac).
import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from '../src/parsers/codex.js';
import { roundToHalfHour } from '../src/parsers/aggregate.js';

const previousCindyDirs = process.env.VIBE_USAGE_CINDY_DIRS;
process.env.VIBE_USAGE_CINDY_DIRS = join(tmpdir(), 'vibe-usage-cindy-disabled');
test.after(() => {
  if (previousCindyDirs === undefined) delete process.env.VIBE_USAGE_CINDY_DIRS;
  else process.env.VIBE_USAGE_CINDY_DIRS = previousCindyDirs;
});

const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const at = seconds => new Date(T0 + seconds * 1000).toISOString();

function meta(seconds, id, extra = {}) {
  return { timestamp: at(seconds), type: 'session_meta', payload: { id, cwd: '/Users/x/proj', timestamp: at(seconds), ...extra } };
}
const event = (seconds, type, extra = {}) => ({ timestamp: at(seconds), type: 'event_msg', payload: { type, ...extra } });
const item = (seconds, payload) => ({ timestamp: at(seconds), type: 'response_item', payload });
const turnContext = seconds => ({ timestamp: at(seconds), type: 'turn_context', payload: { model: 'gpt-5.5' } });

let threadTotal = 0;
function usageRecord(seconds, output) {
  const usage = { input_tokens: 1000, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: 1000 + output };
  threadTotal += usage.total_tokens;
  return {
    timestamp: at(seconds),
    type: 'token_usage_record',
    payload: { usage, thread_token_usage: { ...usage, total_tokens: threadTotal }, response_id: `resp-${seconds}` },
  };
}

// `linkedHome`: a second Codex home holding hard links of every rollout, as
// Orca keeps one per account -- its sessions are read through the copy merge.
async function parseRollouts(files, { linkedHome = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-codex-model-time-'));
  const dir = join(root, 'sessions', '2026', '11', '20');
  mkdirSync(dir, { recursive: true });
  const linkedDir = join(root, 'orca-home', 'sessions', '2026', '11', '20');
  if (linkedHome) mkdirSync(linkedDir, { recursive: true });
  for (const [name, records] of Object.entries(files)) {
    writeFileSync(join(dir, name), records.map(r => JSON.stringify(r)).join('\n') + '\n');
    if (linkedHome) linkSync(join(dir, name), join(linkedDir, name));
  }
  const previous = { home: process.env.CODEX_HOME, cache: process.env.VIBE_USAGE_CACHE_DIR };
  process.env.CODEX_HOME = root;
  process.env.VIBE_USAGE_CACHE_DIR = join(root, 'cache');
  try {
    return await parse(linkedHome ? { extraRoots: [join(root, 'orca-home')] } : {});
  } finally {
    if (previous.home === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous.home;
    if (previous.cache === undefined) delete process.env.VIBE_USAGE_CACHE_DIR;
    else process.env.VIBE_USAGE_CACHE_DIR = previous.cache;
    rmSync(root, { recursive: true, force: true });
  }
}

test('tool runs and the idle time between tasks are not model time', async () => {
  // The record order of a current Codex build (seen on the maintainer's Mac):
  // the next task's settings and start come before its turn_context.
  const records = [
    meta(0, 'session-1'),
    event(0, 'task_started'),
    item(0.05, { type: 'message', role: 'user', content: [] }),
    turnContext(0.05),
    item(4.8, { type: 'message', role: 'assistant', content: [] }),
    item(14.4, { type: 'custom_tool_call', name: 'exec' }),
    usageRecord(14.5, 448),                       // reply 1: 0.05 → 14.5 s
    item(41.5, { type: 'custom_tool_call_output' }), // the tool ran 27 s
    item(45.1, { type: 'message', role: 'assistant', content: [] }),
    usageRecord(45.15, 4),                        // reply 2: 41.5 → 45.15 s
    event(45.2, 'task_complete'),
    // Two hours later, the conversation is reopened.
    event(7200, 'thread_settings_applied', { thread_settings: { model: 'gpt-5.5' } }),
    event(7200.01, 'task_started'),
    item(7201, { type: 'message', role: 'user', content: [] }),
    turnContext(7201),
    usageRecord(7300, 100),                       // waited 99 s: capped at 30 + 100 / 20 = 35 s
    event(7300.1, 'task_complete'),
  ];
  const { sessions } = await parseRollouts({ 'rollout-2026-11-20T10-00-00-session-1.jsonl': records });
  assert.equal(sessions.length, 1);
  const [session] = sessions;
  assert.equal(session.durationSeconds, 7300);
  assert.equal(session.activeSeconds, Math.round(14.45 + 3.65 + 35));
  const cells = new Map(session.activity.map(([bucket, ...row]) => [bucket, row]));
  const first = roundToHalfHour(new Date(T0)).toISOString();
  const later = roundToHalfHour(new Date(T0 + 7265_000)).toISOString();
  assert.deepEqual([...cells.keys()].sort(), [first, later].sort());
  assert.equal(cells.get(first).reduce((a, b) => a + b, 0), Math.round(14.45) + Math.round(3.65));
  assert.equal(cells.get(later).reduce((a, b) => a + b, 0), 35);
});

test('a parent waiting for its sub-agent is not model time; the sub-agent counts its own replies', async () => {
  const parent = [
    meta(0, 'parent-1'),
    event(0, 'task_started'),
    item(0.1, { type: 'message', role: 'user', content: [] }),
    item(4, { type: 'function_call', name: 'spawn_agent' }),
    usageRecord(5, 50),                            // 0.1 → 5 s
    item(600, { type: 'function_call_output' }),   // the sub-agent worked for ten minutes
    item(602, { type: 'message', role: 'assistant', content: [] }),
    usageRecord(603, 20),                          // 600 → 603 s
    event(603.1, 'task_complete'),
  ];
  const child = [
    meta(6, 'child-1', { parent_thread_id: 'parent-1', thread_source: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: 'parent-1' } } } }),
    event(6, 'task_started'),
    item(6.5, { type: 'function_call', name: 'exec' }),
    usageRecord(7, 30),                            // 6 → 7 s
    item(300, { type: 'function_call_output' }),
    usageRecord(320, 400),                         // 300 → 320 s
    event(320.1, 'task_complete'),
  ];
  const { sessions } = await parseRollouts({
    'rollout-2026-11-20T10-00-00-parent-1.jsonl': parent,
    'rollout-2026-11-20T10-00-06-child-1.jsonl': child,
  });
  const byDuration = [...sessions].sort((a, b) => b.durationSeconds - a.durationSeconds);
  assert.equal(byDuration.length, 2);
  assert.equal(byDuration[0].activeSeconds, Math.round(4.9 + 3));
  assert.equal(byDuration[1].activeSeconds, 1 + 20);
});

test('copies of one session are timed like a single file: continuation segments and linked homes', async () => {
  // The copy merge keeps only what accounting reads; a reply's boundaries (a
  // user message, a tool's output) must survive it, or the tool's run counts.
  const records = () => [
    meta(0, 'segmented-1'),
    event(0, 'task_started'),
    item(0.1, { type: 'message', role: 'user', content: [] }),
    turnContext(0.1),
    item(4, { type: 'function_call', name: 'exec' }),
    usageRecord(5.1, 100),                         // 0.1 → 5.1 s
    item(30, { type: 'function_call_output' }),    // the tool ran 25 s
    item(32.5, { type: 'message', role: 'assistant', content: [] }),
    usageRecord(33, 20),                           // 30 → 33 s
    event(33.1, 'task_complete'),
  ];
  const activeOf = ({ sessions }) => {
    assert.equal(sessions.length, 1);
    return sessions[0].activeSeconds;
  };
  const name = 'rollout-2026-11-20T10-00-00-segmented-1.jsonl';
  assert.equal(activeOf(await parseRollouts({ [name]: records() })), 5 + 3);
  const all = records();
  assert.equal(activeOf(await parseRollouts({
    [name]: all.slice(0, 6),
    // Codex continues a resumed conversation in a new file that repeats the header.
    'rollout-2026-11-20T10-00-20-segmented-1.jsonl': [all[0], ...all.slice(6)],
  })), 5 + 3);
  assert.equal(activeOf(await parseRollouts({ [name]: records() }, { linkedHome: true })), 5 + 3);
});
