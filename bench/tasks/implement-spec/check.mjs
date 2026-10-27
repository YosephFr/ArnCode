import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finish, nodeTests } from '../../lib/checks.mjs';

if (!existsSync('src/ranges.js')) finish(false, 'src/ranges.js is missing');
const task = path.dirname(fileURLToPath(import.meta.url));
const hidden = nodeTests(process.cwd(), [path.join(task, 'hidden/ranges.test.mjs')]);
finish(
  hidden.passed,
  hidden.passed
    ? `${hidden.tests} hidden tests pass`
    : `${hidden.failed}/${hidden.tests} hidden tests fail, first: ${hidden.firstFailure}`,
);
