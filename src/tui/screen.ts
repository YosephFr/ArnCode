import { rowsFor } from './text.js';

export interface TerminalStream {
  write(text: string): unknown;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

const SYNC_START = '\u001b[?2026h';
const SYNC_END = '\u001b[?2026l';

/**
 * Append-only scrollback with one live region at the bottom. Permanent output is written above
 * the region; the region (preview, spinner, input and status) is erased and redrawn in place.
 */
export class Screen {
  private lines: string[] = [];
  private cursor?: { row: number; column: number };
  /** Physical row of the terminal cursor inside the drawn region. */
  private cursorRow = 0;
  private drawn = false;

  constructor(
    private readonly ui: TerminalStream,
    private readonly content: TerminalStream = ui,
  ) {}

  get width(): number {
    return Math.max(20, this.ui.columns || 80);
  }

  private get height(): number {
    return Math.max(4, this.ui.rows || 24);
  }

  /** Replace the live region. `cursor` is a row of `lines` and a column within it. */
  set(lines: string[], cursor?: { row: number; column: number }): void {
    this.lines = lines;
    this.cursor = cursor;
    this.ui.write(SYNC_START + this.erase() + this.draw() + SYNC_END);
  }

  /** Write permanent text above the live region. */
  print(text: string, stream: 'ui' | 'content' = 'ui'): void {
    if (!text) return;
    const target = stream === 'content' ? this.content : this.ui;
    this.ui.write(SYNC_START + this.erase());
    target.write(text);
    this.ui.write(this.draw() + SYNC_END);
  }

  /** Remove the live region, leaving the cursor where permanent output continues. */
  clear(): void {
    this.ui.write(this.erase());
    this.lines = [];
    this.cursor = undefined;
  }

  private erase(): string {
    if (!this.drawn) return '';
    this.drawn = false;
    const up = this.cursorRow > 0 ? `\u001b[${this.cursorRow}A` : '';
    this.cursorRow = 0;
    return `${up}\r\u001b[0J`;
  }

  private draw(): string {
    if (!this.lines.length) return '';
    const width = this.width;
    // Keep the region within the screen so it can always be erased; drop the oldest rows first.
    let lines = this.lines;
    let cursor = this.cursor;
    while (
      lines.length > 1 &&
      lines.reduce((sum, line) => sum + rowsFor(line, width), 0) > this.height - 1
    ) {
      lines = lines.slice(1);
      if (cursor) cursor = { ...cursor, row: cursor.row - 1 };
    }
    const rows = lines.map((line) => rowsFor(line, width));
    const total = rows.reduce((sum, count) => sum + count, 0);
    let output = lines.join('\r\n');
    this.drawn = true;
    if (!cursor || cursor.row < 0) {
      this.cursorRow = total - 1;
      return output;
    }
    const before = rows.slice(0, cursor.row).reduce((sum, count) => sum + count, 0);
    const target = before + Math.floor(cursor.column / width);
    const column = cursor.column % width;
    const up = total - 1 - target;
    if (up > 0) output += `\u001b[${up}A`;
    output += `\r${column ? `\u001b[${column}C` : ''}`;
    this.cursorRow = target;
    return output;
  }
}
