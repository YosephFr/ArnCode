import { stripVTControlCharacters } from 'node:util';
import pc from 'picocolors';
import type { Theme } from './theme.js';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

export interface MarkdownStyle {
  strong(text: string): string;
  /** Inline code. */
  code(text: string): string;
  heading(text: string, level: number): string;
  link(text: string, url: string): string;
  /** Quotes and list markers. */
  muted(text: string): string;
  /** One highlighted line of a fenced block; pads to `width` for a background band. */
  codeLine(line: string, width: number): string;
  keyword(text: string): string;
  string(text: string): string;
  comment(text: string): string;
  number(text: string): string;
}

type Colors = ReturnType<typeof pc.createColors>;
type Align = 'left' | 'center' | 'right';

interface ListItem {
  /** Source indentation of the marker. */
  indent: number;
  /** Output column where the item's text starts. */
  content: number;
}

interface Fence {
  marker: string;
  indent: number;
  depth: number;
  pad: number;
  language: string;
  /** Inside a block comment that continues on the next line. */
  comment: boolean;
}

interface Table {
  depth: number;
  pad: number;
  rows: string[][];
  aligns: Align[];
}

interface State {
  fence?: Fence;
  /** A row that becomes a table header if a delimiter row follows. */
  header?: { depth: number; pad: number; text: string };
  table?: Table;
  lists: ListItem[];
  /** Blockquote depth of the previous line. */
  depth: number;
  /** The last row was blank, so another blank row is dropped. */
  blank: boolean;
}

const TAB = 4;
const QUOTE = /^ {0,3}> ?/;
const RULE = /^([-*_])(?: *\1){2,} *$/;
const FENCE = /^(?:(`{3,})([^`]*)|(~{3,})(.*))$/;
const HEADING = /^(#{1,6})(?: +(.*?))?(?: +#+)? *$/;
const ITEM = /^([-*+]|\d{1,9}[.)])(?: +(.*))?$/;
const TASK = /^\[([ xX])\](?: +|$)/;
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const SPACE = /\s/;
const DESTINATION =
  /\(\s*(?:<([^<>]*)>|((?:\\.|[^\s()\\]|\((?:\\.|[^\s()\\])*\))*))(?:\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^()\\])*\)))?\s*\)/y;
const AUTOLINK = /<(?:([A-Za-z][\w+.-]{1,31}:[^\s<>]*)|([\w.+-]+@[\w-]+(?:\.[\w-]+)+))>/y;
const BARE_URL = /(?:https?:\/\/|www\.)[^\s<]+/y;
const ENTITY = /&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/y;
const ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
]);

/** Show a link's target after its text unless the text already is the target. */
function linkText(
  text: string,
  url: string,
  label: (text: string) => string,
  muted: (text: string) => string,
): string {
  const bare = (value: string) => value.replace(/^(?:mailto:|https?:\/\/)/i, '').replace(/\/$/, '');
  if (!url || bare(stripVTControlCharacters(text)) === bare(url)) return label(text);
  return `${label(text)} ${muted(`(${url})`)}`;
}

export function plainStyle(): MarkdownStyle {
  const same = (text: string) => text;
  return {
    strong: same,
    code: same,
    heading: same,
    link: (text, url) => linkText(text, url, same, same),
    muted: same,
    codeLine: same,
    keyword: same,
    string: same,
    comment: same,
    number: same,
  };
}

/** Markdown styled with ArnCode's theme: code sits on the theme's tonal surface. */
export function themeStyle(theme: Theme): MarkdownStyle {
  if (!theme.color) return plainStyle();
  const colors = pc.createColors(true);
  return {
    ...colorStyle(colors),
    code: theme.accent,
    muted: theme.muted,
    strong: theme.strong,
    heading: theme.strong,
    // Bright and yellow text washes out on light backgrounds.
    ...(theme.name === 'light' ? { keyword: colors.magenta, number: colors.blue } : {}),
    codeLine: (line, width) =>
      theme.surface(line + ' '.repeat(Math.max(0, width - stringWidth(line)))),
  };
}

export function colorStyle(colors: Colors): MarkdownStyle {
  if (!colors.isColorSupported) return plainStyle();
  return {
    strong: colors.bold,
    code: colors.cyan,
    heading: colors.bold,
    link: (text, url) => linkText(text, url, colors.underline, colors.dim),
    muted: colors.dim,
    // A black band with light text stays readable on dark and light palettes.
    codeLine: (line, width) =>
      colors.bgBlack(colors.white(line + ' '.repeat(Math.max(0, width - stringWidth(line))))),
    keyword: colors.magentaBright,
    string: colors.green,
    comment: colors.gray,
    number: colors.yellow,
  };
}

/** Strip escape sequences and control characters from model text and expand tabs. */
function clean(line: string): string {
  let text = '';
  let column = 0;
  for (const char of stripVTControlCharacters(line)) {
    const code = char.codePointAt(0)!;
    if (char === '\t') {
      const spaces = TAB - (column % TAB);
      text += ' '.repeat(spaces);
      column += spaces;
    } else if (code >= 0x20 && (code < 0x7f || code > 0x9f)) {
      text += char;
      column += code < 0x7f ? 1 : stringWidth(char);
    }
  }
  return text;
}

interface Grammar {
  names: string;
  keywords: Set<string>;
  comment: RegExp;
  /** C-style block comments, the only highlighting state that carries across lines. */
  block: boolean;
  /** An unclosed string runs to the end of the line. */
  string: RegExp;
  word: RegExp;
}

const words = (list: string) => new Set(list.split(' '));
const IDENTIFIER = /[A-Za-z_]\w*/y;
const NUMBER = /(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)[A-Za-z\d]*/y;
const SLASHES = /\/\//y;

const grammars = new Map(
  (
    [
      {
        names: 'js javascript jsx mjs cjs ts typescript tsx mts cts',
        keywords: words(
          'as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function if implements import in instanceof interface keyof let namespace new null of private protected public readonly return satisfies static super switch this throw true try type typeof undefined var void while with yield any bigint boolean never number object string symbol unknown',
        ),
        comment: SLASHES,
        block: true,
        string: /"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?/y,
        word: /[A-Za-z_$][\w$]*/y,
      },
      {
        names: 'py python python3',
        keywords: words(
          'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield',
        ),
        comment: /#/y,
        block: false,
        string: /"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?/y,
        word: IDENTIFIER,
      },
      {
        names: 'sh bash shell zsh console',
        keywords: words(
          'if then else elif fi case esac for select while until do done in function return exit export local readonly declare unset break continue',
        ),
        // Only a `#` that starts a word opens a comment, so `$#` stays code.
        comment: /(?<!\S)#/y,
        block: false,
        string: /"(?:\\.|[^"\\])*"?|'[^']*'?/y,
        // Flags and paths are single words, so `--if-exists` holds no keyword.
        word: /[A-Za-z_][\w./-]*/y,
      },
      {
        names: 'json jsonc json5',
        keywords: words('true false null'),
        comment: SLASHES,
        block: true,
        string: /"(?:\\.|[^"\\])*"?/y,
        word: IDENTIFIER,
      },
      {
        names: 'go golang',
        keywords: words(
          'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota',
        ),
        comment: SLASHES,
        block: true,
        string: /"(?:\\.|[^"\\])*"?|`[^`]*`?|'(?:\\.|[^'\\])*'?/y,
        word: IDENTIFIER,
      },
      {
        names: 'rs rust',
        keywords: words(
          'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
        ),
        comment: SLASHES,
        block: true,
        // A quote opens a char literal only when it closes right away; otherwise it is a lifetime.
        string: /"(?:\\.|[^"\\])*"?|'(?:\\[^']+|[^'\\])'/y,
        word: IDENTIFIER,
      },
    ] satisfies Grammar[]
  ).flatMap((grammar) => grammar.names.split(' ').map((name) => [name, grammar] as const)),
);

/** Highlight one line; `comment` says whether it starts inside a block comment. */
function scan(
  line: string,
  grammar: Grammar | undefined,
  style: MarkdownStyle,
  comment: boolean,
): { text: string; comment: boolean } {
  if (!grammar) return { text: line, comment: false };
  let text = '';
  let index = 0;
  const take = (pattern: RegExp) => {
    pattern.lastIndex = index;
    return pattern.exec(line)?.[0];
  };
  // Index after the `*/` that closes a block comment, or -1 when it runs past this line.
  const finish = (from: number) => {
    const end = line.indexOf('*/', from);
    return end < 0 ? -1 : end + 2;
  };
  if (comment) {
    const end = finish(0);
    if (end < 0) return { text: line && style.comment(line), comment: true };
    text = style.comment(line.slice(0, end));
    index = end;
  }
  while (index < line.length) {
    if (grammar.block && line.startsWith('/*', index)) {
      const end = finish(index + 2);
      text += style.comment(line.slice(index, end < 0 ? undefined : end));
      if (end < 0) return { text, comment: true };
      index = end;
    } else if (take(grammar.comment)) {
      text += style.comment(line.slice(index));
      break;
    } else {
      const string = take(grammar.string);
      const word = string ? undefined : take(grammar.word);
      const number = string || word ? undefined : take(NUMBER);
      if (string) text += style.string(string);
      else if (word) text += grammar.keywords.has(word) ? style.keyword(word) : word;
      else if (number) text += style.number(number);
      else text += line.charAt(index);
      index += (string ?? word ?? number ?? ' ').length;
    }
  }
  return { text, comment: false };
}

/** Highlight one line of code; unknown languages come back plain. */
export function highlight(code: string, language: string, style: MarkdownStyle): string {
  return scan(clean(code), grammars.get(language.toLowerCase()), style, false).text;
}

function runLength(text: string, index: number): number {
  let end = index;
  while (text[end] === text[index]) end++;
  return end - index;
}

/** End of the code span opening at `index`, or of its backtick run when nothing closes it. */
function skipCode(text: string, index: number): number {
  const size = runLength(text, index);
  for (let close = text.indexOf('`', index + size); close >= 0;) {
    const length = runLength(text, close);
    if (length === size) return close + size;
    close = text.indexOf('`', close + length);
  }
  return index + size;
}

/** CommonMark flanking rules, which keep `2 * 3`, snake_case and `*args` literal. */
function flanking(text: string, index: number, size: number, opening: boolean): boolean {
  const before = text[index - 1] ?? ' ';
  const after = text[index + size] ?? ' ';
  const [inner, outer] = opening ? [after, before] : [before, after];
  const boundary = SPACE.test(outer) || PUNCTUATION.test(outer);
  if (SPACE.test(inner) || (PUNCTUATION.test(inner) && !boundary)) return false;
  return text[index] === '*' || boundary;
}

function emphasis(
  text: string,
  start: number,
): { inner: string; end: number; strong: boolean } | undefined {
  const marker = text[start];
  const size = runLength(text, start);
  if (size > 3 || !flanking(text, start, size, true)) return undefined;
  for (let index = start + size; index < text.length;) {
    const char = text[index];
    if (char === '\\') index += 2;
    else if (char === '`') index = skipCode(text, index);
    else if (char !== marker) index++;
    else {
      const length = runLength(text, index);
      if (length === size && flanking(text, index, length, false)) {
        return { inner: text.slice(start + size, index), end: index + size, strong: size > 1 };
      }
      index += length;
    }
  }
  return undefined;
}

function link(
  text: string,
  start: number,
): { label: string; url: string; end: number } | undefined {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (char === '\\') index++;
    else if (char === '`') index = skipCode(text, index) - 1;
    else if (char === '[') depth++;
    else if (char === ']' && --depth === 0) {
      DESTINATION.lastIndex = index + 1;
      const match = DESTINATION.exec(text);
      if (!match) return undefined;
      const url = (match[1] ?? match[2] ?? '').replace(/\\([!-/:-@[-`{-~])/g, '$1');
      return { label: text.slice(start + 1, index), url, end: DESTINATION.lastIndex };
    }
  }
  return undefined;
}

/** A bare URL without the punctuation that ends its sentence or the paren that wraps it. */
function bareUrl(text: string, index: number): string | undefined {
  BARE_URL.lastIndex = index;
  let url = BARE_URL.exec(text)?.[0] ?? '';
  for (;;) {
    url = url.replace(/[?!.,:;*_~'"]+$/, '');
    const close = url.at(-1);
    const open = close === ')' ? '(' : close === ']' ? '[' : undefined;
    if (!open || url.split(open).length >= url.split(close!).length) break;
    url = url.slice(0, -1);
  }
  return /^(?:https?:\/\/|www\.)[\w-]/.test(url) ? url : undefined;
}

function entity(match: RegExpExecArray): string {
  if (match[3]) return ENTITIES.get(match[3]) ?? match[0];
  const code = match[1] ? Number(match[1]) : Number.parseInt(match[2]!, 16);
  const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
  return control || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
    ? '\ufffd'
    : String.fromCodePoint(code);
}

/** Inline Markdown: code, strong, links and autolinks; emphasis keeps its text and drops its markers. */
function inline(text: string, style: MarkdownStyle, links = true): string {
  let out = '';
  for (let index = 0; index < text.length;) {
    const char = text[index]!;
    const next = text[index + 1] ?? '';
    if (char === '\\' && ESCAPABLE.test(next)) {
      out += next;
      index += 2;
      continue;
    }
    if (char === '`') {
      const end = skipCode(text, index);
      const size = runLength(text, index);
      if (end === index + size) out += text.slice(index, end);
      else {
        const code = text.slice(index + size, end - size);
        const padded = code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim();
        out += style.code(padded ? code.slice(1, -1) : code);
      }
      index = end;
      continue;
    }
    if (char === '*' || char === '_') {
      const span = emphasis(text, index);
      const end = span?.end ?? index + runLength(text, index);
      if (!span) out += text.slice(index, end);
      else {
        const inner = inline(span.inner, style, links);
        out += span.strong ? style.strong(inner) : inner;
      }
      index = end;
      continue;
    }
    if (links && (char === '[' || (char === '!' && next === '['))) {
      const found = link(text, char === '!' ? index + 1 : index);
      if (found) {
        out += style.link(inline(found.label, style, false) || found.url, found.url);
        index = found.end;
        continue;
      }
    }
    if (links && char === '<') {
      AUTOLINK.lastIndex = index;
      const match = AUTOLINK.exec(text);
      if (match) {
        const target = match[1] ?? match[2]!;
        out += style.link(target, match[1] ? target : `mailto:${target}`);
        index = AUTOLINK.lastIndex;
        continue;
      }
    }
    if (links && (char === 'h' || char === 'w') && !/[\p{L}\p{N}]/u.test(text[index - 1] ?? '')) {
      const url = bareUrl(text, index);
      if (url) {
        out += style.link(url, url.startsWith('www.') ? `http://${url}` : url);
        index += url.length;
        continue;
      }
    }
    if (char === '&') {
      ENTITY.lastIndex = index;
      const match = ENTITY.exec(text);
      if (match) {
        out += entity(match);
        index = ENTITY.lastIndex;
        continue;
      }
    }
    out += char;
    index++;
  }
  return out;
}

/** Table cells, split on pipes that are neither escaped nor inside code. */
function splitRow(row: string): string[] {
  const text = row
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < text.length;) {
    const char = text[index]!;
    if (char === '\\' && text[index + 1] === '|') {
      cell += '|';
      index += 2;
    } else if (char === '`') {
      const end = skipCode(text, index);
      cell += text.slice(index, end).replaceAll('\\|', '|');
      index = end;
    } else {
      if (char === '|') {
        cells.push(cell.trim());
        cell = '';
      } else cell += char;
      index++;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isRow(text: string): boolean {
  const line = text.trim();
  if (!line.includes('|') || HEADING.test(line) || FENCE.test(line) || ITEM.test(line))
    return false;
  return line.startsWith('|') || splitRow(line).length > 1;
}

function delimiterRow(text: string, columns: number): Align[] | undefined {
  if (!text.includes('|')) return undefined;
  const cells = splitRow(text);
  if (cells.length !== columns || !cells.every((cell) => /^:?-+:?$/.test(cell))) return undefined;
  return cells.map((cell) =>
    cell.endsWith(':') ? (cell.startsWith(':') ? 'center' : 'right') : 'left',
  );
}

/** Shrink the widest columns first until the row fits; narrow columns keep their width. */
function fitColumns(natural: number[], room: number): number[] {
  const total = (cap: number) => natural.reduce((sum, width) => sum + Math.min(width, cap), 0);
  if (total(Infinity) <= room) return natural;
  let cap = 1;
  for (let high = Math.max(...natural); cap < high;) {
    const middle = Math.ceil((cap + high) / 2);
    if (total(middle) <= room) cap = middle;
    else high = middle - 1;
  }
  let spare = room - total(cap);
  return natural.map((width) => {
    if (width <= cap || spare <= 0) return Math.min(width, cap);
    spare--;
    return cap + 1;
  });
}

function align(text: string, width: number, alignment: Align): string {
  const space = Math.max(0, width - stringWidth(text));
  const left = alignment === 'right' ? space : alignment === 'center' ? space >> 1 : 0;
  return ' '.repeat(left) + text + ' '.repeat(space - left);
}

/** Blockquote depth and the text inside the markers. */
function unquote(line: string): { depth: number; content: string } {
  let depth = 0;
  let content = line;
  for (let marker = QUOTE.exec(content); marker; marker = QUOTE.exec(content)) {
    depth++;
    content = content.slice(marker[0].length);
  }
  return { depth, content };
}

function fresh(): State {
  return { lists: [], depth: 0, blank: true };
}

/**
 * Renders streamed Markdown line by line. Complete lines come back as rows to print for good;
 * `preview()` renders the unfinished line and anything still buffered for the live area.
 */
export class MarkdownStream {
  private state = fresh();

  constructor(
    private readonly style: MarkdownStyle,
    private readonly width: () => number,
  ) {}

  /** Feed one complete source line; returns the rows to print now (none while a table builds). */
  line(source: string): string[] {
    const out: string[] = [];
    for (const line of source.replace(/\r?\n$/, '').split('\n')) this.feed(clean(line), out);
    return out;
  }

  /** Rows for the unfinished line and any buffered table, joined by newlines; state is untouched. */
  preview(partial: string): string {
    const draft = new MarkdownStream(this.style, this.width);
    draft.state = structuredClone(this.state);
    return [...(partial.trim() ? draft.line(partial) : []), ...draft.end()].join('\n');
  }

  /** Flush a buffered table at the end of a message and reset for the next one. */
  end(): string[] {
    const out: string[] = [];
    const { header, table } = this.state;
    if (header) this.emit(out, this.paragraph(header.text, header.pad, header.depth));
    if (table) this.emit(out, this.renderTable(table));
    this.state = fresh();
    return out;
  }

  private feed(line: string, out: string[]): void {
    const state = this.state;
    if (state.fence) {
      this.code(line, state.fence, out);
      return;
    }
    const { depth, content } = unquote(line);
    const { header, table } = state;
    if (header) {
      state.header = undefined;
      const cells = splitRow(header.text);
      const aligns = depth === header.depth ? delimiterRow(content, cells.length) : undefined;
      if (aligns) {
        state.table = { depth, pad: header.pad, rows: [cells], aligns };
        return;
      }
      this.emit(out, this.paragraph(header.text, header.pad, header.depth));
    }
    if (table) {
      if (depth === table.depth && isRow(content)) {
        table.rows.push(splitRow(content));
        return;
      }
      state.table = undefined;
      this.emit(out, this.renderTable(table));
    }
    this.block(depth, content, out);
  }

  private block(depth: number, content: string, out: string[]): void {
    const state = this.state;
    if (depth !== state.depth) {
      state.depth = depth;
      state.lists = [];
    }
    const indent = /^ */.exec(content)![0].length;
    const text = content.slice(indent).trimEnd();
    if (!text) {
      this.emit(out, ['']);
      return;
    }
    const item = RULE.test(text) ? null : ITEM.exec(text);
    if (item) {
      this.item(indent, item[1]!, item[2] ?? '', depth, out);
      return;
    }
    const pad = this.padFor(indent, depth);
    const fence = FENCE.exec(text);
    const heading = HEADING.exec(text);
    if (RULE.test(text)) this.emit(out, ['']);
    else if (fence) {
      const info = (fence[2] ?? fence[4] ?? '').trim();
      const language = info.split(' ')[0]!.toLowerCase();
      state.fence = { marker: fence[1] ?? fence[3]!, indent, depth, pad, language, comment: false };
    } else if (heading) {
      const title = inline(heading[2] ?? '', this.style);
      const level = heading[1]!.length;
      this.emit(out, title ? this.wrap(this.style.heading(title, level), pad, depth > 0) : ['']);
    } else if (isRow(text)) state.header = { depth, pad, text };
    else this.emit(out, this.paragraph(text, pad, depth));
  }

  private item(indent: number, marker: string, body: string, depth: number, out: string[]): void {
    const { lists } = this.state;
    while (lists.length && lists.at(-1)!.indent >= indent) lists.pop();
    const task = TASK.exec(body);
    // Matches the agent's checklist; the filled dot marks tool calls.
    const box = task ? (task[1] === ' ' ? '○' : '✓') : '';
    const symbol = /\d/.test(marker) ? `${marker}${box && ` ${box}`}` : box || '•';
    const lead = 2 * depth + 2 * lists.length;
    const content = lead + stringWidth(symbol) + 1;
    lists.push({ indent, content });
    const first = ' '.repeat(lead) + this.style.muted(symbol);
    const text = inline(task ? body.slice(task[0].length) : body, this.style);
    this.emit(out, text ? this.wrap(text, content, depth > 0, `${first} `) : [first]);
  }

  /** Output indentation for a line: under the list item it belongs to, else its own indent. */
  private padFor(indent: number, depth: number): number {
    const { lists } = this.state;
    for (let index = lists.length - 1; indent > 0 && index >= 0; index--) {
      if (lists[index]!.indent < indent) return lists[index]!.content;
    }
    lists.length = 0;
    return 2 * depth + indent;
  }

  private code(source: string, fence: Fence, out: string[]): void {
    let line = source;
    for (let level = 0; level < fence.depth; level++) line = line.replace(QUOTE, '');
    const close = /^ *(`{3,}|~{3,}) *$/.exec(line)?.[1];
    if (close && close[0] === fence.marker[0] && close.length >= fence.marker.length) {
      this.state.fence = undefined;
      return;
    }
    line = line.slice(Math.min(fence.indent, /^ */.exec(line)![0].length));
    const scanned = scan(line, grammars.get(fence.language), this.style, fence.comment);
    fence.comment = scanned.comment;
    const room = Math.max(1, this.columns() - fence.pad);
    const rows = wrapAnsi(scanned.text, Math.max(1, room - 2), {
      hard: true,
      trim: false,
      wordWrap: false,
    }).split('\n');
    this.emit(
      out,
      rows.map((row) => ' '.repeat(fence.pad) + this.style.codeLine(` ${row}`, room)),
    );
  }

  private renderTable({ depth, pad, rows, aligns }: Table): string[] {
    const cells = rows.map((row, index) =>
      aligns.map((_, column) => {
        const text = inline(row[column] ?? '', this.style);
        return index === 0 && text ? this.style.strong(text) : text;
      }),
    );
    const widths = fitColumns(
      aligns.map((_, column) => Math.max(1, ...cells.map((row) => stringWidth(row[column]!)))),
      this.columns() - pad - 2 * (aligns.length - 1),
    );
    return cells.flatMap((row) => {
      const lines = row.map((cell, column) =>
        wrapAnsi(cell, widths[column]!, { hard: true }).split('\n'),
      );
      return Array.from({ length: Math.max(...lines.map((cell) => cell.length)) }, (_, line) => {
        const text = lines
          .map((cell, column) => align(cell[line] ?? '', widths[column]!, aligns[column]!))
          .join('  ')
          .replace(/ +$/, '');
        return ' '.repeat(pad) + (depth > 0 ? this.style.muted(text) : text);
      });
    });
  }

  private paragraph(text: string, pad: number, depth: number): string[] {
    return this.wrap(inline(text, this.style), pad, depth > 0);
  }

  /** Wrap to the width; the first row starts with `first`, the rest are indented by `pad`. */
  private wrap(text: string, pad: number, muted: boolean, first = ' '.repeat(pad)): string[] {
    return wrapAnsi(text, Math.max(1, this.columns() - pad), { hard: true })
      .split('\n')
      .map(
        (row, index) => (index ? ' '.repeat(pad) : first) + (muted ? this.style.muted(row) : row),
      );
  }

  private emit(out: string[], rows: string[]): void {
    for (const row of rows) {
      if (!row && this.state.blank) continue;
      this.state.blank = !row;
      out.push(row);
    }
  }

  private columns(): number {
    return Math.max(1, Math.floor(this.width()) || 80);
  }
}
