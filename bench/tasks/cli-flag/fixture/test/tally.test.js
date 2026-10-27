import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { countWords } from '../lib/count.js';

const cli = fileURLToPath(new URL('../bin/tally.js', import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'tally-'));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(path.join(dir, 'a.txt'), 'one two\nthree\n');
writeFileSync(path.join(dir, 'b.txt'), 'four');

function tally(args, input) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: dir, input, encoding: 'utf8' });
}

test('countWords splits on any whitespace', () => {
  assert.equal(countWords('  one\ttwo\n\nthree '), 3);
  assert.equal(countWords(''), 0);
});

test('prints the word count of each file and a total', () => {
  assert.equal(tally(['a.txt', 'b.txt']).stdout, '3 a.txt\n1 b.txt\n4 total\n');
});

test('reads standard input when no files are given', () => {
  assert.equal(tally([], 'a b c\nd\n').stdout, '4\n');
});

test('fails on a missing file', () => {
  const run = tally(['missing.txt']);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /missing\.txt/);
});
