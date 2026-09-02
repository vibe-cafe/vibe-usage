import test from 'node:test';
import assert from 'node:assert/strict';
import * as cursor from '../src/parsers/cursor.js';

test('Cursor fetch timeout accepts positive integers and defaults invalid values', () => {
  assert.equal(typeof cursor.resolveCursorFetchTimeout, 'function');

  const cases = [
    [undefined, 30_000],
    ['', 30_000],
    ['0', 30_000],
    ['-1', 30_000],
    ['1.5', 30_000],
    ['Infinity', 30_000],
    ['2147483648', 30_000],
    ['45000', 45_000],
  ];

  for (const [value, expected] of cases) {
    assert.equal(cursor.resolveCursorFetchTimeout(value), expected);
  }
});
