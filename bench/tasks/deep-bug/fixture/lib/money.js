// Amounts are whole cents. Fractions of a cent round to the nearest cent, and exact halves
// round to the even cent so that long invoices do not drift upward.

export function roundHalfEven(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (Math.abs(fraction - 0.5) > 1e-9) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

export function toCents(amount) {
  return roundHalfEven(amount * 100);
}

export function percentOf(cents, percent) {
  return Math.floor((cents * percent) / 100);
}

export function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

export function format(cents, currency = 'USD') {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100).toLocaleString('en-US');
  const fraction = String(absolute % 100).padStart(2, '0');
  return `${sign}${currency === 'USD' ? '$' : `${currency} `}${whole}.${fraction}`;
}
