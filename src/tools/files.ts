import { createReadStream } from 'node:fs';
import { mkdir, open, opendir, readFile, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentUI } from '../types.js';
import { redact } from '../redact.js';
import { ensureDirectory, projectPath } from './paths.js';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_RESULT_CHARS = 48_000;

export function truncate(value: string, limit = MAX_RESULT_CHARS): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[Output truncated; narrow the query or read a smaller range.]`;
}

async function textFile(file: string): Promise<string> {
  const info = await stat(file);
  if (!info.isFile()) throw new Error('Path is not a regular file.');
  if (info.size > MAX_FILE_BYTES)
    throw new Error('File exceeds the 5 MiB edit limit. Use a targeted shell command.');
  const content = await readFile(file, 'utf8');
  if (content.includes('\0')) throw new Error('Binary files cannot be read or edited as text.');
  return content;
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const previous = await stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  const temporary = path.join(path.dirname(file), `.arncode-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', previous ? previous.mode & 0o777 : 0o644);
    try {
      if (previous) await handle.chmod(previous.mode & 0o777);
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readText(
  cwd: string,
  input: { path: string; offset: number; limit: number },
  signal?: AbortSignal,
): Promise<string> {
  const file = await projectPath(cwd, input.path);
  const info = await stat(file);
  if (!info.isFile()) throw new Error('Path is not a regular file.');
  if (info.size > 50 * 1024 * 1024)
    throw new Error('File exceeds the 50 MiB read limit. Use a targeted shell command.');
  const head = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await head.read(buffer, 0, buffer.length, 0);
    if (buffer.subarray(0, bytesRead).includes(0))
      throw new Error('Binary files cannot be read as text.');
  } finally {
    await head.close();
  }
  const stream = createReadStream(file, { encoding: 'utf8', signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  const output: string[] = [];
  let length = 0;
  let more = false;
  try {
    for await (const line of lines) {
      signal?.throwIfAborted();
      lineNumber += 1;
      if (lineNumber < input.offset) continue;
      if (output.length === input.limit || length >= MAX_RESULT_CHARS) {
        more = true;
        break;
      }
      const rendered = `${lineNumber}: ${redact(line)}`;
      output.push(truncate(rendered, MAX_RESULT_CHARS - length));
      length += rendered.length + 1;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (output.length === 0) return info.size === 0 ? '[Empty file]' : '[No lines in this range]';
  if (more) output.push(`[More content; continue with offset ${input.offset + output.length}.]`);
  return output.join('\n');
}

export async function writeText(
  cwd: string,
  input: { path: string; content: string },
  ui: AgentUI,
): Promise<string> {
  if (Buffer.byteLength(input.content) > MAX_FILE_BYTES)
    throw new Error('Content exceeds the 5 MiB write limit.');
  const file = await projectPath(cwd, input.path, true);
  const before = await textFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  await atomicWrite(file, input.content);
  ui.diff(path.relative(cwd, file), redact(before), redact(input.content));
  return `Wrote ${path.relative(cwd, file)} (${Buffer.byteLength(input.content, 'utf8')} bytes).`;
}

export async function editText(
  cwd: string,
  input: { path: string; old_string: string; new_string: string; replace_all: boolean },
  ui: AgentUI,
): Promise<string> {
  const file = await projectPath(cwd, input.path);
  const before = await textFile(file);
  const parts = before.split(input.old_string);
  const matches = parts.length - 1;
  if (matches === 0)
    throw new Error('old_string was not found. Read the file and copy the exact text.');
  if (matches > 1 && !input.replace_all) {
    throw new Error(
      `old_string matches ${matches} times. Add surrounding text or set replace_all to true.`,
    );
  }
  const after = parts.join(input.new_string);
  if (Buffer.byteLength(after) > MAX_FILE_BYTES)
    throw new Error('Edited content exceeds the 5 MiB edit limit.');
  if (before === after) return 'No change: old_string and new_string are identical.';
  await atomicWrite(file, after);
  ui.diff(path.relative(cwd, file), redact(before), redact(after));
  return `Edited ${path.relative(cwd, file)} (${matches} replacement${matches === 1 ? '' : 's'}).`;
}

export async function listDirectory(cwd: string, input: { path: string }): Promise<string> {
  const directory = await ensureDirectory(cwd, input.path);
  const entries: string[] = [];
  let more = false;
  for await (const entry of await opendir(directory)) {
    if (entries.length === 1000) {
      more = true;
      break;
    }
    entries.push(`${entry.name}${entry.isDirectory() ? '/' : entry.isSymbolicLink() ? '@' : ''}`);
  }
  entries.sort((a, b) => a.localeCompare(b));
  if (more) entries.push('[Truncated after 1000 entries.]');
  return truncate(redact(entries.join('\n') || '[Empty directory]'));
}
