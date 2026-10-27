import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildInvoice, renderInvoice } from '../lib/invoice.js';

test('a single standard-rate line', () => {
  const invoice = buildInvoice([{ sku: 'SKU-1042', quantity: 1 }]);
  assert.equal(invoice.subtotal, 1999);
  // 7.25% of $19.99 is 144.93 cents, which rounds to $1.45.
  assert.equal(invoice.tax, 145);
  assert.equal(invoice.total, 2144);
});

test('lines are taxed one by one at their own rates', () => {
  const invoice = buildInvoice([
    { sku: 'SKU-1042', quantity: 2 },
    { sku: 'SKU-1150', quantity: 3 },
  ]);
  assert.equal(invoice.subtotal, 2 * 1999 + 3 * 1349);
  // 289.855 cents (standard) rounds to 290; 40.47 cents (food) rounds to 40.
  assert.equal(invoice.tax, 290 + 40);
});

test('discounts apply before tax', () => {
  const invoice = buildInvoice([{ sku: 'SKU-1212', quantity: 1 }], { discountPercent: 15 });
  // 15% of $89.99 is 1349.85 cents, so the discount is $13.50 and the line is $76.49.
  assert.equal(invoice.lines[0].discountCents, 1350);
  assert.equal(invoice.subtotal, 7649);
  assert.equal(invoice.tax, 555);
});

test('rendered invoices list every line and the totals', () => {
  const text = renderInvoice(buildInvoice([{ sku: 'SKU-1042', quantity: 1 }]));
  assert.match(text, /1 x Studio Desk Lamp\s+\$19\.99/);
  assert.match(text, /Total\s+\$21\.44/);
});

test('unknown products are rejected', () => {
  assert.throws(() => buildInvoice([{ sku: 'SKU-0000', quantity: 1 }]), /Unknown product/);
});
