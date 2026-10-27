import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { systemPrompt } from '../src/prompt.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('instruction and skill context', () => {
  it('combines global and project instructions with a stable metadata-only skills index', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'arncode-prompt-'));
    directories.push(dir);
    const config = path.join(dir, 'config');
    const project = path.join(dir, 'project');
    const skill = path.join(project, '.arncode', 'skills', 'review');
    await mkdir(config, { recursive: true });
    await mkdir(skill, { recursive: true });
    vi.stubEnv('ARNCODE_CONFIG_DIR', config);
    await writeFile(path.join(config, 'AGENTS.md'), 'Global preference: run focused checks.');
    await writeFile(path.join(project, 'AGENTS.md'), 'Project preference: preserve existing APIs.');
    await writeFile(path.join(project, 'CLAUDE.md'), 'Project context: TypeScript library.');
    await writeFile(
      path.join(skill, 'SKILL.md'),
      '---\nname: review\ndescription: Review a library change.\n---\nPrivate workflow body marker.\n',
    );
    const prompt = await systemPrompt(project);
    expect(prompt).toContain('Global preference: run focused checks.');
    expect(prompt).toContain('Project preference: preserve existing APIs.');
    expect(prompt).toContain('Project context: TypeScript library.');
    expect(prompt).toContain('review: Review a library change.');
    expect(prompt).not.toContain('Private workflow body marker.');
    expect(prompt).not.toContain(skill);
    expect(await systemPrompt(project)).toBe(prompt);
    expect(await systemPrompt(project, true)).toContain('mcp__arncode__skill');
    // API sessions describe their environment; the OAuth preset has its own.
    expect(prompt).toContain('- Not a Git repository');
    expect(await systemPrompt(project, true)).not.toContain('Environment at the start');
  });

  it('falls back to Claude Code instruction files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'arncode-prompt-'));
    directories.push(dir);
    const project = path.join(dir, 'project');
    await mkdir(path.join(dir, 'home', '.claude'), { recursive: true });
    await mkdir(project);
    vi.stubEnv('ARNCODE_CONFIG_DIR', path.join(dir, 'config'));
    vi.stubEnv('HOME', path.join(dir, 'home'));
    await writeFile(path.join(dir, 'home', '.claude', 'CLAUDE.md'), 'Claude Code global marker.');
    await writeFile(path.join(project, 'CLAUDE.local.md'), 'Local marker.');
    const prompt = await systemPrompt(project);
    expect(prompt).toContain('Global CLAUDE.md:\nClaude Code global marker.');
    expect(prompt).toContain('Project CLAUDE.local.md:\nLocal marker.');
    await mkdir(path.join(dir, 'config'));
    await writeFile(path.join(dir, 'config', 'AGENTS.md'), 'ArnCode global marker.');
    expect(await systemPrompt(project)).not.toContain('Claude Code global marker.');
  });
});
