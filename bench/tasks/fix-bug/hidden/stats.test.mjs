// Probes whether the fix is general rather than tuned to the visible suite. Runs with the work
// directory as the current directory.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const { median, percentile, summarize } = await import(
  pathToFileURL(path.resolve('lib/stats.js')).href
);

test('negative values sort numerically', () => {
  assert.equal(median([-2, -10, -30]), -10);
});

test('decimals sort numerically', () => {
  assert.equal(percentile([0.5, 0.25, 10, 2], 75), 2);
});

test('summarize handles values of different lengths', () => {
  assert.deepEqual(summarize([1000, 999, 10]), {
    min: 10,
    max: 1000,
    mean: 2009 / 3,
    median: 999,
    p90: 1000,
  });
});

test('the input array is left untouched', () => {
  const values = [30, 4, 200];
  median(values);
  summarize(values);
  assert.deepEqual(values, [30, 4, 200]);
});
