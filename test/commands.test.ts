import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expandCommand, loadCustomCommands, splitArguments } from '../src/commands/custom.js';
import { DEFAULTS } from '../src/config.js';
import { PermissionManager } from '../src/permissions.js';
import { SLASH_COMMANDS, slashCommand, type ReplState } from '../src/repl.js';
import { appendTranscript, newSession } from '../src/session.js';
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
});
