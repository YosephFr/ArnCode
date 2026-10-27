import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * A repository's own configuration must not run commands while ArnCode only reads it: no
 * filesystem monitor hook, and no bare repository picked up by searching upward from a folder.
 */
const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'safe.bareRepository=explicit'];

/** Run a read-only git command in `cwd`; rejects like execFile when git fails. */
export async function readGit(
  args: string[],
  options: { cwd: string; signal?: AbortSignal; timeout?: number },
): Promise<string> {
  const { stdout } = await run('git', [...SAFE, ...args], {
    ...options,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout;
}
