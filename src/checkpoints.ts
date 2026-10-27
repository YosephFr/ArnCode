import { createHash } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { blobDigest, readBlob, storeBlob } from './blobs.js';
import { realLocation } from './permission-rules.js';
import type { Session } from './session.js';
import { atomicWrite } from './tools/files.js';

/** A file the agent changed during one request, as it was before that request. */
export interface CheckpointFile {
  path: string;
  /** Blob reference for the earlier content; absent when the request created the file. */
  before?: string;
  /** Set when the earlier content was too large to keep. */
  tooLarge?: boolean;
  /** SHA-256 of the content when the request ended. */
  after?: string;
}

export interface Checkpoint {
  prompt: string;
  startedAt: string;
  files: CheckpointFile[];
}

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 20;

async function digest(file: string): Promise<string | undefined> {
  try {
    return createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  } catch {
    return undefined;
  }
}

/** Open a checkpoint for a new request. */
export function startCheckpoint(session: Session, prompt: string): void {
  const line = prompt.trim().split('\n')[0] ?? '';
  session.checkpoints = [
    ...(session.checkpoints ?? []),
    {
      prompt: line.length > 80 ? `${line.slice(0, 79)}…` : line,
      startedAt: new Date().toISOString(),
      files: [],
    },
  ].slice(-KEEP);
}

/** Keep a file's content before the agent first changes it in the current request. */
export async function recordChange(session: Session, file: string): Promise<void> {
  const checkpoint = session.checkpoints?.at(-1);
  // The real file, so undoing writes through a link instead of replacing the link itself.
  const target = await realLocation(path.resolve(file));
  if (!checkpoint || checkpoint.files.some((entry) => entry.path === target)) return;
  const info = await stat(target).catch(() => undefined);
  if (!info) {
    checkpoint.files.push({ path: target });
  } else if (!info.isFile() || info.size > MAX_BYTES) {
    checkpoint.files.push({ path: target, tooLarge: true });
  } else {
    const before = await storeBlob(session.id, await readFile(target));
    checkpoint.files.push({ path: target, before });
  }
}

/** Close the current checkpoint; one without changes is dropped. Returns the files changed. */
export async function finishCheckpoint(session: Session): Promise<number> {
  const checkpoint = session.checkpoints?.at(-1);
  if (!checkpoint) return 0;
  for (const entry of checkpoint.files) {
    const after = await digest(entry.path);
    if (after) entry.after = after;
    else delete entry.after;
  }
  // A failed edit or a write of identical content changed nothing.
  checkpoint.files = checkpoint.files.filter((entry) =>
    entry.tooLarge
      ? true
      : entry.before
        ? blobDigest(entry.before) !== entry.after
        : entry.after !== undefined,
  );
  if (!checkpoint.files.length) session.checkpoints = session.checkpoints!.slice(0, -1);
  return checkpoint.files.length;
}

/** The latest request with changes that /undo can put back. */
export function lastCheckpoint(session: Session): Checkpoint | undefined {
  return session.checkpoints?.at(-1);
}

/** Files edited by someone else since the request ended. */
export async function changedSince(checkpoint: Checkpoint): Promise<string[]> {
  const changed: string[] = [];
  for (const entry of checkpoint.files) {
    if ((await digest(entry.path)) !== entry.after) changed.push(entry.path);
  }
  return changed;
}

/** Put the files of the latest checkpoint back and drop it. */
export async function undoCheckpoint(
  session: Session,
): Promise<{ restored: string[]; skipped: string[] }> {
  const checkpoint = session.checkpoints?.at(-1);
  if (!checkpoint) return { restored: [], skipped: [] };
  const restored: string[] = [];
  const skipped: string[] = [];
  for (const entry of checkpoint.files) {
    if (entry.tooLarge) {
      skipped.push(entry.path);
    } else if (entry.before) {
      await atomicWrite(entry.path, await readBlob(session.id, entry.before));
      restored.push(entry.path);
    } else {
      await rm(entry.path, { force: true });
      restored.push(entry.path);
    }
  }
  session.checkpoints = session.checkpoints!.slice(0, -1);
  return { restored, skipped };
}
