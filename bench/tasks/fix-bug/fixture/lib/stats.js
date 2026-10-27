/** Returns a sorted copy of the values, smallest first. */
export function sorted(values) {
  return [...values].sort();
}

export function mean(values) {
  if (values.length === 0) throw new RangeError('mean() needs at least one value');
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values) {
  if (values.length === 0) throw new RangeError('median() needs at least one value');
  const ordered = sorted(values);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

/** Nearest-rank percentile: the smallest value with at least p% of all values at or below it. */
export function percentile(values, p) {
  if (values.length === 0) throw new RangeError('percentile() needs at least one value');
  if (!(p > 0 && p <= 100)) throw new RangeError('p must be greater than 0 and at most 100');
  const ordered = sorted(values);
  return ordered[Math.ceil((p / 100) * ordered.length) - 1];
}

export function summarize(values) {
  const ordered = sorted(values);
  return {
    min: ordered[0],
    max: ordered[ordered.length - 1],
    mean: mean(values),
    median: median(values),
    p90: percentile(values, 90),
  };
}
