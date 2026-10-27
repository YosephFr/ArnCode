import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

export function visibleWidth(text: string): number {
  return stringWidth(text);
}

/** Wrap styled text to the terminal width; long words break so nothing overflows. */
export function wrapText(text: string, width: number): string[] {
  return wrapAnsi(text, Math.max(1, width), { hard: true, trim: false }).split('\n');
}

/** Cut styled text to one row, ending with an ellipsis when something was cut. */
export function fitWidth(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  const [first = ''] = wrapAnsi(text, Math.max(1, width - 1), { hard: true, trim: false }).split(
    '\n',
  );
  return `${first}\u001b[0m…`;
}

/** Pad styled text with spaces to exactly `width` visible columns. */
export function padVisible(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)));
}

/** Rows a line occupies once the terminal wraps it. */
export function rowsFor(text: string, width: number): number {
  return Math.max(1, Math.ceil(visibleWidth(text) / Math.max(1, width)));
}

export function compactNumber(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function duration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
