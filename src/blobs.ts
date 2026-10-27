import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  BetaContentBlockParam,
  BetaMessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { getConfigDir } from './config.js';
import { ensurePrivateDir, isFileError } from './storage.js';

/**
 * Images live beside the session as content-addressed files; the conversation keeps only a
 * reference, so session saves stay small and every request replays identical bytes.
 */
const PREFIX = 'arncode-blob:';
const cache = new Map<string, string>();

function blobDirectory(sessionId: string, dir: string): string {
  return path.join(dir, 'sessions', `${sessionId}.blobs`);
}

export function isBlobRef(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** SHA-256 of the bytes behind a reference. */
export function blobDigest(ref: string): string {
  return ref.split(':')[1] ?? '';
}

/** Bytes behind a reference, as recorded when it was stored. */
export function blobSize(ref: string): number {
  return Number(ref.split(':')[2] ?? 0);
}

export async function storeBlob(
  sessionId: string,
  data: Buffer,
  dir = getConfigDir(),
): Promise<string> {
  const digest = createHash('sha256').update(data).digest('hex');
  const directory = blobDirectory(sessionId, dir);
  await ensurePrivateDir(directory);
  try {
    const handle = await open(path.join(directory, digest), 'wx', 0o600);
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isFileError(error, 'EEXIST')) throw error;
  }
  cache.set(digest, data.toString('base64'));
  return `${PREFIX}${digest}:${data.length}`;
}

async function loadBlob(sessionId: string, ref: string, dir: string): Promise<string> {
  const digest = ref.slice(PREFIX.length).split(':')[0] ?? '';
  if (!/^[a-f\d]{64}$/.test(digest))
    throw new Error('The session contains an invalid file reference.');
  const cached = cache.get(digest);
  if (cached !== undefined) return cached;
  try {
    const data = (await readFile(path.join(blobDirectory(sessionId, dir), digest))).toString(
      'base64',
    );
    cache.set(digest, data);
    return data;
  } catch (error) {
    if (isFileError(error, 'ENOENT'))
      throw new Error(
        'A file stored with this session is missing. Start a new session to continue.',
        {
          cause: error,
        },
      );
    throw error;
  }
}

/** The bytes behind a reference stored for this session. */
export async function readBlob(
  sessionId: string,
  ref: string,
  dir = getConfigDir(),
): Promise<Buffer> {
  return Buffer.from(await loadBlob(sessionId, ref, dir), 'base64');
}

type MediaBlock = { type: string; source?: { type: string; data?: string } };

async function hydrateBlock<T extends BetaContentBlockParam>(
  block: T,
  sessionId: string,
  dir: string,
): Promise<T> {
  const media = block as MediaBlock;
  if (
    (media.type === 'image' || media.type === 'document') &&
    media.source?.type === 'base64' &&
    media.source.data &&
    isBlobRef(media.source.data)
  ) {
    return {
      ...block,
      source: { ...media.source, data: await loadBlob(sessionId, media.source.data, dir) },
    };
  }
  if (block.type === 'tool_result' && Array.isArray(block.content)) {
    return {
      ...block,
      content: await Promise.all(
        block.content.map((item) => hydrateBlock(item as BetaContentBlockParam, sessionId, dir)),
      ),
    };
  }
  return block;
}

/** Replace image references with their base64 data for one request. */
export async function hydrateMessages(
  messages: BetaMessageParam[],
  sessionId: string,
  dir = getConfigDir(),
): Promise<BetaMessageParam[]> {
  return Promise.all(
    messages.map(async (message) =>
      message.role !== 'system' && Array.isArray(message.content)
        ? {
            ...message,
            content: await Promise.all(
              message.content.map((block) => hydrateBlock(block, sessionId, dir)),
            ),
          }
        : message,
    ),
  );
}

/** Total stored image bytes a request would resend. */
export function referencedBytes(messages: BetaMessageParam[]): number {
  let total = 0;
  JSON.stringify(messages, (_key, value: unknown) => {
    if (typeof value === 'string' && isBlobRef(value)) total += blobSize(value);
    return value;
  });
  return total;
}
