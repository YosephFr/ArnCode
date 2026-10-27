// A deterministic stand-in for a coding agent, so the harness can be tested without a model. It
// recognizes each task by its fixture, applies a known patch to fix-bug, implement-spec and
// cli-flag, answers read-chart wrongly, and reports usage the way ArnCode does.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    print: { type: 'string', short: 'p' },
    cwd: { type: 'string' },
    version: { type: 'boolean' },
  },
});
if (values.version) {
  console.log('mock 1.0.0');
  process.exit(0);
}

const dir = values.cwd ?? process.cwd();
const file = (name) => path.join(dir, name);

const ranges = `export function expandRanges(input) {
  const pages = new Set();
  if (!input.trim()) return [];
  for (const raw of input.split(',')) {
    const item = raw.trim();
    const match = /^(\\d+)(?:[ \\t]*-[ \\t]*(\\d+))?$/.exec(item);
    const ends = match ? [Number(match[1]), Number(match[2] ?? match[1])] : [];
    if (!match || Math.min(...ends) < 1) throw new RangeError(\`Invalid page item: "\${item}"\`);
    const [low, high] = ends.sort((a, b) => a - b);
    if (high - low >= 10_000) throw new RangeError('More than 10,000 pages');
    for (let page = low; page <= high; page++) pages.add(page);
    if (pages.size > 10_000) throw new RangeError('More than 10,000 pages');
  }
  return [...pages].sort((a, b) => a - b);
}
`;

const tally = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { countLines, countWords } from '../lib/count.js';

const args = process.argv.slice(2);
const count = args.some((arg) => arg === '--lines' || arg === '-l') ? countLines : countWords;
const files = args.filter((arg) => arg !== '--lines' && arg !== '-l');

if (files.length === 0) {
  console.log(String(count(readFileSync(0, 'utf8'))));
} else {
  let total = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      console.error(\`tally: \${file}: cannot read file\`);
      process.exit(1);
    }
    total += count(text);
    console.log(\`\${count(text)} \${file}\`);
  }
  if (files.length > 1) console.log(\`\${total} total\`);
}
`;

const linesTest = `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/tally.js', import.meta.url));
const tally = (args, input) => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8' });

test('--lines counts newline characters', () => {
  assert.equal(tally(['--lines'], 'a\\nb\\nc').stdout, '2\\n');
});

test('-l is the short form of --lines', () => {
  assert.equal(tally(['-l'], 'one\\n').stdout, '1\\n');
});
`;

if (existsSync(file('lib/stats.js'))) {
  const source = readFileSync(file('lib/stats.js'), 'utf8');
  writeFileSync(file('lib/stats.js'), source.replace('.sort()', '.sort((a, b) => a - b)'));
  console.log('Sorted numerically in lib/stats.js.');
} else if (existsSync(file('SPEC.md'))) {
  mkdirSync(file('src'), { recursive: true });
  writeFileSync(file('src/ranges.js'), ranges);
  console.log('Implemented expandRanges in src/ranges.js.');
} else if (existsSync(file('bin/tally.js'))) {
  writeFileSync(file('bin/tally.js'), tally);
  const library = readFileSync(file('lib/count.js'), 'utf8');
  const lines = `\nexport function countLines(text) {\n  return text.split('\\n').length - 1;\n}\n`;
  writeFileSync(file('lib/count.js'), library + lines);
  writeFileSync(file('test/lines.test.js'), linesTest);
  console.log('Added --lines to tally with tests.');
} else if (existsSync(file('chart.png'))) {
  writeFileSync(file('answer.txt'), 'KIWI\n');
  console.log('The tallest bar is KIWI.');
} else {
  console.error('mock: this task has no known patch');
  process.exit(2);
}

const usage =
  '1,200 uncached in · 345 out · 6,789 cache read · 1,011 cache write · $0.0123 estimated';
console.error(`ArnCode · full access\n${dir}\nSession: mock-session`);
console.error(`Turn: ${usage}\nSession: ${usage}`);
