import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expandCommand, loadCustomCommands, splitArguments } from '../src/commands/custom.js';
import { DEFAULTS, readConfig } from '../src/config.js';
import { loadHistory, saveHistory } from '../src/history.js';
import { MeterStore } from '../src/metering.js';
import { PermissionManager } from '../src/permissions.js';
import { runTask } from '../src/runner.js';
import { SLASH_COMMANDS, slashCommand, type ReplState } from '../src/repl.js';
import { appendTranscript, newSession } from '../src/session.js';
import { createTheme } from '../src/tui/theme.js';
import type { TerminalUI } from '../src/ui.js';

let root: string;
let project: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'arncode-commands-'));
  project = path.join(root, 'project');
  await mkdir(project);
  vi.stubEnv('ARNCODE_CONFIG_DIR', path.join(root, 'state'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function file(target: string, content: string) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

describe('custom commands', () => {
  it('loads Markdown commands with namespaces, project precedence and reserved names', async () => {
    await file(
      path.join(project, '.arncode/commands/review.md'),
      '---\ndescription: Review a change\nargument-hint: <path>\n---\nReview $ARGUMENTS carefully.\n',
    );
    await file(path.join(project, '.claude/commands/git/commit.md'), 'Write a commit message.\n');
    await file(path.join(project, '.claude/commands/review.md'), 'Shadowed by the .arncode one.\n');
    await file(path.join(project, '.arncode/commands/help.md'), 'Must not replace /help.\n');
    await file(path.join(root, 'home/.claude/commands/standup.md'), 'Summarize yesterday.\n');
    const commands = await loadCustomCommands(
      project,
      SLASH_COMMANDS.map((command) => command.name),
      { homeDir: path.join(root, 'home') },
    );
    expect(commands.map((command) => command.name).sort()).toEqual([
      '/git:commit',
      '/review',
      '/standup',
    ]);
    const review = commands.find((command) => command.name === '/review')!;
    expect(review).toMatchObject({ description: 'Review a change', argumentHint: '<path>' });
    expect(commands.find((command) => command.name === '/git:commit')!.description).toBe(
      'Write a commit message.',
    );
  });

  it('fills $ARGUMENTS and numbered arguments, or appends them', () => {
    const command = { name: '/x', description: '', body: 'Compare $1 with $2. All: $ARGUMENTS' };
    expect(splitArguments('a "b c" \'d\'')).toEqual(['a', 'b c', 'd']);
    expect(expandCommand(command, 'old.ts "new file.ts"')).toBe(
      'Compare old.ts with new file.ts. All: old.ts "new file.ts"',
    );
    expect(expandCommand({ ...command, body: 'Explain.' }, 'the parser')).toBe(
      'Explain.\n\nthe parser',
    );
    expect(expandCommand({ ...command, body: 'Run $ARGUMENTS' }, 'echo "$$ $1"')).toBe(
      'Run echo "$$ $1"',
    );
  });
});

describe('session commands', () => {
  function state(overrides: Partial<ReplState> = {}) {
    const notices: string[] = [];
    const settings = { ...DEFAULTS, cwd: project };
    const value: ReplState = {
      settings,
      session: newSession(settings),
      permissions: new PermissionManager('full', false, async () => 'n'),
      ui: { notice: (text: string) => notices.push(text) } as unknown as TerminalUI,
      ...overrides,
    };
    return { value, notices };
  }

  it('turns /init and custom commands into prompts', async () => {
    const { value } = state({
      custom: [{ name: '/review', description: '', body: 'Review $ARGUMENTS.' }],
    });
    expect(await slashCommand('/init', value)).toMatchObject({
      prompt: expect.stringContaining('AGENTS.md'),
    });
    expect(await slashCommand('/review src/app.ts', value)).toEqual({
      prompt: 'Review src/app.ts.',
    });
  });

  it('exports the conversation and reports context use', async () => {
    const { value, notices } = state();
    appendTranscript(value.session, 'user', 'Fix the parser');
    appendTranscript(value.session, 'assistant', 'Fixed it.');
    value.session.contextTokens = 50_000;
    await slashCommand('/export notes.md', value);
    const saved = await readFile(path.join(project, 'notes.md'), 'utf8');
    expect(saved).toContain('## You\n\nFix the parser');
    expect(saved).toContain('## ArnCode\n\nFixed it.');
    await slashCommand('/context', value);
    expect(notices.at(-1)).toContain('Context: 50k of 200k tokens (25%)');
    await slashCommand('/model sonnet', { ...value, settings: { ...value.settings } });
    expect(notices.at(-1)).toContain('Sonnet 5.5 (claude-sonnet-5-5)');
  });

  it('switches the theme at once and keeps it for later sessions', async () => {
    const applied: string[] = [];
    const { value, notices } = state({
      setTheme: (name) => {
        applied.push(name);
        return createTheme(name === 'auto' ? 'dark' : name);
      },
    });
    await slashCommand('/theme light', value);
    expect(applied).toEqual(['light']);
    expect(notices.at(-1)).toBe('Theme: light');
    expect((await readConfig(path.join(root, 'state'))).theme).toBe('light');
    await expect(slashCommand('/theme neon', value)).rejects.toThrow('/theme auto');
    await slashCommand('/todos', value);
    expect(notices.at(-1)).toBe('No checklist in this conversation yet.');
  });
});

describe('undo', () => {
  it('puts back what a request changed and tells the model with the next request', async () => {
    const settings = { ...DEFAULTS, cwd: project };
    const session = newSession(settings);
    const app = path.join(project, 'app.js');
    const created = path.join(project, 'created.txt');
    await writeFile(app, 'old\n');
    let sent = '';
    const run = (prompt: string, engine: Parameters<typeof runTask>[0]['engines']) =>
      runTask({
        settings,
        session,
        prompt,
        ui: { notice: () => undefined, idle: () => undefined, endText: () => undefined } as never,
        approve: async () => ({ allowed: true }),
        signal: new AbortController().signal,
        meter: new MeterStore(path.join(root, 'state')),
        save: async () => undefined,
        candidates: [
          {
            name: 'api',
            type: 'api-key',
            secret: 'fixture-key',
            source: 'stored',
            priority: 0,
            enabled: true,
            createdAt: '2026-10-27T00:00:00.000Z',
          },
        ],
        engines: engine,
      });
    await run('Rename the greeting', {
      'api-key': async (ctx) => {
        await ctx.recordChange!(app);
        await writeFile(app, 'new\n');
        await ctx.recordChange!(created);
        await writeFile(created, 'made\n');
        // A second change in the same request keeps the content from before the request.
        await ctx.recordChange!(app);
        await writeFile(app, 'newer\n');
      },
      oauth: async () => undefined,
    });
    expect(session.checkpoints?.at(-1)?.files).toHaveLength(2);
    const notices: string[] = [];
    await slashCommand('/undo', {
      settings,
      session,
      permissions: new PermissionManager('full', false, async () => 'n'),
      ui: { notice: (text: string) => notices.push(text) } as unknown as TerminalUI,
    });
    expect(await readFile(app, 'utf8')).toBe('old\n');
    await expect(stat(created)).rejects.toThrow();
    expect(notices.at(-1)).toBe('Restored app.js, created.txt.');
    await run('Try again', {
      'api-key': async (ctx) => {
        sent = JSON.stringify(ctx.session.messages.at(-1));
      },
      oauth: async () => undefined,
    });
    expect(sent).toContain('The user undid your changes from the request');
    expect(session.checkpoints).toEqual([]);
    await slashCommand('/undo', {
      settings,
      session,
      permissions: new PermissionManager('full', false, async () => 'n'),
      ui: { notice: (text: string) => notices.push(text) } as unknown as TerminalUI,
    });
    expect(notices.at(-1)).toContain('Nothing to undo');
  });
});

describe('undo through links', () => {
  it('restores the real file and keeps the link', async () => {
    const settings = { ...DEFAULTS, cwd: project };
    const session = newSession(settings);
    const agents = path.join(project, 'AGENTS.md');
    const link = path.join(project, 'CLAUDE.md');
    await writeFile(agents, 'old\n');
    await symlink('AGENTS.md', link);
    await runTask({
      settings,
      session,
      prompt: 'Update the instructions',
      ui: { notice: () => undefined, idle: () => undefined, endText: () => undefined } as never,
      approve: async () => ({ allowed: true }),
      signal: new AbortController().signal,
      meter: new MeterStore(path.join(root, 'state')),
      save: async () => undefined,
      candidates: [
        {
          name: 'api',
          type: 'api-key',
          secret: 'fixture-key',
          source: 'stored',
          priority: 0,
          enabled: true,
          createdAt: '2026-10-27T00:00:00.000Z',
        },
      ],
      engines: {
        // OAuth tools name the path they were given, which may be a link.
        'api-key': async (ctx) => {
          await ctx.recordChange!(link);
          await writeFile(link, 'new\n');
        },
        oauth: async () => undefined,
      },
    });
    await slashCommand('/undo', {
      settings,
      session,
      permissions: new PermissionManager('full', false, async () => 'n'),
      ui: { notice: () => undefined } as unknown as TerminalUI,
    });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(agents, 'utf8')).toBe('old\n');
  });
});

describe('prompt history', () => {
  it('keeps recalling the newest prompts as the file grows, and trims it', async () => {
    const state = path.join(root, 'state');
    await mkdir(state, { recursive: true });
    const filler = `${JSON.stringify({ cwd: '/elsewhere', text: 'x'.repeat(1000) })}\n`;
    await writeFile(path.join(state, 'history.jsonl'), filler.repeat(9000));
    await saveHistory(project, 'run the tests', state);
    await saveHistory(project, 'y'.repeat(200_000), state);
    expect(await loadHistory(project, state)).toEqual(['run the tests']);
    expect((await stat(path.join(state, 'history.jsonl'))).size).toBeLessThanOrEqual(
      4 * 1024 * 1024,
    );
  });
});
