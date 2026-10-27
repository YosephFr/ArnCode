import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const money = await import(pathToFileURL(path.join(process.cwd(), 'lib/money.js')).href);
const tax = await import(pathToFileURL(path.join(process.cwd(), 'lib/tax.js')).href);

test('percentages round to the nearest cent', () => {
  assert.equal(money.percentOf(1999, 7.25), 145);
  assert.equal(money.percentOf(1000, 0.04), 0);
  assert.equal(money.percentOf(1000, 0.06), 1);
});

test('exact halves round to the even cent', () => {
  assert.equal(money.percentOf(125, 10), 12);
  assert.equal(money.percentOf(135, 10), 14);
});

test('credits round symmetrically', () => {
  assert.equal(money.percentOf(-1999, 7.25), -145);
});

test('tax stays exact for whole cents', () => {
  assert.equal(tax.lineTax(10000, 'standard'), 725);
  assert.equal(tax.lineTax(10000, 'exempt'), 0);
});
