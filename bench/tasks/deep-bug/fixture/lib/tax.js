import { percentOf, sum } from './money.js';

/** Sales tax rates by tax class, in percent. */
export const RATES = {
  standard: 7.25,
  reduced: 2.5,
  food: 1.0,
  exempt: 0,
};

/** Tax for one line: the line total times its class rate, rounded to the cent. */
export function lineTax(lineCents, taxClass) {
  const rate = RATES[taxClass];
  if (rate === undefined) throw new Error(`Unknown tax class: ${taxClass}`);
  return percentOf(lineCents, rate);
}

/** Tax for a list of lines; each line is taxed and rounded on its own, as printed invoices show. */
export function invoiceTax(lines) {
  return sum(lines.map((line) => lineTax(line.cents, line.taxClass)));
}
