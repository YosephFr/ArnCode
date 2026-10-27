import { createHash } from 'node:crypto';
import path from 'node:path';
import { getConfigDir } from './config.js';
import { mcpServersSchema, type McpServers } from './mcp.js';
import { atomicWriteJson, readJson, withFileLock } from './storage.js';

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
  const file = (await readJson(path.join(cwd, '.mcp.json'))) as
    { mcpServers?: unknown } | undefined;
  if (!file?.mcpServers || typeof file.mcpServers !== 'object') return undefined;
  const parsed = mcpServersSchema.safeParse(file.mcpServers);
  if (!parsed.success) throw new Error('.mcp.json has an invalid server definition.');
  if (!Object.keys(parsed.data).length) return undefined;
  // The digest covers the file as written, before environment values are filled in.
  const digest = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
  return { servers: expandAll(parsed.data, env) as McpServers, digest };
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
