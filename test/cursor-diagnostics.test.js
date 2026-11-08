import test from 'node:test';
import assert from 'node:assert/strict';
import { applyParserInfos } from '../src/sync.js';

function captureWarnings(t) {
  const warnings = [];
  t.mock.method(process.stderr, 'write', (chunk) => {
    warnings.push(String(chunk));
    return true;
  });
  return warnings;
}

test('the first Cursor account observation is recorded without a warning', (t) => {
  const warnings = captureWarnings(t);
  const state = { buckets: {}, sessions: {} };
  const changed = applyParserInfos(state, [{
    source: 'cursor',
    info: { account: 'github|user…A1B2', latestEventAt: '2026-10-19T09:00:00.000Z', events: 10, tokenEvents: 9 },
  }]);
  assert.equal(changed, true);
  assert.deepEqual(state.parserMeta.cursor, {
    account: 'github|user…A1B2',
    latestEventAt: '2026-10-19T09:00:00.000Z',
    events: 10,
    tokenEvents: 9,
  });
  assert.deepEqual(warnings, []);
});

test('a Cursor account change is reported and replaces the recorded account', (t) => {
  const warnings = captureWarnings(t);
  const state = {
    buckets: {},
    sessions: {},
    parserMeta: { cursor: { account: 'github|user…OLD1', latestEventAt: '2026-10-19T09:00:00.000Z', events: 10, tokenEvents: 9 } },
  };
  applyParserInfos(state, [{
    source: 'cursor',
    info: { account: 'x|user…NEW2', latestEventAt: '2026-10-23T01:00:00.000Z', events: 4, tokenEvents: 4 },
  }]);
  assert.equal(state.parserMeta.cursor.account, 'x|user…NEW2');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /登录账号已从 github\|user…OLD1 更换为 x\|user…NEW2/);
});

test('Cursor data moving backwards warns that the old account may still be signed in', (t) => {
  const warnings = captureWarnings(t);
  const state = {
    buckets: {},
    sessions: {},
    parserMeta: { cursor: { account: 'github|user…A1B2', latestEventAt: '2026-10-23T01:00:00.000Z', events: 10, tokenEvents: 9 } },
  };
  applyParserInfos(state, [{
    source: 'cursor',
    info: { account: 'github|user…A1B2', latestEventAt: '2026-10-19T09:00:00.000Z', events: 10, tokenEvents: 9 },
  }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /最新事件从 2026-10-23T01:00:00.000Z 回退到 2026-10-19T09:00:00.000Z/);
});

test('Cursor counts dropping to zero stay quiet (an idle week, not a lost export)', (t) => {
  const warnings = captureWarnings(t);
  const state = {
    buckets: {},
    sessions: {},
    parserMeta: { cursor: { account: 'x|user…NEW2', latestEventAt: '2026-10-23T01:00:00.000Z', events: 10, tokenEvents: 9 } },
  };
  applyParserInfos(state, [{
    source: 'cursor',
    info: { account: 'x|user…NEW2', latestEventAt: '2026-10-23T01:00:00.000Z', events: 0, tokenEvents: 0 },
  }]);
  assert.deepEqual(warnings, []);
  assert.equal(state.parserMeta.cursor.events, 0);
});
