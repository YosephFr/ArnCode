import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { getConfigDir, readConfig, writeConfig } from './config.js';
import { registerEnvironmentSecrets, registerSecret } from './redact.js';
import { atomicWriteJson, isFileError, readJson, withFileLock } from './storage.js';
import type { AuthMode, Settings } from './types.js';

const credentialSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    type: z.enum(['api-key', 'oauth']),
    secret: z
      .string()
      .min(8)
      .max(16384)
      .regex(/^[!-~]+$/),
    priority: z.number().int().min(-1000000).max(1000000),
    enabled: z.boolean(),
    createdAt: z.string().datetime(),
  })
  .strict();
const bankSchema = z
  .object({ version: z.literal(1), credentials: z.array(credentialSchema) })
  .strict();
type StoredCredential = z.infer<typeof credentialSchema>;
type Bank = z.infer<typeof bankSchema>;

export interface Credential extends StoredCredential {
  source: 'stored' | 'environment';
}

export type CredentialSummary = Omit<StoredCredential, 'secret'> & { masked: string };

async function readBank(dir: string): Promise<Bank> {
  await assertOutsideRepository(dir);
  const path = join(dir, 'credentials.json');
  const value = await readJson(path);
  if (value === undefined) return { version: 1, credentials: [] };
  const parsed = bankSchema.safeParse(value);
  if (!parsed.success)
    throw new Error('Invalid credentials.json. Check the credential bank format.');
  const names = parsed.data.credentials.map((credential) => credential.name);
  if (new Set(names).size !== names.length)
    throw new Error('credentials.json contains duplicate names.');
  for (const credential of parsed.data.credentials) registerSecret(credential.secret);
  return parsed.data;
}

async function assertOutsideRepository(dir: string): Promise<void> {
  let current = await realpath(dir).catch((error: unknown) => {
    if (!isFileError(error, 'ENOENT')) throw error;
    return resolve(dir);
  });
  while (true) {
    try {
      await lstat(join(current, '.git'));
      throw new Error(
        'Credentials must be stored outside a Git repository. Use a home directory outside the repository.',
      );
    } catch (error) {
      if (!isFileError(error, 'ENOENT')) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function validateName(name: string): void {
  if (!credentialSchema.shape.name.safeParse(name).success) {
    throw new Error(
      'Use a credential name of 1–64 letters, numbers, periods, hyphens, or underscores.',
    );
  }
}

export async function addProfile(
  name: string,
  type: AuthMode,
  secret: string,
  dir = getConfigDir(),
  options: { priority?: number; enabled?: boolean } = {},
): Promise<void> {
  validateName(name);
  registerSecret(secret.trim());
  const parsed = credentialSchema.safeParse({
    name,
    type,
    secret: secret.trim(),
    priority: options.priority ?? 0,
    enabled: options.enabled ?? true,
    createdAt: new Date().toISOString(),
  });
  if (!parsed.success)
    throw new Error(
      'Invalid credential. Use a single-line token of at least 8 characters and an integer priority.',
    );
  const path = join(dir, 'credentials.json');
  await withFileLock(path, async () => {
    const bank = await readBank(dir);
    if (bank.credentials.some((credential) => credential.name === name)) {
      throw new Error(
        `Credential '${name}' already exists. Remove it before adding a replacement.`,
      );
    }
    bank.credentials.push(parsed.data);
    await atomicWriteJson(path, bank);
  });
}

export async function listCredentials(dir = getConfigDir()): Promise<CredentialSummary[]> {
  return (await readBank(dir)).credentials
    .map(({ secret, ...metadata }) => ({ ...metadata, masked: `••••${secret.slice(-4)}` }))
    .sort((a, b) => a.priority - b.priority);
}

export async function listProfiles(
  dir = getConfigDir(),
): Promise<{ name: string; type: AuthMode }[]> {
  return (await listCredentials(dir)).map(({ name, type }) => ({ name, type }));
}

export async function useProfile(name: string, dir = getConfigDir()): Promise<void> {
  const credential = (await readBank(dir)).credentials.find((item) => item.name === name);
  if (!credential) throw new Error(`Credential '${name}' was not found. Run arncode creds list.`);
  if (!credential.enabled)
    throw new Error(`Credential '${name}' is disabled. Run arncode creds enable ${name}.`);
  await writeConfig({ profile: name, auth: undefined }, dir);
}

export async function removeProfile(name: string, dir = getConfigDir()): Promise<void> {
  const path = join(dir, 'credentials.json');
  await withFileLock(path, async () => {
    const bank = await readBank(dir);
    const index = bank.credentials.findIndex((credential) => credential.name === name);
    if (index < 0) throw new Error(`Credential '${name}' was not found. Run arncode creds list.`);
    bank.credentials.splice(index, 1);
    await atomicWriteJson(path, bank);
    if ((await readConfig(dir)).profile === name) await writeConfig({ profile: undefined }, dir);
  });
}

async function updateCredential(
  name: string,
  patch: Partial<Pick<StoredCredential, 'priority' | 'enabled'>>,
  dir: string,
): Promise<void> {
  const path = join(dir, 'credentials.json');
  await withFileLock(path, async () => {
    const bank = await readBank(dir);
    const index = bank.credentials.findIndex((credential) => credential.name === name);
    if (index < 0) throw new Error(`Credential '${name}' was not found. Run arncode creds list.`);
    const parsed = credentialSchema.safeParse({ ...bank.credentials[index], ...patch });
    if (!parsed.success) throw new Error('Invalid credential priority or enabled flag.');
    bank.credentials[index] = parsed.data;
    await atomicWriteJson(path, bank);
  });
}

export async function enableCredential(
  name: string,
  enabled: boolean,
  dir = getConfigDir(),
): Promise<void> {
  await updateCredential(name, { enabled }, dir);
}

export async function setCredentialPriority(
  name: string,
  priority: number,
  dir = getConfigDir(),
): Promise<void> {
  await updateCredential(name, { priority }, dir);
}

export async function loadCredentialCandidates(
  settings: Pick<Settings, 'authRestriction' | 'pinnedCredential' | 'profile'>,
  env: NodeJS.ProcessEnv = process.env,
  dir = getConfigDir(),
): Promise<Credential[]> {
  registerEnvironmentSecrets(env);
  const bank = await readBank(dir);
  const credentials: Credential[] = bank.credentials.map((credential) => ({
    ...credential,
    source: 'stored',
  }));
  credentials.sort((a, b) => a.priority - b.priority);
  if (settings.profile && !settings.pinnedCredential) {
    credentials.sort(
      (a, b) => Number(b.name === settings.profile) - Number(a.name === settings.profile),
    );
  }
  const environmentCredentials: [string, AuthMode, string | undefined][] = [
    ['env:api-key', 'api-key', env.ANTHROPIC_API_KEY],
    ['env:oauth', 'oauth', env.CLAUDE_CODE_OAUTH_TOKEN],
  ];
  for (const [name, type, value] of environmentCredentials) {
    const secret = value?.trim();
    if (!secret) continue;
    if (
      credentials.some((credential) => credential.secret === secret) &&
      settings.pinnedCredential !== name
    )
      continue;
    registerSecret(secret);
    credentials.push({
      name,
      type,
      secret,
      priority: 1000001,
      enabled: true,
      source: 'environment',
      createdAt: new Date(0).toISOString(),
    });
  }
  if (settings.pinnedCredential) {
    const pinned = credentials.find((credential) => credential.name === settings.pinnedCredential);
    if (!pinned)
      throw new Error(
        `Credential '${settings.pinnedCredential}' was not found. Run arncode creds list.`,
      );
    if (!pinned.enabled)
      throw new Error(
        `Credential '${pinned.name}' is disabled. Run arncode creds enable ${pinned.name}.`,
      );
    if (settings.authRestriction && pinned.type !== settings.authRestriction) {
      throw new Error(
        `Credential '${pinned.name}' uses ${pinned.type}. Change --auth or choose another credential.`,
      );
    }
    return [pinned];
  }
  return credentials.filter(
    (credential) =>
      credential.enabled &&
      (!settings.authRestriction || credential.type === settings.authRestriction),
  );
}

export async function resolveAuth(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
  dir = getConfigDir(),
): Promise<Credential> {
  const first = (await loadCredentialCandidates(settings, env, dir))[0];
  if (!first)
    throw new Error(
      'No enabled credentials are available. Run arncode creds add <name>, or set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.',
    );
  return first;
}

export function buildOAuthEnv(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  registerSecret(token);
  registerEnvironmentSecrets(env);
  const clean = { ...env };
  for (const name of Object.keys(clean)) {
    if (
      name.startsWith('ANTHROPIC_') ||
      name.startsWith('CLAUDE_CODE_USE_') ||
      [
        'CLAUDE_CODE_OAUTH_TOKEN',
        'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
        'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
        'CLAUDE_CODE_API_KEY_HELPER',
      ].includes(name)
    ) {
      delete clean[name];
    }
  }
  clean.CLAUDE_CODE_OAUTH_TOKEN = token;
  return clean;
}
