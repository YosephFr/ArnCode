import fg from 'fast-glob';
import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { redact } from '../redact.js';
import { createPathPolicy, ensureDirectory, isProtected, type PathPolicy } from './paths.js';
import { runProcess } from './process.js';
import { truncate } from './files.js';

const IGNORE = [
  '**/.git/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.venv/**',
  '**/__pycache__/**',
];
const MAX_FILES = 10_000;
const run = promisify(execFile);

/** Expand `{a,b}` alternatives, which git pathspecs do not support. */
export function expandBraces(pattern: string, limit = 64): string[] {
  const group = /\{([^{}]*)\}/.exec(pattern);
  if (!group) return [pattern];
  const expanded = group[1]!
    .split(',')
    .flatMap((part) =>
      expandBraces(
        pattern.slice(0, group.index) + part + pattern.slice(group.index + group[0].length),
        limit,
      ),
    );
  if (expanded.length > limit) throw new Error('Glob pattern has too many alternatives.');
  return [...new Set(expanded)];
}

/**
 * Files git would show under `directory` that match `pattern`: tracked and untracked ones, minus
 * those .gitignore excludes. Undefined outside a work tree or inside an ignored directory, where
 * the caller walks the file system instead.
 */
async function gitFiles(
  directory: string,
  pattern: string,
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  const options = { cwd: directory, signal, timeout: 10_000, maxBuffer: 64 * 1024 * 1024 };
  try {
    const ignored = await run('git', ['check-ignore', '-q', '.'], options).then(
      () => true,
      (error: { code?: unknown }) => (error.code === 1 ? false : undefined),
    );
    if (ignored !== false) return undefined;
    const { stdout } = await run(
      'git',
      [
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        ...expandBraces(pattern).map((alternative) => `:(glob)${alternative}`),
      ],
      options,
    );
    return [...new Set(stdout.split('\0').filter(Boolean))];
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && error.message.includes('too many alternatives')) throw error;
    return undefined;
  }
}

function validatePattern(pattern: string): void {
  if (path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) {
    throw new Error('Glob pattern must stay inside the search directory.');
  }
}

async function collectFiles(
  cwd: string,
  directory: string,
  pattern: string,
  policy: PathPolicy,
  signal?: AbortSignal,
): Promise<{ files: string[]; truncated: boolean }> {
  signal?.throwIfAborted();
  validatePattern(pattern);
  const listed = await gitFiles(directory, pattern, signal);
  if (listed) {
    const files: string[] = [];
    for (const entry of listed) {
      const target = path.resolve(directory, entry);
      if (await isProtected(target, policy)) continue;
      // Like the file-system walk, skip links; git also lists tracked files deleted since.
      if (
        !(await lstat(target).then(
          (info) => info.isFile(),
          () => false,
        ))
      )
        continue;
      if (files.length === MAX_FILES) return { files: files.sort(), truncated: true };
      files.push(path.relative(cwd, target));
    }
    return { files: files.sort(), truncated: false };
  }
  const stream = Readable.from(
    fg.stream(pattern, {
      cwd: directory,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      suppressErrors: false,
      ignore: IGNORE,
    }),
  );
  const deadline = setTimeout(
    () => stream.destroy(new Error('File search exceeded 10 seconds. Narrow the search path.')),
    10_000,
  );
  const abort = () => stream.destroy(new Error('Search cancelled.'));
  signal?.addEventListener('abort', abort, { once: true });
  const files: string[] = [];
  let truncated = false;
  try {
    for await (const entry of stream) {
      if (typeof entry !== 'string') throw new Error('Unexpected search result.');
      const target = path.resolve(directory, entry);
      if (await isProtected(target, policy)) continue;
      if (files.length === MAX_FILES) {
        truncated = true;
        break;
      }
      files.push(path.relative(cwd, target));
    }
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', abort);
    stream.destroy();
  }
  return { files: files.sort(), truncated };
}

/** Project files for `@` completion: what git shows, or a walk outside git, without protected paths. */
export async function projectFiles(cwd: string, protectedPaths: string[]): Promise<string[]> {
  const policy = await createPathPolicy(cwd, protectedPaths);
  return (await collectFiles(cwd, cwd, '**/*', policy)).files;
}

export async function globFiles(
  cwd: string,
  input: { pattern: string; path: string },
  signal?: AbortSignal,
  policy?: PathPolicy,
): Promise<string> {
  const guard = policy ?? (await createPathPolicy(cwd));
  const directory = await ensureDirectory(cwd, input.path, guard);
  const { files, truncated } = await collectFiles(cwd, directory, input.pattern, guard, signal);
  if (truncated) files.push('[Truncated after 10000 files; narrow the pattern.]');
  return truncate(redact(files.join('\n') || '[No matching files]'));
}

// Isolating regex evaluation lets the parent enforce a deadline even for pathological patterns.
const SEARCH_SCRIPT = String.raw`
const fs = require('node:fs');
let request = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { request += chunk; });
process.stdin.on('end', () => {
  try {
    const { files, pattern, literal, ignoreCase } = JSON.parse(request);
    const regex = literal ? null : new RegExp(pattern, ignoreCase ? 'i' : '');
    const needle = ignoreCase ? pattern.toLocaleLowerCase() : pattern;
    let matches = 0;
    let skipped = 0;
    let length = 0;
    for (const file of files) {
      let info;
      try { info = fs.lstatSync(file); } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (!info.isFile() || info.size > 2 * 1024 * 1024) { skipped++; continue; }
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes('\0')) { skipped++; continue; }
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const found = regex ? regex.test(line) : (ignoreCase ? line.toLocaleLowerCase() : line).includes(needle);
        if (!found) continue;
        const shown = line.length > 500 ? line.slice(0, 500) + ' [line truncated]' : line;
        const text = file + ':' + (index + 1) + ':' + shown + '\n';
        process.stdout.write(text);
        length += text.length;
        matches++;
        if (matches >= 1000 || length >= 40000) {
          process.stdout.write('[Search results truncated; narrow the query.]\n');
          return;
        }
      }
    }
    if (!matches) process.stdout.write('[No matches]\n');
    if (skipped) process.stdout.write('[' + skipped + ' binary, linked or oversized files skipped.]\n');
  } catch (error) {
    process.stderr.write(error.message);
    process.exitCode = 2;
  }
});
`;

export async function grepFiles(
  cwd: string,
  input: { pattern: string; path: string; glob: string; literal: boolean; ignore_case: boolean },
  signal?: AbortSignal,
  policy?: PathPolicy,
): Promise<string> {
  const guard = policy ?? (await createPathPolicy(cwd));
  const directory = await ensureDirectory(cwd, input.path, guard);
  const { files, truncated } = await collectFiles(cwd, directory, input.glob, guard, signal);
  const result = await runProcess({
    command: process.execPath,
    args: ['-e', SEARCH_SCRIPT],
    cwd,
    timeoutMs: 10_000,
    signal,
    input: JSON.stringify({
      files,
      pattern: input.pattern,
      literal: input.literal,
      ignoreCase: input.ignore_case,
    }),
  });
  if (result.aborted) throw new Error('Search cancelled.');
  if (result.timedOut)
    throw new Error(
      'Search exceeded 10 seconds. Use a narrower path, literal:true or a simpler expression.',
    );
  if (result.exitCode !== 0) throw new Error(`Search failed: ${result.stderr}`);
  return truncate(
    redact(result.stdout + (truncated ? '\n[Only the first 10000 files were searched.]' : '')),
  );
}
