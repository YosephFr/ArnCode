import { stripVTControlCharacters } from 'node:util';
import pc from 'picocolors';
import { describe, expect, it } from 'vitest';
import { MarkdownStream, colorStyle, highlight, plainStyle } from '../src/tui/markdown.js';

const colors = pc.createColors(true);

function render(source: string, width = 60, style = plainStyle()): string[] {
  const stream = new MarkdownStream(style, () => width);
  const rows = source.split('\n').flatMap((line) => stream.line(line));
  return [...rows, ...stream.end()].map((row) => stripVTControlCharacters(row));
}

describe('streaming Markdown', () => {
  it('drops heading markers, keeps emphasis text without markers and styles strong text', () => {
    expect(render('## Plan\nUse *care* and **force**, but keep 2 * 3 and snake_case.')).toEqual([
      'Plan',
      'Use care and force, but keep 2 * 3 and snake_case.',
    ]);
    const styled = new MarkdownStream(colorStyle(colors), () => 60).line('a **b** `c`')[0]!;
    expect(styled).toContain('\u001b[1mb');
    expect(styled).not.toContain('\u001b[3m');
  });

  it('renders lists, task lists, quotes, links and rules', () => {
    expect(
      render(
        '- one\n  - nested\n1. first\n- [ ] todo\n- [x] done\n> quoted\nSee [docs](https://x.dev/a)\n\n---\nend',
      ),
    ).toEqual([
      '• one',
      '  • nested',
      '1. first',
      '○ todo',
      '● done',
      '  quoted',
      'See docs (https://x.dev/a)',
      '',
      'end',
    ]);
  });

  it('renders fenced code across line calls and flushes an unterminated fence', () => {
    const stream = new MarkdownStream(plainStyle(), () => 40);
    expect(stream.line('```ts')).toEqual([]);
    expect(stream.line('const x = 1; // note')).toEqual([' const x = 1; // note']);
    expect(stream.line('```')).toEqual([]);
    expect(stream.line('after')).toEqual(['after']);
    expect(render('```\nopen code')).toEqual([' open code']);
    expect(
      stripVTControlCharacters(highlight('const a = "b"; // c', 'ts', colorStyle(colors))),
    ).toBe('const a = "b"; // c');
    expect(highlight('return 1', 'ts', colorStyle(colors))).toContain('\u001b[');
  });

  it('buffers tables until they end, aligns columns and wraps when too wide', () => {
    const stream = new MarkdownStream(plainStyle(), () => 40);
    expect(stream.line('| Name | Size |')).toEqual([]);
    expect(stream.line('| --- | ---: |')).toEqual([]);
    expect(stream.line('| a | 1 |')).toEqual([]);
    expect(stream.line('| bbb | 22 |').length).toBe(0);
    expect(stream.line('done')).toEqual(['Name  Size', 'a        1', 'bbb     22', 'done']);
    const wide = render(
      '| Column | Notes |\n| --- | --- |\n| x | a long cell that has to wrap onto more lines |',
      24,
    );
    expect(wide.every((row) => row.length <= 24)).toBe(true);
    expect(wide.length).toBeGreaterThan(2);
    expect(render('| a | b |\n|---|---|\n| 1 | 2 |')).toEqual(['a  b', '1  2']);
  });

  it('previews an unfinished line without changing the stream', () => {
    const stream = new MarkdownStream(plainStyle(), () => 40);
    stream.line('| a | b |');
    stream.line('|---|---|');
    expect(stripVTControlCharacters(stream.preview('**bold'))).toBe('a  b\n**bold');
    expect(stream.line('| 1 | 2 |')).toEqual([]);
    expect(stream.end()).toEqual(['a  b', '1  2']);
  });

  it('follows width changes and never emits escape codes in plain style', () => {
    let width = 20;
    const stream = new MarkdownStream(plainStyle(), () => width);
    const text = 'word '.repeat(12).trim();
    expect(stream.line(text).every((row) => row.length <= 20)).toBe(true);
    width = 60;
    expect(stream.line(text)).toHaveLength(1);
    const plain = render('# T\n**b** `c` [l](https://e.x)\n```js\nlet a = 1\n```');
    expect(plain.join('\n')).not.toContain('\u001b');
    expect(render('evil \u001b[31mred\u001b[0m text')).toEqual(['evil red text']);
  });
});
