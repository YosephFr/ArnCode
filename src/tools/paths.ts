import { lstat, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { getConfigDir } from '../config.js';

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export function isProtected(candidate: string): boolean {
  const home = homedir();
  const protectedPaths = [
    path.join(home, '.arncode'),
    getConfigDir(),
    path.join(home, '.secrets'),
    path.join(home, '.agents.env'),
  ];
  return protectedPaths.some((protectedPath) => isWithin(protectedPath, candidate));
}

export async function projectPath(
  cwd: string,
  input: string,
  allowMissing = false,
): Promise<string> {
  const root = await realpath(cwd);
  const candidate = path.resolve(root, input);
  if (!isWithin(root, candidate)) throw new Error('Path must stay inside the project directory.');

  let existing = candidate;
  const missing: string[] = [];
  while (true) {
    try {
      const resolved = await realpath(existing);
      const target = path.join(resolved, ...missing.reverse());
      if (!isWithin(root, target)) throw new Error('Symlink points outside the project directory.');
      if (isProtected(target)) throw new Error('ArnCode does not read or edit stored credentials.');
      return target;
    } catch (error) {
      if (
        !allowMissing ||
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      ) {
        throw error;
      }
      // A dangling symlink is not a missing regular path that can be created safely.
      const entry = await lstat(existing).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT') return undefined;
        throw cause;
      });
      if (entry?.isSymbolicLink())
        throw new Error('Cannot write through a dangling symlink.', { cause: error });
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.push(path.basename(existing));
      existing = parent;
    }
  }
}

export async function ensureDirectory(cwd: string, input: string): Promise<string> {
  const target = await projectPath(cwd, input);
  if (!(await stat(target)).isDirectory()) throw new Error('Path is not a directory.');
  return target;
}
