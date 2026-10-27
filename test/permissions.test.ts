import { describe, expect, it, vi } from 'vitest';
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

  it('supports one-time allow, deny, and tool-scoped always for the current session', async () => {
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
    expect((await permissions.approve('write_file', {})).allowed).toBe(false);
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
    expect((await permissions.approve('bash', { command: 'ls' })).allowed).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(2);
    const headless = new PermissionManager('plan', false, prompt, '/project');
    expect(await headless.approve('bash', { command: 'ls' })).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('plan mode requires an interactive terminal'),
    });
  });
});
