import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function isFileError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Expected a private directory for ${basename(path)}.`);
  }
  await chmod(path, 0o700);
}

export async function readJson(path: string): Promise<unknown | undefined> {
  let content: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`${basename(path)} must be a regular file.`);
    }
    await ensurePrivateDir(dirname(path));
    await chmod(path, 0o600);
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return undefined;
    throw error;
  }
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error(`Invalid JSON in ${basename(path)}.`);
  }
}

export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } finally {
    await handle.close();
    await unlink(temporary).catch((error: unknown) => {
      if (!isFileError(error, 'ENOENT')) throw error;
    });
  }
}

export async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await ensurePrivateDir(dirname(path));
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 10000;
  let lock;
  while (!lock) {
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (!isFileError(error, 'EEXIST')) throw error;
      await removeAbandonedLock(lockPath);
      if (Date.now() >= deadline)
        throw new Error(`${basename(path)} is busy. Try again shortly.`, { cause: error });
      await delay(25);
    }
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    return await operation();
  } finally {
    await lock.close();
    await unlink(lockPath).catch((error: unknown) => {
      if (!isFileError(error, 'ENOENT')) throw error;
    });
  }
}

async function removeAbandonedLock(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    let owner: unknown;
    try {
      owner = JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch {
      if (Date.now() - info.mtimeMs < 30000) return;
    }
    if (
      typeof owner === 'object' &&
      owner !== null &&
      'pid' in owner &&
      typeof owner.pid === 'number'
    ) {
      try {
        process.kill(owner.pid, 0);
        return;
      } catch (error) {
        if (!isFileError(error, 'ESRCH')) return;
      }
    } else if (Date.now() - info.mtimeMs < 30000) {
      return;
    }
    const current = await lstat(path);
    if (current.ino === info.ino && current.mtimeMs === info.mtimeMs) await unlink(path);
  } catch (error) {
    if (!isFileError(error, 'ENOENT')) throw error;
  }
}
