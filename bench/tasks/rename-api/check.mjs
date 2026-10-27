import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finish, nodeTests } from '../../lib/checks.mjs';

const task = path.dirname(fileURLToPath(import.meta.url));
// Only the alias in lib/users.js may still mention the old name.
const leftovers = [];
for (const dir of ['lib', 'test'])
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (file === path.join('lib', 'users.js')) continue;
    if (readFileSync(file, 'utf8').includes('getUserData')) leftovers.push(file);
  }
if (leftovers.length) finish(false, `getUserData is still used in ${leftovers.join(', ')}`);
const visible = nodeTests(process.cwd(), ['test']);
if (!visible.passed || !visible.tests)
  finish(false, `${visible.failed}/${visible.tests} tests fail, first: ${visible.firstFailure}`);
const hidden = nodeTests(process.cwd(), [path.join(task, 'hidden/rename.test.mjs')]);
if (!hidden.passed)
  finish(
    false,
    `${hidden.failed}/${hidden.tests} hidden tests fail, first: ${hidden.firstFailure}`,
  );
finish(true, `8 modules renamed; ${visible.tests} visible and ${hidden.tests} hidden tests pass`);
