import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { getConfigDir } from './config.js';
import { redact } from './redact.js';
import { isFileError } from './storage.js';

const MAX_FRONTMATTER_BYTES = 8192;
export const MAX_SKILL_BODY_BYTES = 120_000;
const MAX_FILE_BYTES = MAX_FRONTMATTER_BYTES + MAX_SKILL_BODY_BYTES;
const skillName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface SkillMetadata {
  name: string;
  description: string;
}

export interface LoadedSkill extends SkillMetadata {
  path: string;
  basePath: string;
  body: string;
}

export interface SkillLocations {
  configDir?: string;
  homeDir?: string;
}

interface SkillEntry extends SkillMetadata {
  path: string;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function frontmatter(text: string): { yaml: string; bodyOffset: number } | undefined {
  const opening = /^\uFEFF?---[ \t]*\r?\n/.exec(text);
  if (!opening) return undefined;
  const start = opening[0].length;
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(text.slice(start));
  if (!closing) return undefined;
  return {
    yaml: text.slice(start, start + closing.index),
    bodyOffset: start + closing.index + closing[0].length,
  };
}

function metadata(text: string): SkillMetadata | undefined {
  const header = frontmatter(text);
  if (!header || Buffer.byteLength(text.slice(0, header.bodyOffset)) > MAX_FRONTMATTER_BYTES) {
    return undefined;
  }
  try {
    const document = parseDocument(header.yaml, {
      schema: 'core',
      version: '1.2',
      uniqueKeys: true,
      prettyErrors: false,
      logLevel: 'silent',
    });
    if (document.errors.length || document.warnings.length) return undefined;
    const value: unknown = document.toJS({ maxAliasCount: 20 });
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    if (!('name' in value) || !('description' in value)) return undefined;
    if (typeof value.name !== 'string' || typeof value.description !== 'string') return undefined;
    const name = value.name.trim();
    const description = value.description.replace(/\s+/g, ' ').trim();
    if (
      !skillName.test(name) ||
      redact(name) !== name ||
      !description ||
      description.length > 1024
    ) {
      return undefined;
    }
    return { name, description: redact(description) };
  } catch {
    return undefined;
  }
}

async function entries(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].some((code) => isFileError(error, code)))
      return [];
    throw new Error('Could not read a skill directory. Check its access permissions.', {
      cause: error,
    });
  }
}

async function skillFiles(root: string): Promise<string[]> {
  const rootEntries = await entries(root);
  const directories = rootEntries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => join(root, entry.name))
    .sort(compare);
  const files: string[] = [];
  for (const directory of [root, ...directories]) {
    const candidates = (directory === root ? rootEntries : await entries(directory))
      .filter((entry) => entry.name.toLowerCase() === 'skill.md' && !entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => Number(b === 'SKILL.md') - Number(a === 'SKILL.md') || compare(a, b));
    for (const file of candidates) files.push(join(directory, file));
  }
  return files;
}

async function readSkillFile(file: string, headerOnly: boolean): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
    const buffer = Buffer.alloc(headerOnly ? MAX_FRONTMATTER_BYTES : MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (!headerOnly && length > MAX_FILE_BYTES) return undefined;
    return buffer.subarray(0, length).toString('utf8');
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].some((code) => isFileError(error, code))) {
      return undefined;
    }
    throw new Error(`Could not read ${basename(file)}. Check its access permissions.`, {
      cause: error,
    });
  } finally {
    await handle?.close();
  }
}

async function discoverEntries(cwd: string, locations: SkillLocations): Promise<SkillEntry[]> {
  const roots = [
    join(resolve(cwd), '.arncode', 'skills'),
    join(resolve(cwd), '.claude', 'skills'),
    join(resolve(locations.configDir ?? getConfigDir()), 'skills'),
    join(resolve(locations.homeDir ?? homedir()), '.claude', 'skills'),
  ];
  const found = new Map<string, SkillEntry>();
  for (const root of [...new Set(roots)]) {
    for (const file of await skillFiles(root)) {
      const text = await readSkillFile(file, true);
      const info = text === undefined ? undefined : metadata(text);
      if (info && !found.has(info.name)) found.set(info.name, { ...info, path: file });
    }
  }
  return [...found.values()].sort((a, b) => compare(a.name, b.name));
}

export async function discoverSkills(
  cwd: string,
  locations: SkillLocations = {},
): Promise<SkillMetadata[]> {
  return (await discoverEntries(cwd, locations)).map(({ name, description }) => ({
    name,
    description,
  }));
}

export async function loadSkill(
  cwd: string,
  name: string,
  locations: SkillLocations = {},
): Promise<LoadedSkill> {
  if (!skillName.test(name)) throw new Error('Use an installed skill name.');
  const entry = (await discoverEntries(cwd, locations)).find((skill) => skill.name === name);
  if (!entry)
    throw new Error(
      redact(`Skill '${name}' was not found. Check its SKILL.md name and description.`),
    );
  const content = await readSkillFile(entry.path, false);
  const info = content === undefined ? undefined : metadata(content);
  const header = content === undefined ? undefined : frontmatter(content);
  if (!info || info.name !== name || !header || content === undefined) {
    throw new Error('The skill changed or is unreadable. Check its SKILL.md and try again.');
  }
  const body = content.slice(header.bodyOffset);
  if (Buffer.byteLength(body) > MAX_SKILL_BODY_BYTES)
    throw new Error('Skill body exceeds the 120 kB limit.');
  const file = await realpath(entry.path);
  return { ...info, path: file, basePath: dirname(file), body: redact(body) };
}
