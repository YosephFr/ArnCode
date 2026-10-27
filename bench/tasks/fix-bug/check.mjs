import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finish, nodeTests } from '../../lib/checks.mjs';

const task = path.dirname(fileURLToPath(import.meta.url));
const suite = 'test/stats.test.js';
const original = readFileSync(path.join(task, 'fixture', suite), 'utf8');
let current = '';
try {
  current = readFileSync(suite, 'utf8');
} catch {
  finish(false, `${suite} was removed`);
}
if (current !== original) finish(false, `${suite} was changed`);

const visible = nodeTests(process.cwd(), [suite]);
if (!visible.passed)
  finish(
    false,
    `${visible.failed}/${visible.tests} tests still fail, first: ${visible.firstFailure}`,
  );
const hidden = nodeTests(process.cwd(), [path.join(task, 'hidden/stats.test.mjs')]);
if (!hidden.passed)
  finish(
    false,
    `${hidden.failed}/${hidden.tests} hidden tests fail, first: ${hidden.firstFailure}`,
  );
finish(true, `${visible.tests} visible and ${hidden.tests} hidden tests pass`);
