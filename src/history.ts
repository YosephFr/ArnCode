import { appendFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { getConfigDir } from './config.js';
import { redact } from './redact.js';
import { ensurePrivateDir, isFileError } from './storage.js';

const MAX_ENTRIES = 300;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

function historyFile(dir: string): string {
  return path.join(dir, 'history.jsonl');
}

/** Prompts previously submitted in this project, oldest first. */
export async function loadHistory(cwd: string, dir = getConfigDir()): Promise<string[]> {
  const file = historyFile(dir);
  try {
    if ((await stat(file)).size > MAX_FILE_BYTES) return [];
    const entries: string[] = [];
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
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
  if (!text.trim()) return;
  await ensurePrivateDir(dir);
  await appendFile(
    historyFile(dir),
    `${JSON.stringify({ cwd, text: redact(text), at: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
}
