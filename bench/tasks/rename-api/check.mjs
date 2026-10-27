import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finish, nodeTests } from '../../lib/checks.mjs';

const task = path.dirname(fileURLToPath(import.meta.url));
const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : [];
  });
if (!existsSync('lib') || !existsSync('test')) finish(false, 'lib/ or test/ was removed');
// Only the alias in lib/users.js may still mention the old name.
const leftovers = [...files('lib'), ...files('test')].filter(
  (file) =>
    file !== path.join('lib', 'users.js') && readFileSync(file, 'utf8').includes('getUserData'),
);
if (leftovers.length) finish(false, `getUserData is still used in ${leftovers.join(', ')}`);
// Explicit files: newer Node versions read a bare directory argument as a pattern.
const suites = files('test').filter((file) => /\.test\.m?js$/.test(file));
const visible = nodeTests(process.cwd(), suites);
if (!visible.passed || !visible.tests)
  finish(false, `${visible.failed}/${visible.tests} tests fail, first: ${visible.firstFailure}`);
const hidden = nodeTests(process.cwd(), [path.join(task, 'hidden/rename.test.mjs')]);
if (!hidden.passed)
  finish(
    false,
    `${hidden.failed}/${hidden.tests} hidden tests fail, first: ${hidden.firstFailure}`,
  );
finish(true, `8 modules renamed; ${visible.tests} visible and ${hidden.tests} hidden tests pass`);
