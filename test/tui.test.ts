import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { InteractiveApp } from '../src/tui/app.js';
import { LineEditor, wrapCharacters } from '../src/tui/editor.js';
import { Screen } from '../src/tui/screen.js';
import { SelectMenu } from '../src/tui/select.js';
import { createTheme } from '../src/tui/theme.js';

const plain = createTheme('plain', false);

function type(editor: LineEditor, text: string) {
  for (const character of text) editor.handle(character, { name: character });
}

describe('line editor', () => {
  it('edits, moves by words and submits on Enter', () => {
    const editor = new LineEditor();
    type(editor, 'fix the bug');
    editor.handle(undefined, { name: 'left', meta: true });
    editor.handle(undefined, { name: 'backspace', ctrl: true });
    expect(editor.text).toBe('fix bug');
    editor.handle(undefined, { name: 'end' });
    expect(editor.handle('\r', { name: 'return' })).toBe('submit');
  });

  it('inserts newlines with Alt+Enter, Ctrl+J and a trailing backslash', () => {
    const editor = new LineEditor();
    type(editor, 'one');
    editor.handle(undefined, { name: 'return', meta: true });
    type(editor, 'two\\');
    expect(editor.handle('\r', { name: 'return' })).toBe('none');
    editor.handle('\n', { name: 'enter' });
    expect(editor.text).toBe('one\ntwo\n\n');
  });

  it('collapses large pastes and expands them on submit', () => {
    const editor = new LineEditor();
    const pasted = Array.from({ length: 12 }, (_, index) => `line ${index}`);
    editor.handle(undefined, { name: 'paste-start' });
    for (const [index, line] of pasted.entries()) {
      type(editor, line);
      if (index < pasted.length - 1) editor.handle('\r', { name: 'return' });
    }
    editor.handle(undefined, { name: 'paste-end' });
    expect(editor.text).toBe('[Pasted text #1 · 12 lines]');
    type(editor, ' explain');
    expect(editor.value()).toBe(`${pasted.join('\n')} explain`);
  });

  it('walks history and restores the draft', () => {
    const editor = new LineEditor(['first', 'second']);
    type(editor, 'draft');
    editor.handle(undefined, { name: 'up' });
    expect(editor.text).toBe('second');
    editor.handle(undefined, { name: 'up' });
    expect(editor.text).toBe('first');
    editor.handle(undefined, { name: 'down' });
    editor.handle(undefined, { name: 'down' });
    expect(editor.text).toBe('draft');
  });

  it('maps the cursor through wrapped and multiline input', () => {
    expect(wrapCharacters('abcdefg', 3)).toEqual(['abc', 'def', 'g']);
    expect(wrapCharacters('漢字かな', 4)).toEqual(['漢字', 'かな']);
    const editor = new LineEditor();
    editor.set('abcdefghij\nxy');
    editor.cursor = 7;
    const rendered = editor.render(10, plain);
    expect(rendered.lines.map((line) => line.trimEnd())).toEqual(['› abcdefg', '  hij', '  xy']);
    // At a wrap boundary the cursor sits before the next character, on the next row.
    expect(rendered).toMatchObject({ cursorRow: 1, cursorColumn: 2 });
    editor.cursor = 6;
    expect(editor.render(10, plain)).toMatchObject({ cursorRow: 0, cursorColumn: 8 });
    editor.cursor = 8;
    expect(editor.render(10, plain)).toMatchObject({ cursorRow: 1, cursorColumn: 3 });
  });

  it('reports interrupt, escape, exit and mode keys to the app', () => {
    const editor = new LineEditor();
    expect(editor.handle('\u0003', { name: 'c', ctrl: true })).toBe('interrupt');
    expect(editor.handle(undefined, { name: 'escape' })).toBe('escape');
    expect(editor.handle(undefined, { name: 'tab', shift: true })).toBe('cycle-mode');
    expect(editor.handle(undefined, { name: 'd', ctrl: true })).toBe('exit');
  });
});

describe('screen', () => {
  it('erases the previous live region before printing above it', () => {
    let output = '';
    const screen = new Screen({ write: (text: string) => (output += text), columns: 20, rows: 10 });
    screen.set(['status', '› input'], { row: 1, column: 4 });
    output = '';
    screen.print('done\n');
    expect(output).toContain('\u001b[1A\r\u001b[0J');
    expect(output).toContain('done\n');
    expect(output.endsWith('status\r\n› input\r\u001b[4C\u001b[?2026l')).toBe(true);
  });

  it('keeps a tall region within the screen height', () => {
    let output = '';
    const screen = new Screen({ write: (text: string) => (output += text), columns: 20, rows: 4 });
    screen.set(['1', '2', '3', '4', '5']);
    expect(output).not.toContain('1\r\n2');
    expect(output).toContain('3\r\n4\r\n5');
  });
});

describe('select menu', () => {
  it('chooses with arrows, numbers or letters, and cancels with Esc', () => {
    const menu = () =>
      new SelectMenu('Allow?', [
        { label: 'Yes', value: 'y', key: 'y' },
        { label: 'No', value: 'n', key: 'n' },
      ]);
    const arrows = menu();
    arrows.handle(undefined, { name: 'down' });
    expect(arrows.handle('\r', { name: 'return' })).toEqual({ done: true, value: 'n' });
    expect(menu().handle('2', { name: '2' })).toEqual({ done: true, value: 'n' });
    expect(menu().handle('y', { name: 'y' })).toEqual({ done: true, value: 'y' });
    expect(menu().handle(undefined, { name: 'escape' })).toEqual({ done: true, value: undefined });
  });
});

describe('interactive app', () => {
  function setup() {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: vi.fn(),
    }) as unknown as NodeJS.ReadStream;
    const handlers = { onInterrupt: vi.fn(), onCycleMode: vi.fn(), onExit: vi.fn() };
    const app = new InteractiveApp({
      stdin,
      ui: { write: () => true, columns: 60, rows: 20 },
      content: { write: () => true },
      theme: plain,
      status: () => 'status',
      ...handlers,
    });
    app.start();
    const key = (input: string | undefined, name: string, extra: object = {}) =>
      stdin.emit('keypress', input, { name, ...extra });
    return { app, key, ...handlers };
  }

  it('queues prompts typed while busy and interrupts with Esc', async () => {
    const { app, key, onInterrupt } = setup();
    const first = app.nextPrompt();
    for (const character of 'one') key(character, character);
    key('\r', 'return');
    expect(await first).toBe('one');
    app.setBusy('Thinking');
    for (const character of 'two') key(character, character);
    key('\r', 'return');
    expect(app.queued).toBe(1);
    key(undefined, 'escape');
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    app.setBusy(undefined);
    expect(await app.nextPrompt()).toBe('two');
    app.stop();
  });

  it('clears input on Ctrl+C and exits on a second press', () => {
    const { app, key, onExit } = setup();
    key('a', 'a');
    key('\u0003', 'c', { ctrl: true });
    expect(app.editor.text).toBe('');
    key('\u0003', 'c', { ctrl: true });
    expect(onExit).not.toHaveBeenCalled();
    key('\u0003', 'c', { ctrl: true });
    expect(onExit).toHaveBeenCalledTimes(1);
    app.stop();
  });
});
