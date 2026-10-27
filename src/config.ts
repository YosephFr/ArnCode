import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { loadCredentialCandidates } from './auth.js';
import { hooksSchema } from './hooks.js';
import { mcpServersSchema } from './mcp.js';
import { atomicWriteJson, readJson, withFileLock } from './storage.js';
import type { Settings } from './types.js';

const authSchema = z.enum(['api-key', 'oauth']);
const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const profileSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
export const DEFAULT_PROTECTED_PATHS = [
  '~/.arncode',
  '~/.secrets',
  '~/.ssh',
  '**/.env',
  '**/.env.*',
];
const baseUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  });

const userConfigSchema = z
  .object({
    auth: authSchema.optional(),
    profile: profileSchema.optional(),
    model: z.string().min(1).max(200).regex(/^\S+$/).optional(),
    baseUrl: baseUrlSchema.optional(),
    effort: effortSchema.optional(),
    fast: z.boolean().optional(),
    maxTokens: z.number().int().min(1).max(128000).optional(),
    maxTurns: z.number().int().min(1).max(1000).optional(),
    compactAt: z.number().int().min(20_000).max(10_000_000).optional(),
    webTools: z.boolean().optional(),
    hooks: hooksSchema.optional(),
    mcpServers: mcpServersSchema.optional(),
    permissionMode: z.enum(['full', 'edits', 'ask', 'plan']).optional(),
    protectedPaths: z
      .array(
        z
          .string()
          .min(1)
          .max(4096)
          .refine((value) => !['\0', '\r', '\n'].some((character) => value.includes(character))),
      )
      .max(256)
      .optional(),
  })
  .strict();

export type UserConfig = z.infer<typeof userConfigSchema>;

export const DEFAULTS = {
  auth: 'api-key',
  model: 'claude-opus-5-5',
  effort: 'medium',
  fast: false,
  maxTokens: 64000,
  maxTurns: 80,
  compactAt: 200_000,
  webTools: true,
  permissionMode: 'full',
  protectedPaths: [...DEFAULT_PROTECTED_PATHS],
} satisfies Omit<Settings, 'cwd'>;

export function getConfigDir(): string {
  return process.env.ARNCODE_CONFIG_DIR
    ? resolve(process.env.ARNCODE_CONFIG_DIR)
    : join(homedir(), '.arncode');
}

function validateConfig(value: unknown): UserConfig {
  const parsed = userConfigSchema.safeParse(value);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'fields')),
    ];
    throw new Error(`Invalid configuration: check ${fields.join(', ')}.`);
  }
  return parsed.data;
}

export async function readConfig(dir = getConfigDir()): Promise<UserConfig> {
  const value = await readJson(join(dir, 'config.json'));
  return value === undefined ? {} : validateConfig(value);
}

export async function writeConfig(patch: Partial<UserConfig>, dir = getConfigDir()): Promise<void> {
  const path = join(dir, 'config.json');
  await withFileLock(path, async () => {
    await atomicWriteJson(path, validateConfig({ ...(await readConfig(dir)), ...patch }));
  });
}

function envBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new Error(`${name} must be true, false, 1, or 0.`);
}

function envInteger(value: string | undefined): number | undefined {
  return value === undefined || value === '' ? undefined : Number(value);
}

export function resolveSettings(
  flags: Partial<Settings>,
  env: NodeJS.ProcessEnv = process.env,
  config: UserConfig = {},
): Settings {
  const configuredPaths =
    validateConfig({ protectedPaths: config.protectedPaths }).protectedPaths ?? [];
  const flagPaths = validateConfig({ protectedPaths: flags.protectedPaths }).protectedPaths ?? [];
  const explicitAuth = flags.authRestriction ?? flags.auth ?? env.ARNCODE_AUTH ?? config.auth;
  const pinnedCredential = flags.pinnedCredential ?? flags.profile ?? env.ARNCODE_PROFILE;
  const settings = validateConfig({
    auth: explicitAuth ?? config.auth ?? DEFAULTS.auth,
    profile: pinnedCredential ?? config.profile,
    model:
      flags.model ?? env.ARNCODE_MODEL ?? env.ANTHROPIC_MODEL ?? config.model ?? DEFAULTS.model,
    baseUrl: flags.baseUrl ?? env.ANTHROPIC_BASE_URL ?? config.baseUrl,
    effort: flags.effort ?? env.ARNCODE_EFFORT ?? config.effort ?? DEFAULTS.effort,
    fast:
      flags.fast ?? envBoolean(env.ARNCODE_FAST, 'ARNCODE_FAST') ?? config.fast ?? DEFAULTS.fast,
    maxTokens:
      flags.maxTokens ??
      envInteger(env.ARNCODE_MAX_TOKENS) ??
      config.maxTokens ??
      DEFAULTS.maxTokens,
    maxTurns:
      flags.maxTurns ?? envInteger(env.ARNCODE_MAX_TURNS) ?? config.maxTurns ?? DEFAULTS.maxTurns,
    webTools: flags.webTools ?? config.webTools ?? DEFAULTS.webTools,
    compactAt:
      flags.compactAt ??
      envInteger(env.ARNCODE_COMPACT_AT) ??
      config.compactAt ??
      DEFAULTS.compactAt,
    permissionMode: flags.permissionMode ?? config.permissionMode ?? DEFAULTS.permissionMode,
  });
  return {
    ...DEFAULTS,
    ...settings,
    ...(config.hooks ? { hooks: config.hooks } : {}),
    ...(config.mcpServers ? { mcpServers: config.mcpServers } : {}),
    protectedPaths: [...new Set([...DEFAULT_PROTECTED_PATHS, ...configuredPaths, ...flagPaths])],
    cwd: resolve(flags.cwd ?? process.cwd()),
    ...(explicitAuth ? { authRestriction: authSchema.parse(explicitAuth) } : {}),
    ...(pinnedCredential ? { pinnedCredential: profileSchema.parse(pinnedCredential) } : {}),
  };
}

export async function resolveConfiguration(
  flags: Partial<Settings>,
  env: NodeJS.ProcessEnv = process.env,
  dir = getConfigDir(),
): Promise<Settings> {
  const settings = resolveSettings(flags, env, await readConfig(dir));
  const first = (await loadCredentialCandidates(settings, env, dir))[0];
  if (first) settings.auth = first.type;
  return settings;
}
