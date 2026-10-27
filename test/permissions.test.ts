import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sessionRule } from '../src/permission-rules.js';
import { PermissionManager } from '../src/permissions.js';

describe('permissions', () => {
  it('denies writes and every shell command without a terminal, without prompting', async () => {
    const prompt = vi.fn(async () => 'y');
    const permissions = new PermissionManager('ask', false, prompt);
    for (const name of [
      'write_file',
      'edit_file',
      'bash',
      'Write',
      'Edit',
      'Bash',
      'unknown_tool',
    ]) {
      expect(await permissions.approve(name, { command: 'pwd' })).toMatchObject({
        allowed: false,
        reason: expect.stringContaining('interactive terminal'),
      });
    }
    expect(prompt).not.toHaveBeenCalled();
    expect(await permissions.approve('read_file', { path: 'README.md' })).toEqual({
      allowed: true,
    });
    expect(await permissions.approve('skill', { name: 'review' })).toEqual({ allowed: true });
  });

  it('supports one-time allow, deny, and always for a tool family in the current session', async () => {
    const prompt = vi
      .fn()
      .mockResolvedValueOnce('y')
      .mockResolvedValueOnce('n')
      .mockResolvedValueOnce('always')
      .mockResolvedValue('n');
    const permissions = new PermissionManager('ask', true, prompt);
    expect((await permissions.approve('bash', {})).allowed).toBe(true);
    expect((await permissions.approve('bash', {})).allowed).toBe(false);
    expect((await permissions.approve('edit_file', {})).allowed).toBe(true);
    expect((await permissions.approve('edit_file', {})).allowed).toBe(true);
    // As in Claude Code, allowing edits covers writing files too.
    expect((await permissions.approve('write_file', {})).allowed).toBe(true);
    expect((await permissions.approve('bash', { command: 'ls' })).allowed).toBe(false);
    permissions.setMode('ask');
    expect((await permissions.approve('edit_file', {})).allowed).toBe(false);
  });

  it('auto-approves full mode without a terminal but respects cancellation', async () => {
    const prompt = vi.fn(async () => 'n');
    const permissions = new PermissionManager('full', false, prompt);
    expect(await permissions.approve('bash', {})).toEqual({ allowed: true });
    expect(await permissions.approve('bash', {}, AbortSignal.abort())).toMatchObject({
      allowed: false,
      reason: 'Operation cancelled.',
    });
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe('edit and plan modes', () => {
  it('auto-approves file edits in edits mode but still asks for shell commands', async () => {
    const prompt = vi.fn(async () => 'n');
    const permissions = new PermissionManager('edits', true, prompt, '/project');
    expect(await permissions.approve('edit_file', { path: 'a.ts' })).toEqual({ allowed: true });
    expect(await permissions.approve('Write', { file_path: '/project/b.ts' })).toEqual({
      allowed: true,
    });
    expect((await permissions.approve('bash', { command: 'rm -rf build' })).allowed).toBe(false);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('keeps plan mode read-only except plan files, and asks before shell commands', async () => {
    const prompt = vi.fn(async () => 'always');
    const permissions = new PermissionManager('plan', true, prompt, '/project');
    expect(await permissions.approve('grep', { pattern: 'x' })).toEqual({ allowed: true });
    expect(await permissions.approve('write_file', { path: '.arncode/plans/refactor.md' })).toEqual(
      { allowed: true },
    );
    const denied = await permissions.approve('edit_file', { path: 'src/app.ts' });
    expect(denied).toMatchObject({ allowed: false, reason: expect.stringContaining('read-only') });
    expect(
      (await permissions.approve('write_file', { path: '.arncode/plans/../../escape.md' })).allowed,
    ).toBe(false);
    expect((await permissions.approve('bash', { command: 'ls' })).allowed).toBe(true);
    expect((await permissions.approve('bash', { command: 'ls -la' })).allowed).toBe(true);
    // "Always" covered ls commands for the session; a different command asks again.
    expect((await permissions.approve('bash', { command: 'rm x' })).allowed).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(2);
    const headless = new PermissionManager('plan', false, prompt, '/project');
    expect(await headless.approve('bash', { command: 'ls' })).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('plan mode requires an interactive terminal'),
    });
  });

  it('does not treat a linked plan directory as a place for plans', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'arncode-plan-'));
    try {
      await mkdir(path.join(project, 'src'));
      await mkdir(path.join(project, '.arncode'));
      await symlink('../src', path.join(project, '.arncode', 'plans'));
      const permissions = new PermissionManager('plan', true, async () => 'n', project);
      expect(
        (await permissions.approve('write_file', { path: '.arncode/plans/app.ts' })).allowed,
      ).toBe(false);
      expect(
        (await permissions.approve('Write', { file_path: path.join(project, 'src', 'x.md') }))
          .allowed,
      ).toBe(false);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe('permission rules', () => {
  const ask = () => vi.fn(async () => 'n');

  it('denies in every mode and allows matching calls without asking', async () => {
    const rules = {
      allow: ['Bash(npm test:*)', 'Bash(git status)', 'Edit(src/**)', 'mcp__docs'],
      deny: ['Bash(rm -rf:*)', 'Read(secrets/**)', 'WebFetch(domain:evil.example)'],
    };
    const prompt = ask();
    const full = new PermissionManager('full', true, prompt, '/project', rules);
    expect(await full.approve('bash', { command: 'ls && rm -rf build' })).toMatchObject({
      allowed: false,
      reason: 'Blocked by your permission rule Bash(rm -rf:*).',
    });
    expect((await full.approve('read_file', { path: 'secrets/key.txt' })).allowed).toBe(false);
    expect((await full.approve('Read', { file_path: '/project/secrets/a' })).allowed).toBe(false);
    expect((await full.approve('WebFetch', { url: 'https://api.evil.example/x' })).allowed).toBe(
      false,
    );
    const asking = new PermissionManager('ask', true, prompt, '/project', rules);
    for (const command of [
      'npm test',
      'npm test -- --watch',
      'git status',
      'npm test && git status',
    ])
      expect((await asking.approve('bash', { command })).allowed).toBe(true);
    expect((await asking.approve('edit_file', { path: 'src/app.ts' })).allowed).toBe(true);
    expect((await asking.approve('mcp__docs__search', {})).allowed).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    // Every chained part must be allowed, and hidden commands never are.
    for (const command of [
      'npm test && curl x',
      'npm test $(curl x)',
      'npm testing',
      'git status -s',
    ])
      expect((await asking.approve('bash', { command })).allowed).toBe(false);
    expect((await asking.approve('edit_file', { path: 'README.md' })).allowed).toBe(false);
    expect(prompt).toHaveBeenCalledTimes(5);
    // Plan mode stays read-only even where a rule allows edits.
    const planning = new PermissionManager('plan', true, prompt, '/project', rules);
    expect((await planning.approve('edit_file', { path: 'src/app.ts' })).allowed).toBe(false);
    expect((await planning.approve('bash', { command: 'npm test' })).allowed).toBe(true);
  });

  it('offers a command prefix, not the whole shell, for the rest of the session', () => {
    expect(sessionRule('bash', { command: 'npm run build -- --prod' })).toBe('Bash(npm run:*)');
    expect(sessionRule('bash', { command: 'pytest -x tests' })).toBe('Bash(pytest:*)');
    // Anything but a plain command is allowed again only exactly as it was.
    for (const command of ['make && make install', 'FOO=1 npm test', 'sudo apt update', 'ls > out'])
      expect(sessionRule('bash', { command })).toBe(`Bash(${command})`);
    expect(sessionRule('edit_file', { path: 'a.ts' })).toBe('Edit');
  });
});

describe('shell rules under pressure', () => {
  const rules = {
    allow: ['Bash(npm test:*)', 'Edit(src/**)', 'mcp__github'],
    deny: ['Bash(rm -rf:*)', 'Read(*.env)', 'Edit(config/**)', 'Read(//etc/**)'],
  };
  const manager = (mode: 'full' | 'ask' | 'plan') =>
    new PermissionManager(mode, true, async () => 'n', '/project', rules);

  it('blocks a denied command however it is dressed up', async () => {
    const full = manager('full');
    for (const command of [
      'FOO=1 rm -rf x',
      'true & rm -rf x',
      '(rm -rf x)',
      '{ rm -rf x; }',
      'echo $(rm -rf x)',
      'echo $(cat $(rm -rf x))',
      'echo `rm -rf x`',
      '\\rm -rf x',
      'rm \\\n-rf x',
      'command rm -rf x',
      'sudo rm -rf x',
      'env A=1 rm -rf x',
      'bash -c "rm -rf x"',
      "'rm' -rf x",
    ])
      expect((await full.approve('bash', { command })).allowed, command).toBe(false);
    expect((await full.approve('bash', { command: 'rm x' })).allowed).toBe(true);
  });

  it('allows only commands it can see whole', async () => {
    const asking = manager('ask');
    for (const command of [
      'npm test & rm -rf ~',
      'npm test > ~/.bashrc',
      'npm test; curl x',
      'NODE_OPTIONS=--require=x npm test',
      ';',
      '&&',
    ])
      expect((await asking.approve('bash', { command })).allowed, command).toBe(false);
    for (const command of ['npm test', 'npm test 2>&1', 'npm test >/dev/null 2>&1'])
      expect((await asking.approve('bash', { command })).allowed, command).toBe(true);
  });

  it('covers tool families, gitignore-style names, absolute paths and plan mode', async () => {
    const full = manager('full');
    expect((await full.approve('write_file', { path: 'config/app.json' })).allowed).toBe(false);
    expect((await full.approve('read_file', { path: 'deploy/prod.env' })).allowed).toBe(false);
    expect((await full.approve('Read', { file_path: '/etc/passwd' })).allowed).toBe(false);
    expect((await full.approve('read_file', { path: 'src/app.ts' })).allowed).toBe(true);
    const planning = manager('plan');
    expect((await planning.approve('mcp__github__create_pull_request', {})).allowed).toBe(false);
    expect((await planning.approve('bash', { command: 'npm test' })).allowed).toBe(true);
  });
});
