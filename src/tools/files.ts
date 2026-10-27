import { createReadStream } from 'node:fs';
import { mkdir, open, opendir, readFile, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentUI } from '../types.js';
import { redact } from '../redact.js';
import { prepareImage, probeImage, type PreparedImage } from '../images.js';
import { matchEdit, nearbyLines, omissionPlaceholders, replaceMatches } from './match.js';
import {
  createPathPolicy,
  ensureDirectory,
  isProtected,
  projectPath,
  type PathPolicy,
} from './paths.js';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_RESULT_CHARS = 40_000;
const MAX_LINE_CHARS = 2_000;

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

/** Replace a file in one step, keeping its permissions. */
export async function atomicWrite(file: string, content: string | Buffer): Promise<void> {
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
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

const IMAGE_MAGIC = [
  Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  Buffer.from([0xff, 0xd8, 0xff]),
  Buffer.from('GIF8'),
  Buffer.from('RIFF'),
];

const MAX_PDF_BYTES = 12 * 1024 * 1024;
const MAX_PDF_PAGES = 100;

/** A rough page count from the PDF's page objects; enough to warn before an expensive read. */
export function estimatePdfPages(data: Buffer): number {
  return (data.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}

/** Read a PDF for the model, or return undefined when the file is not one. */
export async function readDocument(
  cwd: string,
  input: string,
  policy?: PathPolicy,
): Promise<{ path: string; data: Buffer; pages: number } | undefined> {
  const file = await projectPath(cwd, input, false, policy);
  const info = await stat(file);
  if (!info.isFile()) return undefined;
  const handle = await open(file, 'r');
  try {
    const head = Buffer.alloc(5);
    await handle.read(head, 0, 5, 0);
    if (head.toString('latin1') !== '%PDF-') return undefined;
    if (info.size > MAX_PDF_BYTES)
      throw new Error(
        'PDF exceeds 12 MiB. Extract the pages you need first, for example with pdftotext or qpdf.',
      );
    const data = await handle.readFile();
    const pages = estimatePdfPages(data);
    if (pages > MAX_PDF_PAGES)
      throw new Error(
        `PDF has about ${pages} pages; the limit is ${MAX_PDF_PAGES}. Extract the pages you need first, for example with qpdf --pages.`,
      );
    return { path: path.relative(cwd, file), data, pages };
  } finally {
    await handle.close();
  }
}

/** Read an image file for the model, or return undefined when the file is not an image. */
export async function readImage(
  cwd: string,
  input: string,
  policy?: PathPolicy,
): Promise<{ path: string; image: PreparedImage } | undefined> {
  const file = await projectPath(cwd, input, false, policy);
  const info = await stat(file);
  if (!info.isFile()) return undefined;
  const handle = await open(file, 'r');
  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (
      !IMAGE_MAGIC.some((magic) =>
        head.subarray(0, bytesRead).subarray(0, magic.length).equals(magic),
      )
    )
      return undefined;
    if (info.size > 50 * 1024 * 1024) throw new Error('Image exceeds the 50 MiB read limit.');
    const data = await handle.readFile();
    if (!probeImage(data)) return undefined;
    return { path: path.relative(cwd, file), image: prepareImage(data) };
  } finally {
    await handle.close();
  }
}

export async function readText(
  cwd: string,
  input: { path: string; offset: number; limit: number },
  signal?: AbortSignal,
  policy?: PathPolicy,
): Promise<string> {
  const file = await projectPath(cwd, input.path, false, policy);
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
      const clamped =
        line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} [line truncated]` : line;
      const rendered = `${lineNumber}: ${redact(clamped)}`;
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
  policy?: PathPolicy,
  beforeChange?: (file: string) => Promise<void>,
): Promise<string> {
  if (Buffer.byteLength(input.content) > MAX_FILE_BYTES)
    throw new Error('Content exceeds the 5 MiB write limit.');
  const file = await projectPath(cwd, input.path, true, policy);
  const before = await textFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  await beforeChange?.(file);
  await atomicWrite(file, input.content);
  ui.diff(path.relative(cwd, file), redact(before), redact(input.content));
  return `Wrote ${path.relative(cwd, file)} (${Buffer.byteLength(input.content, 'utf8')} bytes).`;
}

export async function editText(
  cwd: string,
  input: { path: string; old_string: string; new_string: string; replace_all: boolean },
  ui: AgentUI,
  policy?: PathPolicy,
  beforeChange?: (file: string) => Promise<void>,
): Promise<string> {
  const file = await projectPath(cwd, input.path, false, policy);
  const before = await textFile(file);
  if (input.old_string === input.new_string)
    throw new Error('old_string and new_string are identical; there is nothing to change.');
  const placeholders = omissionPlaceholders(input.new_string).filter(
    (line) => !input.old_string.includes(line),
  );
  if (placeholders.length)
    throw new Error(
      `new_string contains a placeholder instead of code (${placeholders[0]}). Write the complete replacement text.`,
    );
  const { matches, tier, replace } = matchEdit(before, input.old_string, input.new_string);
  if (matches.length === 0) {
    const near = nearbyLines(before, input.old_string);
    throw new Error(
      `old_string was not found. ${near.length ? `Its first line appears at line ${near.join(', ')}; read that range and copy the exact text.` : 'Read the file and copy the exact text, without line-number prefixes.'}`,
    );
  }
  if (matches.length > 1 && !input.replace_all) {
    throw new Error(
      `old_string matches ${matches.length} times. Add surrounding text or set replace_all to true.`,
    );
  }
  const applied = input.replace_all ? matches : matches.slice(0, 1);
  const after = replaceMatches(before, applied, replace);
  if (Buffer.byteLength(after) > MAX_FILE_BYTES)
    throw new Error('Edited content exceeds the 5 MiB edit limit.');
  if (after === before)
    throw new Error(
      'The edit leaves the file unchanged. Line endings follow the file; write \\r explicitly to change them.',
    );
  await beforeChange?.(file);
  await atomicWrite(file, after);
  ui.diff(path.relative(cwd, file), redact(before), redact(after));
  const count = applied.length;
  const note =
    tier === 'typography'
      ? '; matched ignoring quote and dash variants'
      : tier === 'trailing-whitespace'
        ? '; matched ignoring trailing whitespace'
        : '';
  return `Edited ${path.relative(cwd, file)} (${count} replacement${count === 1 ? '' : 's'}${note}).`;
}

export async function listDirectory(
  cwd: string,
  input: { path: string },
  policy?: PathPolicy,
): Promise<string> {
  const guard = policy ?? (await createPathPolicy(cwd));
  const directory = await ensureDirectory(cwd, input.path, guard);
  const entries: string[] = [];
  let more = false;
  for await (const entry of await opendir(directory)) {
    if (await isProtected(path.join(directory, entry.name), guard)) continue;
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

/** The change a pending edit or write would make, so it can be shown before it is approved. */
export async function proposedChange(
  cwd: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ file: string; before: string; after: string } | undefined> {
  const target =
    typeof args.file_path === 'string'
      ? args.file_path
      : typeof args.path === 'string'
        ? args.path
        : undefined;
  if (!target) return undefined;
  const file = path.resolve(cwd, target);
  const relative = path.relative(cwd, file);
  const shown =
    relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
  const info = await stat(file).catch(() => undefined);
  if (info && (!info.isFile() || info.size > MAX_FILE_BYTES)) return undefined;
  const before = info ? await readFile(file, 'utf8') : '';
  if (['write_file', 'Write'].includes(name) && typeof args.content === 'string')
    return { file: shown, before, after: args.content };
  if (
    ['edit_file', 'Edit'].includes(name) &&
    typeof args.old_string === 'string' &&
    typeof args.new_string === 'string'
  ) {
    const { matches, replace } = matchEdit(before, args.old_string, args.new_string);
    const all = args.replace_all === true;
    if (!matches.length || (matches.length > 1 && !all)) return undefined;
    const after = replaceMatches(before, all ? matches : matches.slice(0, 1), replace);
    return { file: shown, before, after };
  }
  return undefined;
}
