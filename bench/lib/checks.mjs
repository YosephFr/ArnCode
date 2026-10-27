// Helpers for task check scripts. A check runs in the work directory, prints one line of detail
// and exits 0 when the task is solved.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** Prints the detail line and ends the check. */
export function finish(passed, detail) {
  console.log(detail);
  process.exit(passed ? 0 : 1);
}

/** Runs Node's test runner on the given files (or its default discovery) and summarizes it. */
export function nodeTests(cwd, files = []) {
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = run.stdout ?? '';
  const total = (name) => Number(output.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? 0);
  // A test file that throws while loading is reported under its own path.
  const failure = output.match(/^\s*not ok \d+ - (.+)$/m)?.[1];
  return {
    passed: run.status === 0,
    tests: total('tests'),
    failed: total('fail'),
    firstFailure: failure
      ? path.isAbsolute(failure)
        ? `${path.basename(failure)} could not run`
        : failure
      : (run.error?.message ?? 'no test output'),
  };
}
