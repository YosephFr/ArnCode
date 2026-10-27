import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finish, nodeTests } from '../../lib/checks.mjs';

const task = path.dirname(fileURLToPath(import.meta.url));
const work = process.cwd();

function inScratch(use) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tally-check-'));
  try {
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The option works on files the agent has not seen, and the default output is unchanged.
const mismatch = inScratch((dir) => {
  writeFileSync(path.join(dir, 'a.txt'), 'one two\nthree\n\nfour five six\n');
  writeFileSync(path.join(dir, 'b.txt'), 'last line without newline');
  const cases = [
    [['--lines', 'a.txt'], undefined, '4 a.txt\n'],
    [['-l', 'a.txt', 'b.txt'], undefined, '4 a.txt\n0 b.txt\n4 total\n'],
    [['--lines'], 'x\ny\n', '2\n'],
    [['a.txt', 'b.txt'], undefined, '6 a.txt\n4 b.txt\n10 total\n'],
  ];
  for (const [args, input, expected] of cases) {
    const run = spawnSync(process.execPath, [path.join(work, 'bin/tally.js'), ...args], {
      cwd: dir,
      input,
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (run.stdout !== expected)
      return `tally ${args.join(' ')} printed ${JSON.stringify(run.stdout)}, expected ${JSON.stringify(expected)}`;
  }
  return undefined;
});
if (mismatch) finish(false, mismatch);

const suite = nodeTests(work);
if (!suite.passed)
  finish(false, `${suite.failed}/${suite.tests} tests fail, first: ${suite.firstFailure}`);

// The tests cover the option: they fail once the original CLI and library are restored.
const original = inScratch((dir) => {
  cpSync(work, dir, { recursive: true, filter: (source) => path.basename(source) !== '.git' });
  for (const file of ['bin/tally.js', 'lib/count.js'])
    cpSync(path.join(task, 'fixture', file), path.join(dir, file));
  return nodeTests(dir);
});
if (original.passed) finish(false, 'the tests also pass without the change, so none cover --lines');
finish(true, `--lines works; the suite (${suite.tests} tests) passes and fails without the change`);
