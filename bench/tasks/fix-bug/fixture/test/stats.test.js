import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mean, median, percentile, summarize } from '../lib/stats.js';

const latencies = [120, 95, 300, 87, 1500];

test('mean averages the values', () => {
  assert.equal(mean([2, 4, 9]), 5);
});

test('median of an odd count is the middle value', () => {
  assert.equal(median([7, 1, 3]), 3);
});

test('median of an even count averages the middle pair', () => {
  assert.equal(median([200, 8, 30, 10]), 20);
});

test('percentile uses the nearest rank', () => {
  assert.equal(percentile([5, 1, 4, 2, 3], 40), 2);
  assert.equal(percentile(latencies, 90), 1500);
});

test('summarize reports the range and the middle of the data', () => {
  assert.deepEqual(summarize(latencies), {
    min: 87,
    max: 1500,
    mean: 420.4,
    median: 120,
    p90: 1500,
  });
});

test('empty input is rejected', () => {
  assert.throws(() => median([]), RangeError);
});
