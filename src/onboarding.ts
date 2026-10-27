import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';

/** The path of an executable on PATH, or undefined when it is not installed. */
export async function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  for (const directory of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    if (
      await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  }
  return undefined;
}

/** Run `claude setup-token` in this terminal so the user signs in and sees the new token. */
export function runSetupToken(executable: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(executable, ['setup-token'], { stdio: 'inherit' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}
