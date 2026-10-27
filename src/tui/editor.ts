import { emitKeypressEvents } from 'node:readline';
import type { Theme } from './theme.js';
import { visibleWidth } from './text.js';

export interface Key {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export type EditorAction =
  | 'none'
  | 'submit'
  | 'interrupt'
  | 'escape'
  | 'exit'
  | 'cycle-mode'
  | 'complete'
  | 'clear-screen'
  | 'history';

/** Decode key presses with a short escape timeout so Esc responds immediately. */
export function listenForKeys(stream: NodeJS.ReadStream): void {
  // Node reads `escapeCodeTimeout` from the optional interface argument.
  emitKeypressEvents(stream, { escapeCodeTimeout: 50 } as unknown as Parameters<
    typeof emitKeypressEvents
  >[1]);
}

const PASTE_INLINE_CHARS = 800;
const PASTE_INLINE_LINES = 6;

function previous(text: string, index: number): number {
  if (index <= 0) return 0;
  const code = text.charCodeAt(index - 1);
  return code >= 0xdc00 && code <= 0xdfff && index >= 2 ? index - 2 : index - 1;
}

function next(text: string, index: number): number {
  if (index >= text.length) return text.length;
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff ? index + 2 : index + 1;
}

function wordStart(text: string, index: number): number {
  let at = index;
  while (at > 0 && /\s/.test(text[at - 1]!)) at--;
  while (at > 0 && !/\s/.test(text[at - 1]!)) at--;
  return at;
}

function wordEnd(text: string, index: number): number {
  let at = index;
  while (at < text.length && /\s/.test(text[at]!)) at++;
  while (at < text.length && !/\s/.test(text[at]!)) at++;
  return at;
}

/** Split text into rows of at most `width` columns, keeping every character in order. */
export function wrapCharacters(text: string, width: number): string[] {
  const rows: string[] = [];
  let row = '';
  let used = 0;
  for (const character of text) {
    const size = visibleWidth(character);
    if (used + size > width && row) {
      rows.push(row);
      row = '';
      used = 0;
    }
    row += character;
    used += size;
  }
  rows.push(row);
  return rows;
}

/** Multiline prompt editing as a pure state machine: keys in, actions and a render out. */
export class LineEditor {
  text = '';
  cursor = 0;
  private history: string[];
  private historyIndex: number;
  private draft = '';
  private pasting = false;
  private pasted = '';
  private pastes = new Map<string, string>();

  constructor(history: string[] = []) {
    this.history = [...history];
    this.historyIndex = this.history.length;
  }

  set(text: string): void {
    this.text = text;
    this.cursor = text.length;
  }

  clear(): void {
    this.set('');
    this.pastes.clear();
    this.historyIndex = this.history.length;
  }

  /** Text to send: collapsed pastes are expanded back to their content. */
  value(): string {
    let value = this.text;
    // A function replacement keeps `$` sequences in pasted text literal.
    for (const [token, content] of this.pastes) value = value.replace(token, () => content);
    return value;
  }

  remember(entry: string): void {
    if (entry.trim() && this.history.at(-1) !== entry) this.history.push(entry);
    this.historyIndex = this.history.length;
  }

  insert(value: string): void {
    this.text = this.text.slice(0, this.cursor) + value + this.text.slice(this.cursor);
    this.cursor += value.length;
  }

  private finishPaste(): void {
    this.pasting = false;
    const content = this.pasted.replace(/\r\n?/g, '\n');
    this.pasted = '';
    const lines = content.split('\n').length;
    if (content.length <= PASTE_INLINE_CHARS && lines <= PASTE_INLINE_LINES) {
      this.insert(content);
      return;
    }
    const token = `[Pasted text #${this.pastes.size + 1} · ${lines} line${lines === 1 ? '' : 's'}]`;
    this.pastes.set(token, content);
    this.insert(token);
  }

  private lineBounds(): { start: number; end: number } {
    const start = this.text.lastIndexOf('\n', this.cursor - 1) + 1;
    const newline = this.text.indexOf('\n', this.cursor);
    return { start, end: newline < 0 ? this.text.length : newline };
  }

  private moveVertical(direction: -1 | 1): boolean {
    const { start, end } = this.lineBounds();
    const column = this.cursor - start;
    if (direction < 0) {
      if (start === 0) return false;
      const previousStart = this.text.lastIndexOf('\n', start - 2) + 1;
      this.cursor = Math.min(previousStart + column, start - 1);
    } else {
      if (end === this.text.length) return false;
      const nextEnd = this.text.indexOf('\n', end + 1);
      this.cursor = Math.min(end + 1 + column, nextEnd < 0 ? this.text.length : nextEnd);
    }
    return true;
  }

  private browse(direction: -1 | 1): void {
    const target = this.historyIndex + direction;
    if (target < 0 || target > this.history.length) return;
    if (this.historyIndex === this.history.length) this.draft = this.text;
    this.historyIndex = target;
    this.set(target === this.history.length ? this.draft : this.history[target]!);
  }

  handle(input: string | undefined, key: Key = {}): EditorAction {
    if (key.name === 'paste-start') {
      this.pasting = true;
      this.pasted = '';
      return 'none';
    }
    if (key.name === 'paste-end') {
      this.finishPaste();
      return 'none';
    }
    if (this.pasting) {
      this.pasted += key.name === 'return' || key.name === 'enter' ? '\n' : (input ?? '');
      return 'none';
    }
    const { ctrl, meta } = key;
    switch (key.name) {
      case 'return':
        if (meta) {
          this.insert('\n');
          return 'none';
        }
        if (this.text.slice(0, this.cursor).endsWith('\\')) {
          this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
          this.cursor--;
          this.insert('\n');
          return 'none';
        }
        return 'submit';
      case 'enter':
        this.insert('\n');
        return 'none';
      case 'tab':
        return key.shift ? 'cycle-mode' : 'complete';
      case 'escape':
        return 'escape';
      case 'backspace':
        if (meta || ctrl) {
          const start = wordStart(this.text, this.cursor);
          this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
          this.cursor = start;
        } else if (this.cursor > 0) {
          const start = previous(this.text, this.cursor);
          this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
          this.cursor = start;
        }
        return 'none';
      case 'delete':
        this.text = this.text.slice(0, this.cursor) + this.text.slice(next(this.text, this.cursor));
        return 'none';
      case 'left':
        this.cursor =
          meta || ctrl ? wordStart(this.text, this.cursor) : previous(this.text, this.cursor);
        return 'none';
      case 'right':
        this.cursor = meta || ctrl ? wordEnd(this.text, this.cursor) : next(this.text, this.cursor);
        return 'none';
      case 'home':
        this.cursor = this.lineBounds().start;
        return 'none';
      case 'end':
        this.cursor = this.lineBounds().end;
        return 'none';
      case 'up':
        if (!this.moveVertical(-1)) this.browse(-1);
        return 'history';
      case 'down':
        if (!this.moveVertical(1)) this.browse(1);
        return 'history';
    }
    if (key.sequence === '\u001b[13;2u') {
      this.insert('\n');
      return 'none';
    }
    if (ctrl) {
      switch (key.name) {
        case 'c':
          return 'interrupt';
        case 'd':
          if (!this.text) return 'exit';
          this.text =
            this.text.slice(0, this.cursor) + this.text.slice(next(this.text, this.cursor));
          return 'none';
        case 'a':
          this.cursor = this.lineBounds().start;
          return 'none';
        case 'e':
          this.cursor = this.lineBounds().end;
          return 'none';
        case 'b':
          this.cursor = previous(this.text, this.cursor);
          return 'none';
        case 'f':
          this.cursor = next(this.text, this.cursor);
          return 'none';
        case 'u': {
          const { start } = this.lineBounds();
          this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
          this.cursor = start;
          return 'none';
        }
        case 'k': {
          const { end } = this.lineBounds();
          this.text = this.text.slice(0, this.cursor) + this.text.slice(end);
          return 'none';
        }
        case 'w': {
          const start = wordStart(this.text, this.cursor);
          this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
          this.cursor = start;
          return 'none';
        }
        case 'l':
          return 'clear-screen';
        case 'j':
          this.insert('\n');
          return 'none';
      }
      return 'none';
    }
    if (meta) {
      if (key.name === 'b') this.cursor = wordStart(this.text, this.cursor);
      else if (key.name === 'f') this.cursor = wordEnd(this.text, this.cursor);
      else if (key.name === 'd')
        this.text =
          this.text.slice(0, this.cursor) + this.text.slice(wordEnd(this.text, this.cursor));
      return 'none';
    }
    if (input && [...input].every((character) => character >= ' ' && character !== '\u007f'))
      this.insert(input);
    return 'none';
  }

  /** Rows for the input band, with the cursor position inside them. */
  render(
    width: number,
    theme: Theme,
    options: { prompt?: string; placeholder?: string } = {},
  ): { lines: string[]; cursorRow: number; cursorColumn: number } {
    const prompt = options.prompt ?? '› ';
    const indent = ' '.repeat(visibleWidth(prompt));
    const room = Math.max(4, width - visibleWidth(prompt) - 1);
    const lines: string[] = [];
    let cursorRow = 0;
    let cursorColumn = visibleWidth(prompt);
    if (!this.text) {
      lines.push(prompt + theme.muted(options.placeholder ?? ''));
    } else {
      let offset = 0;
      for (const [index, logical] of this.text.split('\n').entries()) {
        const rows = wrapCharacters(logical, room);
        let consumed = 0;
        for (const [rowIndex, row] of rows.entries()) {
          const lead = index === 0 && rowIndex === 0 ? prompt : indent;
          const start = offset + consumed;
          const end = start + row.length;
          const last = rowIndex === rows.length - 1;
          if (this.cursor >= start && (this.cursor < end || (last && this.cursor <= end))) {
            cursorRow = lines.length;
            cursorColumn = visibleWidth(lead) + visibleWidth(this.text.slice(start, this.cursor));
          }
          lines.push(lead + row);
          consumed += row.length;
        }
        offset += logical.length + 1;
      }
    }
    // A tinted band marks the input area instead of a drawn box.
    const band = lines.map((line) =>
      theme.surface(line + ' '.repeat(Math.max(0, width - visibleWidth(line)))),
    );
    return { lines: band, cursorRow, cursorColumn };
  }
}
