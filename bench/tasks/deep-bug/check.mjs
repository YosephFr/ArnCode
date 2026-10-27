import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finish, nodeTests } from '../../lib/checks.mjs';

const task = path.dirname(fileURLToPath(import.meta.url));
const suite = 'test/invoice.test.js';
let current = '';
try {
  current = readFileSync(suite, 'utf8');
} catch {
  finish(false, `${suite} was removed`);
}
if (current !== readFileSync(path.join(task, 'fixture', suite), 'utf8'))
  finish(false, `${suite} was changed`);
const visible = nodeTests(process.cwd(), [suite]);
if (!visible.passed)
  finish(
    false,
    `${visible.failed}/${visible.tests} tests still fail, first: ${visible.firstFailure}`,
  );
// The fix belongs in the shared money helper, so other callers are right too.
const hidden = nodeTests(process.cwd(), [path.join(task, 'hidden/money.test.mjs')]);
if (!hidden.passed)
  finish(
    false,
    `${hidden.failed}/${hidden.tests} hidden tests fail, first: ${hidden.firstFailure}`,
  );
finish(true, `${visible.tests} visible and ${hidden.tests} hidden tests pass`);
