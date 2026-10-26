import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRunner } from '../src/tools/index.js';
import { createPathPolicy } from '../src/tools/paths.js';
import type { AgentUI, Approve } from '../src/types.js';

let directory: string;
let runner: ToolRunner;
let ui: AgentUI;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'arncode-tools-'));
  ui = {
    text: vi.fn(),
    endText: vi.fn(),
    status: vi.fn(),
    idle: vi.fn(),
    notice: vi.fn(),
    tool: vi.fn(),
    diff: vi.fn(),
  };
  runner = new ToolRunner({ cwd: directory, approve: async () => ({ allowed: true }), ui });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

describe('project file tools', () => {
  it('matches segment wildcards, literal punctuation and complete protected subtrees', async () => {
    const policy = await createPathPolicy(directory, [
      'private/**',
      'keys/key?.txt',
      'literal[1].txt',
    ]);
    for (const file of ['private', 'private/nested/file', 'keys/key1.txt', 'literal[1].txt'])
      expect(policy.matches(path.join(directory, file)), file).toBe(true);
    for (const file of ['private-other/file', 'keys/key12.txt', 'literal1.txt'])
      expect(policy.matches(path.join(directory, file)), file).toBe(false);
    const all = await createPathPolicy(directory, [path.parse(directory).root]);
    expect(all.matches(path.join(directory, 'any-file'))).toBe(true);
  });

  it('protects default env files, configured paths, and aliases across reads, writes and searches', async () => {
    await mkdir(path.join(directory, 'nested'));
    await mkdir(path.join(directory, 'private'));
    await mkdir(path.join(directory, 'state'));
    vi.stubEnv('ARNCODE_CONFIG_DIR', path.join(directory, 'state'));
    for (const file of [
      '.env',
      '.env.example',
      'nested/.env.production',
      'nested/key.secret',
      'private/account.txt',
      'private/line\nbreak.txt',
      'state/credentials.json',
    ]) {
      await writeFile(path.join(directory, file), 'blocked_payload');
    }
    await writeFile(path.join(directory, 'public.txt'), 'public_payload');
    await symlink(path.join(directory, 'private'), path.join(directory, 'protected-link'));
    await symlink(path.join(directory, 'private'), path.join(directory, 'other-link'));
    await symlink(path.join(directory, '.env'), path.join(directory, 'env-alias.txt'));
    await symlink(path.join(directory, 'public.txt'), path.join(directory, '.env.alias'));
    runner = new ToolRunner({
      cwd: directory,
      approve: async () => ({ allowed: true }),
      ui,
      protectedPaths: ['protected-link', 'nested/*.secret'],
    });
    for (const file of [
      '.env',
      '.env.example',
      '.env.alias',
      'nested/.env.production',
      'nested/key.secret',
      'private/account.txt',
      'private/line\nbreak.txt',
      'other-link/account.txt',
      'env-alias.txt',
      'state/credentials.json',
    ]) {
      const read = await runner.run('read_file', { path: file });
      expect(read.is_error, file).toBe(true);
      expect(read.content, file).toContain('protectedPaths');
      expect(read.content).not.toContain('blocked_payload');
    }
    expect(
      (await runner.run('write_file', { path: 'nested/.env.new', content: 'changed' })).is_error,
    ).toBe(true);
    expect(
      (
        await runner.run('edit_file', {
          path: 'other-link/account.txt',
          old_string: 'blocked_payload',
          new_string: 'changed',
        })
      ).is_error,
    ).toBe(true);
    expect(await readFile(path.join(directory, 'private/account.txt'), 'utf8')).toBe(
      'blocked_payload',
    );
    expect((await runner.run('read_file', { path: 'public.txt' })).content).toContain(
      'public_payload',
    );
    const glob = await runner.run('glob', { pattern: '**/*' });
    expect(glob.is_error).toBeUndefined();
    expect(glob.content).toBe('public.txt');
    const grep = await runner.run('grep', { pattern: 'payload', literal: true });
    expect(grep.is_error).toBeUndefined();
    expect(grep.content).toContain('public.txt:1:public_payload');
    expect(grep.content).not.toContain('blocked_payload');
    expect((await runner.run('glob', { path: 'private', pattern: '**/*' })).is_error).toBe(true);
    expect((await runner.run('grep', { path: 'other-link', pattern: 'payload' })).is_error).toBe(
      true,
    );
  });

  it('writes nested files, reads ranges, and preserves literal replacements', async () => {
    const written = await runner.run('write_file', {
      path: 'src/greeting.txt',
      content: 'hello\nhello world\nbye\n',
    });
    expect(written.is_error).toBeUndefined();
    expect(await readFile(path.join(directory, 'src/greeting.txt'), 'utf8')).toBe(
      'hello\nhello world\nbye\n',
    );
    const read = await runner.run('read_file', { path: 'src/greeting.txt', offset: 2, limit: 1 });
    expect(read.content).toContain('2: hello world');
    expect(read.content).toContain('offset 3');
    const edited = await runner.run('edit_file', {
      path: 'src/greeting.txt',
      old_string: 'hello world',
      new_string: '$& replacement',
    });
    expect(edited.is_error).toBeUndefined();
    expect(await readFile(path.join(directory, 'src/greeting.txt'), 'utf8')).toContain(
      '$& replacement',
    );
    expect(ui.diff).toHaveBeenLastCalledWith(
      'src/greeting.txt',
      'hello\nhello world\nbye\n',
      'hello\n$& replacement\nbye\n',
    );
  });

  it('rejects ambiguous or absent edits and applies explicit replace_all', async () => {
    await writeFile(path.join(directory, 'a.txt'), 'same same');
    const ambiguous = await runner.run('edit_file', {
      path: 'a.txt',
      old_string: 'same',
      new_string: 'new',
    });
    expect(ambiguous.is_error).toBe(true);
    expect(ambiguous.content).toContain('2 times');
    expect(ui.notice).toHaveBeenCalledWith(expect.stringMatching(/edit_file failed[\s\S]*2 times/));
    expect(await readFile(path.join(directory, 'a.txt'), 'utf8')).toBe('same same');
    expect(ui.diff).not.toHaveBeenCalled();
    const absent = await runner.run('edit_file', {
      path: 'a.txt',
      old_string: 'missing',
      new_string: 'new',
    });
    expect(absent.is_error).toBe(true);
    const replaced = await runner.run('edit_file', {
      path: 'a.txt',
      old_string: 'same',
      new_string: 'new',
      replace_all: true,
    });
    expect(replaced.is_error).toBeUndefined();
    expect(await readFile(path.join(directory, 'a.txt'), 'utf8')).toBe('new new');
  });

  it('denies writes before filesystem changes and validates inputs', async () => {
    const approve: Approve = vi.fn(async () => ({
      allowed: false,
      reason: 'Permission denied without a terminal.',
    }));
    runner = new ToolRunner({ cwd: directory, approve, ui });
    const denied = await runner.run('write_file', {
      path: 'nested/file.txt',
      content: 'do not write',
    });
    expect(denied).toEqual({ content: 'Permission denied without a terminal.', is_error: true });
    await expect(readFile(path.join(directory, 'nested/file.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const invalid = await runner.run('edit_file', { path: 'x', old_string: '', new_string: 'y' });
    expect(invalid.is_error).toBe(true);
    expect(invalid.content).toContain('old_string');
    expect(approve).toHaveBeenCalledTimes(1);
    expect((await runner.run('unknown', {})).is_error).toBe(true);
  });

  it('rejects path traversal and symlink escapes, including missing targets', async () => {
    await symlink(tmpdir(), path.join(directory, 'outside'), 'dir');
    for (const file of ['../escaped.txt', 'outside/escaped.txt']) {
      const result = await runner.run('write_file', { path: file, content: 'no' });
      expect(result.is_error).toBe(true);
      expect(result.content).toMatch(/outside|inside/);
    }
    await symlink(path.join(tmpdir(), 'missing-target-arncode'), path.join(directory, 'dangling'));
    const result = await runner.run('write_file', { path: 'dangling', content: 'no' });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('dangling symlink');
  });

  it('rejects binary files and bounds large line output', async () => {
    await writeFile(path.join(directory, 'binary'), Buffer.from([0, 1, 2]));
    expect((await runner.run('read_file', { path: 'binary' })).is_error).toBe(true);
    await writeFile(path.join(directory, 'large'), 'x'.repeat(200_000));
    const result = await runner.run('read_file', { path: 'large' });
    expect(result.content.length).toBeLessThan(48_200);
    expect(result.content).toContain('truncated');
  });

  it('finds files and line matches without searching dependencies or symlinks', async () => {
    await mkdir(path.join(directory, 'src'));
    await mkdir(path.join(directory, 'node_modules'));
    await writeFile(path.join(directory, 'src/a.ts'), 'const a = 1;\nconst b = 2;\n');
    await writeFile(path.join(directory, 'node_modules/hidden.ts'), 'const hidden = 3;');
    await symlink(path.join(directory, 'src/a.ts'), path.join(directory, 'linked.ts'));
    const listing = await runner.run('list_dir', {});
    expect(listing.content).toContain('src/');
    const found = await runner.run('glob', { pattern: '**/*.ts' });
    expect(found.content).toContain('src/a.ts');
    expect(found.content).not.toContain('hidden');
    expect(found.content).not.toContain('linked');
    const matches = await runner.run('grep', { pattern: '^const b', glob: '**/*.ts' });
    expect(matches.is_error).toBeUndefined();
    expect(matches.content).toContain('src/a.ts:2:const b = 2;');
    expect(matches.content).not.toContain('hidden');
    const literal = await runner.run('grep', {
      pattern: 'CONST B',
      literal: true,
      ignore_case: true,
    });
    expect(literal.content).toContain('src/a.ts:2:');
    const invalid = await runner.run('grep', { pattern: '[' });
    expect(invalid.is_error).toBe(true);
    expect(invalid.content).toContain('Search failed');
  });
});

describe('shell tool', () => {
  it('does not apply file path policies to shell commands or explicit skill loading', async () => {
    await symlink('loop', path.join(directory, 'loop'));
    const skillDir = path.join(directory, '.arncode/skills/example');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: example\ndescription: Load a test procedure.\n---\nLoaded fixture instructions.\n',
    );
    runner = new ToolRunner({
      cwd: directory,
      approve: async () => ({ allowed: true }),
      ui,
      protectedPaths: ['loop'],
    });
    expect((await runner.run('bash', { command: "printf 'shell works'" })).content).toContain(
      'shell works',
    );
    const skill = await runner.run('skill', { name: 'example' });
    expect(skill.is_error).toBeUndefined();
    expect(skill.content).toContain('Loaded fixture instructions.');
  });

  it('uses project cwd and returns separate streams, exit status, and bounded output', async () => {
    const result = await runner.run('bash', { command: 'pwd; printf err >&2; exit 7' });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain(`stdout:\n${directory}`);
    expect(result.content).toContain('stderr:\nerr');
    expect(result.content).toContain('Exit code: 7');
    expect(ui.notice).toHaveBeenCalledWith(
      expect.stringMatching(/bash failed[\s\S]*Exit code: 7[\s\S]*stderr:\n\s+err/),
    );
    expect(ui.status).toHaveBeenCalledWith('Running bash');
    expect(ui.idle).toHaveBeenCalled();
    const large = await runner.run('bash', {
      command: `${quote(process.execPath)} -e ${quote('process.stdout.write("x".repeat(100000));process.stderr.write("end")')}`,
    });
    expect(large.is_error).toBe(false);
    expect(large.content.length).toBeLessThan(49_000);
    expect(large.content).toContain('Truncated');
    expect(large.content).toContain('stderr:\nend');
    const both = await runner.run('bash', {
      command: `${quote(process.execPath)} -e ${quote('process.stdout.write("x".repeat(30000));process.stderr.write("y".repeat(30000)+"\\nFinal render error");process.exitCode=7')}`,
    });
    expect(both.content.length).toBeLessThan(49_000);
    expect(both.content).toContain('Final render error');
    expect(ui.notice).toHaveBeenLastCalledWith(expect.stringContaining('Final render error'));
  });

  it('stops the process group on timeout before descendants can write', async () => {
    const command = `${quote(process.execPath)} -e ${quote('setTimeout(() => require("fs").writeFileSync("escaped", "no"), 500)')}`;
    const result = await runner.run('bash', { command, timeout_ms: 100 });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Timed out');
    expect(ui.notice).toHaveBeenCalledWith(expect.stringContaining('Timed out after 100 ms'));
    await delay(600);
    await expect(readFile(path.join(directory, 'escaped'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('stops background jobs when the shell exits and supports cancellation', async () => {
    const command = `${quote(process.execPath)} -e ${quote('setTimeout(() => require("fs").writeFileSync("background", "no"), 500)')} &`;
    expect((await runner.run('bash', { command })).is_error).toBe(false);
    const controller = new AbortController();
    const pending = runner.run(
      'bash',
      { command: `${quote(process.execPath)} -e ${quote('setTimeout(() => {}, 30000)')}` },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Cancelled');
    await delay(600);
    await expect(readFile(path.join(directory, 'background'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('redacts secrets even when shell output arrives in chunks', async () => {
    const prefix = ['sk', 'ant'].join('-') + '-';
    const secret = prefix + 'example-tool-secret';
    const program = `process.stdout.write(${JSON.stringify(prefix)});setTimeout(()=>process.stdout.write("example-tool-secret done"),20)`;
    const result = await runner.run('bash', {
      command: `${quote(process.execPath)} -e ${quote(program)}`,
    });
    expect(result.content).not.toContain(secret);
    expect(result.content).not.toContain('example-tool-secret');
    expect(result.content).toContain('done');
  });
});
