import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { BetaContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { storeBlob } from './blobs.js';
import { prepareImage, probeImage } from './images.js';
import { redact } from './redact.js';
import { createPathPolicy, isProtected } from './tools/paths.js';
import { describeImage } from './tools/index.js';
import { estimatePdfPages } from './tools/files.js';

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp)$/i;
const MAX_ATTACHMENTS = 10;
const MAX_TEXT_BYTES = 200_000;

/**
 * Paths the user points at: `@path` or `@"path with spaces"` mentions, and image paths pasted or
 * dropped into the terminal (absolute or `~/`, optionally quoted or with escaped spaces).
 */
export function mentionedPaths(prompt: string): string[] {
  const found: string[] = [];
  const mention = /(?:^|\s)@(?:"([^"]+)"|((?:\\ |[^\s])+))/g;
  for (const match of prompt.matchAll(mention)) {
    const value = (match[1] ?? match[2] ?? '').replace(/\\ /g, ' ').replace(/[,.;:!?)\]]+$/, '');
    if (value) found.push(value);
  }
  const pasted =
    /(?:^|\s)(?:(['"])((?:\/|~\/)[^'"]+?\.(?:png|jpe?g|gif|webp))\1|((?:\/|~\/)(?:\\ |[^\s'"])+?\.(?:png|jpe?g|gif|webp)))(?=\s|$)/gi;
  for (const match of prompt.matchAll(pasted))
    found.push((match[2] ?? match[3] ?? '').replace(/\\ /g, ' '));
  return [...new Set(found)].slice(0, MAX_ATTACHMENTS);
}

function resolvePath(cwd: string, value: string): string {
  if (value === '~' || value.startsWith('~/')) return path.join(homedir(), value.slice(1));
  return path.resolve(cwd, value);
}

/**
 * Turn a prompt that mentions files into content blocks: images become image blocks and text
 * files are inlined. Returns undefined when nothing can be attached.
 */
export async function attachMentions(
  prompt: string,
  options: { cwd: string; sessionId: string; protectedPaths?: readonly string[] },
): Promise<
  { content: BetaContentBlockParam[]; attached: string[]; skipped: string[] } | undefined
> {
  const mentions = mentionedPaths(prompt);
  if (!mentions.length) return undefined;
  const policy = await createPathPolicy(options.cwd, options.protectedPaths);
  const content: BetaContentBlockParam[] = [];
  const attached: string[] = [];
  const skipped: string[] = [];
  for (const mention of mentions) {
    const file = resolvePath(options.cwd, mention);
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) continue;
    const shown = path.relative(options.cwd, file).startsWith('..')
      ? file
      : path.relative(options.cwd, file);
    if (await isProtected(file, policy)) {
      skipped.push(`${shown}: protected path`);
      continue;
    }
    if (info.size > 50 * 1024 * 1024) {
      skipped.push(`${shown}: larger than 50 MiB`);
      continue;
    }
    const data = await readFile(file);
    if (data.subarray(0, 5).toString('latin1') === '%PDF-') {
      const pages = estimatePdfPages(data);
      if (data.length > 12 * 1024 * 1024 || pages > 100) {
        skipped.push(`${shown}: PDF too large to attach; extract the pages you need first`);
        continue;
      }
      content.push(
        { type: 'text', text: `PDF ${shown} (about ${pages} page${pages === 1 ? '' : 's'})` },
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: await storeBlob(options.sessionId, data),
          },
        },
      );
    } else if (IMAGE_FILE.test(file) || probeImage(data)) {
      let image;
      try {
        image = prepareImage(data);
      } catch (error) {
        skipped.push(`${shown}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      content.push(
        { type: 'text', text: describeImage(shown, image) },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: image.mediaType,
            data: await storeBlob(options.sessionId, image.data),
          },
        },
      );
    } else {
      if (data.subarray(0, 4096).includes(0)) {
        skipped.push(`${shown}: binary file`);
        continue;
      }
      const text = data.subarray(0, MAX_TEXT_BYTES).toString('utf8');
      const omitted =
        data.length > MAX_TEXT_BYTES ? '\n[File truncated; read the rest with read_file.]' : '';
      content.push({
        type: 'text',
        text: redact(`<file path="${shown}">\n${text}${omitted}\n</file>`),
      });
    }
    attached.push(shown);
  }
  if (!attached.length) return skipped.length ? { content: [], attached, skipped } : undefined;
  content.push({ type: 'text', text: prompt });
  return { content, attached, skipped };
}
