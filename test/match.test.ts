import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchEdit, nearbyLines, omissionPlaceholders } from '../src/tools/match.js';
import { ToolRunner } from '../src/tools/index.js';

let project: string;
beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'arncode-edit-'));
});
afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

function apply(source: string, oldString: string, newString: string): string {
  const { matches, replace } = matchEdit(source, oldString, newString);
  expect(matches).toHaveLength(1);
  const [match] = matches;
  return source.slice(0, match!.start) + replace(match!) + source.slice(match!.end);
}

const quiet = {
  text: () => {},
  endText: () => {},
  status: () => {},
  idle: () => {},
  notice: () => {},
  progress: () => {},
  tool: () => {},
  diff: () => {},
};

describe('edit matching', () => {
  it('edits CRLF files from the LF view and keeps their endings', () => {
    const source = 'one\r\ntwo\r\nthree\r\n';
    expect(apply(source, 'two\nthree', 'TWO\nTHREE\nfour')).toBe('one\r\nTWO\r\nTHREE\r\nfour\r\n');
  });

  it('keeps the bytes of unchanged lines in mixed-ending files', () => {
    const source = 'a\r\nb\nc\r\nd\n';
    expect(apply(source, 'b\nc\nd', 'b\nC\nd')).toBe('a\r\nb\nC\r\nd\n');
  });

  it('falls back to typographic variants, then trailing whitespace', () => {
    const quotes = matchEdit('say(“hi”) — ok\n', 'say("hi") - ok', 'say("hello") - ok');
    expect(quotes.tier).toBe('typography');
    expect(quotes.matches).toHaveLength(1);
    const spaces = matchEdit('if (x) {   \n  run();\t\n}\n', 'if (x) {\n  run();\n}', 'run();');
    expect(spaces.tier).toBe('trailing-whitespace');
    expect(spaces.matches).toHaveLength(1);
    expect(matchEdit('exact text', 'exact', 'other').tier).toBe('exact');
  });

  it('applies edits that only change line endings to the exact bytes', () => {
    expect(apply('one\r\ntwo\r\n', 'one\r\ntwo\r\n', 'one\ntwo\n')).toBe('one\ntwo\n');
  });

  it('detects placeholders that stand in for omitted code', () => {
    expect(
      omissionPlaceholders(
        'function a() {\n  // rest of code ...\n}\n# ... existing code here ...',
      ),
    ).toEqual(['// rest of code ...', '# ... existing code here ...']);
    expect(omissionPlaceholders('const rest = items.slice(1); // rest of the list')).toEqual([]);
  });

  it('points to where the first searched line appears', () => {
    expect(nearbyLines('x\nconst value = 1;\ny\n', 'const value = 1;\nmissing line')).toEqual([2]);
    expect(nearbyLines('x\n', '}\n')).toEqual([]);
  });
});

describe('edit_file', () => {
  async function edit(content: string, input: Record<string, unknown>) {
    await writeFile(path.join(project, 'file.txt'), content);
    const runner = new ToolRunner({
      cwd: project,
      approve: async () => ({ allowed: true }),
      ui: quiet,
    });
    const result = await runner.run('edit_file', { path: 'file.txt', ...input });
    return { result, after: await readFile(path.join(project, 'file.txt'), 'utf8') };
  }

  it('reports how a tolerant match was found', async () => {
    const { result, after } = await edit('value = 1;   \nnext\n', {
      old_string: 'value = 1;\nnext',
      new_string: 'value = 2;\nnext',
    });
    expect(result.content).toBe(
      'Edited file.txt (1 replacement; matched ignoring trailing whitespace).',
    );
    expect(after).toBe('value = 2;\nnext\n');
  });

  it('refuses placeholders, ambiguity and no-op edits with actionable errors', async () => {
    const placeholder = await edit('a\nb\n', {
      old_string: 'a\nb',
      new_string: 'a\n// rest of code ...',
    });
    expect(placeholder.result).toMatchObject({ is_error: true });
    expect(String(placeholder.result.content)).toContain('placeholder');
    expect(placeholder.after).toBe('a\nb\n');
    const ambiguous = await edit('x\nx\n', { old_string: 'x', new_string: 'y' });
    expect(String(ambiguous.result.content)).toContain('matches 2 times');
    const missing = await edit('alpha\nbeta\n', { old_string: 'beta\ngamma', new_string: 'z' });
    expect(String(missing.result.content)).toContain('line 2');
    const all = await edit('x\r\nx\r\n', { old_string: 'x', new_string: 'y', replace_all: true });
    expect(all.after).toBe('y\r\ny\r\n');
  });
});
