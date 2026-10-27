import { findProduct } from './catalog.js';
import { format, percentOf, sum } from './money.js';
import { invoiceTax } from './tax.js';

/**
 * Build an invoice from order items ({ sku, quantity }) and an optional discount in percent,
 * applied to each line before tax.
 */
export function buildInvoice(items, { discountPercent = 0 } = {}) {
  const lines = items.map(({ sku, quantity }) => {
    const product = findProduct(sku);
    if (!product) throw new Error(`Unknown product: ${sku}`);
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error(`Invalid quantity for ${sku}`);
    const gross = product.priceCents * quantity;
    const discount = discountPercent ? percentOf(gross, discountPercent) : 0;
    return {
      sku,
      name: product.name,
      quantity,
      unitCents: product.priceCents,
      cents: gross - discount,
      discountCents: discount,
      taxClass: product.taxClass,
    };
  });
  const subtotal = sum(lines.map((line) => line.cents));
  const tax = invoiceTax(lines);
  return { lines, subtotal, tax, total: subtotal + tax };
}

/** Plain-text invoice for emails and receipts. */
export function renderInvoice(invoice) {
  const rows = invoice.lines.map(
    (line) => `${line.quantity} x ${line.name}`.padEnd(40) + format(line.cents).padStart(12),
  );
  return [
    ...rows,
    'Subtotal'.padEnd(40) + format(invoice.subtotal).padStart(12),
    'Tax'.padEnd(40) + format(invoice.tax).padStart(12),
    'Total'.padEnd(40) + format(invoice.total).padStart(12),
  ].join('\n');
}
