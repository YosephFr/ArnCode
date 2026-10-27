import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachMentions, mentionedPaths } from '../src/attachments.js';
import { hydrateMessages, referencedBytes, storeBlob } from '../src/blobs.js';
import { ToolRunner } from '../src/tools/index.js';

let root: string;
let project: string;
let state: string;

function png(width: number, height: number): Buffer {
  const image = new PNG({ width, height });
  for (let index = 0; index < image.data.length; index += 4) {
    image.data.fill(200, index, index + 3);
    image.data[index + 3] = 255;
  }
  return PNG.sync.write(image);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'arncode-vision-'));
  project = path.join(root, 'project');
  state = path.join(root, 'state');
  await mkdir(project);
  vi.stubEnv('ARNCODE_CONFIG_DIR', state);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('prompt attachments', () => {
  it('finds mentions and pasted image paths', () => {
    expect(
      mentionedPaths(
        'Compare @src/app.ts, @"shots/home page.png" and /tmp/drop/Screen\\ Shot.png now',
      ),
    ).toEqual(['src/app.ts', 'shots/home page.png', '/tmp/drop/Screen Shot.png']);
    expect(mentionedPaths("Look at '~/frames/f 01.png' please")).toEqual(['~/frames/f 01.png']);
    expect(mentionedPaths('email me at team@example.com about /usr/bin/node')).toEqual([]);
  });

  it('attaches images and text files, skipping protected or missing paths', async () => {
    await writeFile(path.join(project, 'frame.png'), png(40, 30));
    await writeFile(path.join(project, 'notes.md'), '# Notes\nship it\n');
    await writeFile(path.join(project, '.env'), 'SECRET=1\n');
    const result = await attachMentions('Check @frame.png and @notes.md, not @.env or @gone.txt', {
      cwd: project,
      sessionId: 'session-1',
    });
    expect(result?.attached).toEqual(['frame.png', 'notes.md']);
    expect(result?.skipped).toEqual(['.env: protected path']);
    expect(result?.content.map((block) => block.type)).toEqual(['text', 'image', 'text', 'text']);
    expect(result?.content[1]).toMatchObject({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: expect.stringMatching(/^arncode-blob:/),
      },
    });
    expect(JSON.stringify(result?.content[2])).toContain('ship it');
    expect(result?.content.at(-1)).toEqual({
      type: 'text',
      text: 'Check @frame.png and @notes.md, not @.env or @gone.txt',
    });
  });
});

describe('session image storage', () => {
  it('stores bytes once and replays them exactly in requests', async () => {
    const data = png(8, 8);
    const ref = await storeBlob('session-2', data);
    expect(await storeBlob('session-2', data)).toBe(ref);
    expect(await readdir(path.join(state, 'sessions', 'session-2.blobs'))).toHaveLength(1);
    const messages = [
      {
        role: 'user' as const,
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: 'read',
            content: [
              {
                type: 'image' as const,
                source: { type: 'base64' as const, media_type: 'image/png' as const, data: ref },
              },
            ],
          },
        ],
      },
    ];
    expect(referencedBytes(messages)).toBe(data.length);
    const hydrated = await hydrateMessages(messages, 'session-2');
    expect(JSON.stringify(hydrated)).toContain(data.toString('base64'));
    expect(JSON.stringify(messages)).not.toContain(data.toString('base64'));
    await expect(
      hydrateMessages(
        [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: `arncode-blob:${'0'.repeat(64)}:1`,
                },
              },
            ],
          },
        ],
        'session-2',
      ),
    ).rejects.toThrow('missing');
  });
});

describe('reading images with read_file', () => {
  it('returns an image block with a description, and text for text files', async () => {
    await writeFile(path.join(project, 'shot.png'), png(2600, 300));
    await writeFile(path.join(project, 'plain.txt'), 'hello\n');
    const notices: string[] = [];
    const runner = new ToolRunner({
      cwd: project,
      approve: async () => ({ allowed: true }),
      ui: {
        text: () => {},
        endText: () => {},
        status: () => {},
        idle: () => {},
        notice: () => {},
        progress: () => {},
        toolResult: (_name, output) => notices.push(output),
        tool: () => {},
        diff: () => {},
      },
    });
    const image = await runner.run('read_file', { path: 'shot.png' });
    expect(Array.isArray(image.content)).toBe(true);
    const [description, block] = image.content as Exclude<typeof image.content, string>;
    expect(description).toEqual({
      type: 'text',
      text: expect.stringMatching(/^Image shot\.png \(2600×300 PNG, .+; sent as 2000×231 JPEG/),
    });
    expect(block).toMatchObject({ type: 'image', image: { width: 2000, height: 231 } });
    expect(notices[0]).toContain('Image shot.png');
    expect((await runner.run('read_file', { path: 'plain.txt' })).content).toBe('1: hello');
  });
});

describe('PDF documents', () => {
  const fixture = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    'fixtures/two-pages.pdf',
  );

  it('reads PDFs as documents and attaches them from mentions', async () => {
    const { copyFile } = await import('node:fs/promises');
    await copyFile(fixture, path.join(project, 'spec.pdf'));
    const runner = new ToolRunner({
      cwd: project,
      approve: async () => ({ allowed: true }),
      ui: {
        text: () => {},
        endText: () => {},
        status: () => {},
        idle: () => {},
        notice: () => {},
        progress: () => {},
        toolResult: () => {},
        tool: () => {},
        diff: () => {},
      },
    });
    const result = await runner.run('read_file', { path: 'spec.pdf' });
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringMatching(/^PDF spec\.pdf \(about 2 pages, /) },
      { type: 'document', data: expect.any(Buffer), pages: 2 },
    ]);
    const attached = await attachMentions('Summarize @spec.pdf', { cwd: project, sessionId: 's' });
    expect(attached?.content[1]).toMatchObject({
      type: 'document',
      source: { media_type: 'application/pdf', data: expect.stringMatching(/^arncode-blob:/) },
    });
  });
});
