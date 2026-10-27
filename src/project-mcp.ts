import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getConfigDir } from './config.js';
import { mcpServersSchema, type McpServers } from './mcp.js';
import { atomicWriteJson, isFileError, readJson, withFileLock } from './storage.js';

/** `${NAME}` and `${NAME:-default}` from the environment, as in Claude Code's `.mcp.json`. */
function expand(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback?: string) => env[name] ?? fallback ?? '',
  );
}

function expandAll(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') return expand(value, env);
  if (Array.isArray(value)) return value.map((item) => expandAll(item, env));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandAll(item, env)]),
    );
  return value;
}

export interface ProjectMcp {
  servers: McpServers;
  /** Identifies these exact definitions; a changed file needs approval again. */
  digest: string;
}

/** Servers from the project's `.mcp.json`, or undefined when there are none. */
export async function projectMcp(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectMcp | undefined> {
  // A plain read: the project's files keep their permissions.
  const text = await readFile(path.join(cwd, '.mcp.json'), 'utf8').catch((error: unknown) => {
    if (isFileError(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (text === undefined) return undefined;
  let file: { mcpServers?: unknown };
  try {
    file = JSON.parse(text) as { mcpServers?: unknown };
  } catch {
    throw new Error('.mcp.json is not valid JSON.');
  }
  if (!file?.mcpServers || typeof file.mcpServers !== 'object') return undefined;
  // Values are filled in before checking, so `"url": "${MCP_URL}"` works.
  const parsed = mcpServersSchema.safeParse(expandAll(file.mcpServers, env));
  if (!parsed.success) throw new Error('.mcp.json has an invalid server definition.');
  if (!Object.keys(parsed.data).length) return undefined;
  // The digest covers the file as written, before environment values are filled in.
  const digest = createHash('sha256').update(JSON.stringify(file.mcpServers)).digest('hex');
  return { servers: parsed.data, digest };
}

function trustFile(dir: string): string {
  return path.join(dir, 'trusted-mcp.json');
}

/** Whether the user approved these project servers. */
export async function isTrusted(
  cwd: string,
  digest: string,
  dir = getConfigDir(),
): Promise<boolean> {
  const trusted = ((await readJson(trustFile(dir))) ?? {}) as Record<string, unknown>;
  return trusted[cwd] === digest;
}

export async function trust(cwd: string, digest: string, dir = getConfigDir()): Promise<void> {
  const file = trustFile(dir);
  await withFileLock(file, async () => {
    const trusted = ((await readJson(file)) ?? {}) as Record<string, unknown>;
    await atomicWriteJson(file, { ...trusted, [cwd]: digest });
  });
}
