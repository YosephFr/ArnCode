import fg from 'fast-glob';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { getConfigDir } from '../config.js';
import { redact } from '../redact.js';

export interface CustomCommand {
  name: string;
  description: string;
  argumentHint?: string;
  body: string;
}

const MAX_BYTES = 64_000;

function frontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { data: {}, body: text };
  try {
    const value: unknown = parseDocument(match[1]!, { logLevel: 'silent' }).toJS();
    return {
      data: value && typeof value === 'object' ? (value as Record<string, unknown>) : {},
      body: text.slice(match[0].length),
    };
  } catch {
    return { data: {}, body: text.slice(match[0].length) };
  }
}

/**
 * Prompt templates saved as Markdown: `.arncode/commands` and `.claude/commands` in the project,
 * then the same folders in ArnCode's state directory and the home directory. `git/commit.md`
 * becomes `/git:commit`; the first definition of a name wins.
 */
export async function loadCustomCommands(
  cwd: string,
  reserved: readonly string[] = [],
  locations: { configDir?: string; homeDir?: string } = {},
): Promise<CustomCommand[]> {
  const roots = [
    path.join(cwd, '.arncode', 'commands'),
    path.join(cwd, '.claude', 'commands'),
    path.join(locations.configDir ?? getConfigDir(), 'commands'),
    path.join(locations.homeDir ?? homedir(), '.claude', 'commands'),
  ];
  const found = new Map<string, CustomCommand>();
  for (const root of roots) {
    const files = await fg('**/*.md', {
      cwd: root,
      deep: 4,
      onlyFiles: true,
      followSymbolicLinks: false,
      suppressErrors: true,
    }).catch(() => []);
    for (const file of files.sort()) {
      const name = `/${file.slice(0, -3).split('/').join(':')}`;
      if (!/^\/[A-Za-z0-9][\w.:-]{0,63}$/.test(name) || found.has(name) || reserved.includes(name))
        continue;
      const full = path.join(root, file);
      if (((await stat(full).catch(() => undefined))?.size ?? Infinity) > MAX_BYTES) continue;
      const { data, body } = frontmatter(await readFile(full, 'utf8'));
      const first =
        body
          .split('\n')
          .find((line) => line.trim())
          ?.trim() ?? '';
      found.set(name, {
        name,
        description: redact(
          typeof data.description === 'string' ? data.description : first.slice(0, 80),
        ),
        ...(typeof data['argument-hint'] === 'string'
          ? { argumentHint: data['argument-hint'] }
          : {}),
        body: body.trim(),
      });
    }
  }
  return [...found.values()];
}

/** Split arguments on whitespace, keeping quoted strings together. */
export function splitArguments(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  );
}

/** Fill `$ARGUMENTS` and `$1`…`$9`; without placeholders the arguments follow the template. */
export function expandCommand(command: CustomCommand, args: string): string {
  const values = splitArguments(args);
  const placeholders = /\$ARGUMENTS|\$[1-9]/.test(command.body);
  const filled = command.body
    .replaceAll('$ARGUMENTS', args)
    .replace(/\$([1-9])/g, (_match, index: string) => values[Number(index) - 1] ?? '');
  return placeholders || !args.trim() ? filled : `${filled}\n\n${args}`;
}
