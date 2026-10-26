import { lstat, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_PROTECTED_PATHS, getConfigDir } from '../config.js';

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function slash(value: string): string {
  return value.split(path.sep).join('/');
}

function protectedPattern(pattern: string): RegExp {
  const segments = slash(pattern)
    .replace(/\/+$/, '')
    .split('/')
    .filter((segment, index, all) => segment !== '**' || all[index - 1] !== '**');
  const source = segments
    .map((segment, index) => {
      const last = index === segments.length - 1;
      if (segment === '**') return last ? '(?:/.*)?' : '(?:[^/]+/)*';
      const part = [...segment]
        .map((character) => {
          if (character === '*') return '[^/]*';
          if (character === '?') return '[^/]';
          return character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
        })
        .join('');
      const trailingGlobstar = segments[index + 1] === '**' && index + 1 === segments.length - 1;
      return part + (last || trailingGlobstar ? '' : '/');
    })
    .join('');
  return new RegExp(`^${source}(?:/.*)?$`, 's');
}

async function canonicalRule(pattern: string): Promise<string> {
  const wildcard = pattern.search(/[?*]/);
  const before = pattern.slice(0, wildcard);
  const prefix =
    wildcard < 0
      ? pattern
      : before.endsWith(path.sep)
        ? before.slice(0, -1) || path.parse(pattern).root
        : path.dirname(before);
  let existing = prefix;
  while (true) {
    try {
      return path.join(await realpath(existing), path.relative(existing, pattern));
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

export interface PathPolicy {
  root: string;
  matches(candidate: string): boolean;
}

export async function createPathPolicy(
  cwd: string,
  additions: readonly string[] = [],
): Promise<PathPolicy> {
  const root = await realpath(cwd);
  const configured = [...new Set([...DEFAULT_PROTECTED_PATHS, ...additions, getConfigDir()])];
  const rules = new Set<string>();
  for (const rule of configured) {
    const expanded =
      rule === '~' ? homedir() : rule.startsWith('~/') ? path.join(homedir(), rule.slice(2)) : rule;
    const absolute = path.resolve(root, expanded);
    rules.add(absolute);
    rules.add(await canonicalRule(absolute));
  }
  const patterns = [...rules].map(protectedPattern);
  return {
    root,
    matches: (candidate) => patterns.some((pattern) => pattern.test(slash(candidate))),
  };
}

export async function isProtected(candidate: string, policy: PathPolicy): Promise<boolean> {
  if (policy.matches(candidate)) return true;
  try {
    return policy.matches(await realpath(candidate));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function projectPath(
  cwd: string,
  input: string,
  allowMissing = false,
  policy?: PathPolicy,
): Promise<string> {
  const guard = policy ?? (await createPathPolicy(cwd));
  const root = guard.root;
  const candidate = path.resolve(root, input);
  if (!isWithin(root, candidate)) throw new Error('Path must stay inside the project directory.');
  if (guard.matches(candidate)) throw new Error('Path is protected by protectedPaths.');

  let existing = candidate;
  const missing: string[] = [];
  while (true) {
    try {
      const resolved = await realpath(existing);
      const target = path.join(resolved, ...missing.reverse());
      if (!isWithin(root, target)) throw new Error('Symlink points outside the project directory.');
      if (guard.matches(target)) throw new Error('Path is protected by protectedPaths.');
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

export async function ensureDirectory(
  cwd: string,
  input: string,
  policy?: PathPolicy,
): Promise<string> {
  const target = await projectPath(cwd, input, false, policy);
  if (!(await stat(target)).isDirectory()) throw new Error('Path is not a directory.');
  return target;
}
