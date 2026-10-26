import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  discoverSkills,
  loadSkill,
  MAX_SKILL_BODY_BYTES,
  type SkillLocations,
} from '../src/skills.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'arncode-skills-'));
  directories.push(directory);
  const cwd = join(directory, 'project');
  const locations: SkillLocations = {
    configDir: join(directory, 'state'),
    homeDir: join(directory, 'home'),
  };
  await mkdir(cwd);
  const roots = [
    join(cwd, '.arncode', 'skills'),
    join(cwd, '.claude', 'skills'),
    join(locations.configDir!, 'skills'),
    join(locations.homeDir!, '.claude', 'skills'),
  ];
  return { directory, cwd, locations, roots };
}

async function skill(root: string, folder: string, content: string, filename = 'SKILL.md') {
  const file = join(root, folder, filename);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

function document(name: string, description: string, body: string) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

describe('skills discovery and loading', () => {
  it('discovers metadata only and loads the complete selected body on demand', async () => {
    const { cwd, locations, roots } = await setup();
    const body = '# Review the repository\n\nUse ./references/checklist.md.\n';
    const file = await skill(
      roots[0]!,
      'review',
      document('review', 'Review project changes.', body),
    );
    expect(await discoverSkills(cwd, locations)).toEqual([
      { name: 'review', description: 'Review project changes.' },
    ]);
    const loaded = await loadSkill(cwd, 'review', locations);
    expect(loaded).toEqual({
      name: 'review',
      description: 'Review project changes.',
      path: file,
      basePath: dirname(file),
      body,
    });
  });

  it('uses deterministic project and compatibility precedence by declared name', async () => {
    const { cwd, locations, roots } = await setup();
    for (let index = 0; index < roots.length; index++) {
      await skill(
        roots[index]!,
        'same-folder',
        document('review', `Source ${index}.`, `Body ${index}.`),
      );
    }
    await skill(roots[2]!, 'one', document('lint', 'Check formatting.', 'Run the formatter.'));
    await skill(
      roots[3]!,
      'two',
      document('test', 'Run project tests.', 'Inspect the test scripts.'),
    );
    expect(await discoverSkills(cwd, locations)).toEqual([
      { name: 'lint', description: 'Check formatting.' },
      { name: 'review', description: 'Source 0.' },
      { name: 'test', description: 'Run project tests.' },
    ]);
    await rm(join(roots[0]!, 'same-folder'), { recursive: true });
    expect((await loadSkill(cwd, 'review', locations)).body).toBe('Body 1.');
    await rm(join(roots[1]!, 'same-folder'), { recursive: true });
    expect((await loadSkill(cwd, 'review', locations)).body).toBe('Body 2.');
  });

  it('parses quoted, multiline, CRLF, and bounded alias metadata without executing content', async () => {
    const { cwd, locations, roots, directory } = await setup();
    const marker = join(directory, 'should-not-exist');
    await skill(
      roots[0]!,
      'quoted',
      `\uFEFF---\r\nname: "quoted"\r\ndescription: >-\r\n  Review: parser behavior\r\n  across multiple lines.\r\n---\r\nnode -e "require('fs').writeFileSync('${marker}', 'unsafe')"\r\n`,
    );
    await skill(
      roots[0]!,
      'alias',
      '---\nname: alias\nsummary: &summary A reusable description.\ndescription: *summary\n---\nNo startup action.\n',
      'skill.md',
    );
    expect(await discoverSkills(cwd, locations)).toEqual([
      { name: 'alias', description: 'A reusable description.' },
      { name: 'quoted', description: 'Review: parser behavior across multiple lines.' },
    ]);
    expect((await loadSkill(cwd, 'quoted', locations)).body).toContain('writeFileSync');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ignores malformed metadata, duplicate YAML keys, unsafe tags, and alias expansion bombs', async () => {
    const { cwd, locations, roots } = await setup();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await skill(roots[0]!, 'missing', '# No frontmatter\n');
    await skill(roots[0]!, 'no-description', '---\nname: incomplete\n---\nBody');
    await skill(roots[0]!, 'wrong-type', '---\nname: wrong\ndescription: [a, b]\n---\nBody');
    await skill(
      roots[0]!,
      'duplicate',
      '---\nname: duplicate\nname: second\ndescription: Duplicate name.\n---\nBody',
    );
    await skill(
      roots[0]!,
      'unsafe',
      '---\nname: unsafe\ndescription: !!js/function "function () { return true; }"\n---\nBody',
    );
    await skill(
      roots[0]!,
      'bomb',
      '---\nname: bomb\ndescription: Too many aliases.\na: &a [1, 2, 3, 4, 5, 6, 7, 8]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b]\n---\nBody',
    );
    expect(await discoverSkills(cwd, locations)).toEqual([]);
    expect(warning).not.toHaveBeenCalled();
    await expect(loadSkill(cwd, 'missing', locations)).rejects.toThrow('was not found');
    await expect(loadSkill(cwd, '../secret', locations)).rejects.toThrow('installed skill name');
  });

  it('bounds file/body sizes and redacts secrets before returning metadata or body', async () => {
    const { cwd, locations, roots } = await setup();
    const token = ['sk', 'ant', 'synthetic-skill-secret'].join('-');
    await skill(roots[0]!, 'secret', document('secret', `Contains ${token}`, `Token: ${token}\n`));
    await skill(
      roots[0]!,
      'oversized',
      document('oversized', 'Too much text.', 'x'.repeat(MAX_SKILL_BODY_BYTES + 1)),
    );
    await skill(
      roots[0]!,
      'huge',
      document('huge', 'Far too much text.', 'x'.repeat(MAX_SKILL_BODY_BYTES + 9000)),
    );
    const index = await discoverSkills(cwd, locations);
    expect(JSON.stringify(index)).not.toContain(token);
    expect(index.map(({ name }) => name)).not.toContain('huge');
    expect((await loadSkill(cwd, 'secret', locations)).body).toBe('Token: [redacted]\n');
    await expect(loadSkill(cwd, 'oversized', locations)).rejects.toThrow('120 kB limit');
  });

  it.skipIf(process.platform === 'win32')(
    'skips FIFO files and follows linked skill directories without hanging',
    async () => {
      const { cwd, locations, roots, directory } = await setup();
      const fifo = join(roots[0]!, 'pipe', 'SKILL.md');
      await mkdir(dirname(fifo), { recursive: true });
      await promisify(execFile)('mkfifo', [fifo]);
      const installed = join(directory, 'installed');
      await skill(
        installed,
        'linked',
        document('linked', 'A linked installation.', 'Use the linked skill.'),
      );
      await symlink(join(installed, 'linked'), join(roots[0]!, 'linked'), 'dir');
      expect(await discoverSkills(cwd, locations)).toEqual([
        { name: 'linked', description: 'A linked installation.' },
      ]);
      expect((await loadSkill(cwd, 'linked', locations)).basePath).toBe(join(installed, 'linked'));
    },
  );
});
