// One test per rule in SPEC.md. Runs with the work directory as the current directory.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const { expandRanges } = await import(pathToFileURL(path.resolve('src/ranges.js')).href);

test('pages and ranges', () => {
  assert.deepEqual(expandRanges('1,3-5,8'), [1, 3, 4, 5, 8]);
  assert.deepEqual(expandRanges('2'), [2]);
});

test('leading zeros', () => {
  assert.deepEqual(expandRanges('007,010-011'), [7, 10, 11]);
});

test('spaces and tabs around items and hyphens', () => {
  assert.deepEqual(expandRanges(' 2 - 4 ,\t7 '), [2, 3, 4, 7]);
});

test('backwards ranges', () => {
  assert.deepEqual(expandRanges('5-3'), [3, 4, 5]);
});

test('ascending without duplicates', () => {
  assert.deepEqual(expandRanges('9,3,1-3,3'), [1, 2, 3, 9]);
});

test('empty input', () => {
  assert.deepEqual(expandRanges(''), []);
  assert.deepEqual(expandRanges(' \t '), []);
});

test('invalid items throw a RangeError naming the item', () => {
  const cases = [
    ['1,,2', ''],
    ['1,', ''],
    ['0', '0'],
    ['-2', '-2'],
    ['1.5', '1.5'],
    ['2-', '2-'],
    ['1-2-3', '1-2-3'],
    ['3, x7 ,4', 'x7'],
    ['1, 2 ,0-3', '0-3'],
  ];
  for (const [input, item] of cases) {
    assert.throws(
      () => expandRanges(input),
      (error) => error instanceof RangeError && error.message.includes(item),
      `expandRanges(${JSON.stringify(input)})`,
    );
  }
});

test('at most 10,000 pages', () => {
  assert.equal(expandRanges('1-10000').length, 10_000);
  assert.equal(expandRanges('1-6000,1-6000').length, 6000);
  assert.throws(() => expandRanges('1-10001'), RangeError);
  assert.throws(() => expandRanges('1-6000,5001-11000'), RangeError);
});
