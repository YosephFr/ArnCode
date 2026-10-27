import { appendFile, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { getConfigDir } from './config.js';
import { redact } from './redact.js';
import { ensurePrivateDir, isFileError } from './storage.js';

const MAX_ENTRIES = 300;
/** The newest part of the file that is read; older prompts are trimmed away over time. */
const KEEP_BYTES = 4 * 1024 * 1024;
/** Pastes larger than this are not worth recalling. */
const MAX_ENTRY_CHARS = 100_000;

function historyFile(dir: string): string {
  return path.join(dir, 'history.jsonl');
}

/** The last `bytes` of a file, starting at a whole line. */
async function tail(file: string, bytes: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    return start ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await handle.close();
  }
}

/** Prompts previously submitted in this project, oldest first. */
export async function loadHistory(cwd: string, dir = getConfigDir()): Promise<string[]> {
  try {
    const entries: string[] = [];
    for (const line of (await tail(historyFile(dir), KEEP_BYTES)).split('\n')) {
      try {
        const entry = JSON.parse(line) as { cwd?: unknown; text?: unknown };
        if (entry.cwd === cwd && typeof entry.text === 'string') entries.push(entry.text);
      } catch {
        // Skip a partially written line.
      }
    }
    return entries.slice(-MAX_ENTRIES);
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return [];
    throw error;
  }
}

export async function saveHistory(cwd: string, text: string, dir = getConfigDir()): Promise<void> {
  if (!text.trim() || text.length > MAX_ENTRY_CHARS) return;
  await ensurePrivateDir(dir);
  const file = historyFile(dir);
  await appendFile(
    file,
    `${JSON.stringify({ cwd, text: redact(text), at: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  if ((await stat(file)).size <= 2 * KEEP_BYTES) return;
  // Keep the newest prompts; only what loadHistory reads survives.
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const handle = await open(temporary, 'w', 0o600);
    try {
      await handle.writeFile(await tail(file, KEEP_BYTES));
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
