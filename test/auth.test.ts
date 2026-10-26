import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addProfile,
  buildOAuthEnv,
  enableCredential,
  listCredentials,
  listProfiles,
  loadCredentialCandidates,
  removeProfile,
  setCredentialPriority,
  useProfile,
} from '../src/auth.js';
import { readConfig, writeConfig } from '../src/config.js';

const directories: string[] = [];
async function temporary(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arncode-auth-'));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('credential bank', () => {
  it('keeps OAuth isolated from API key and provider environment variables', () => {
    const env = {
      ANTHROPIC_API_KEY: 'api-test-source-value',
      ANTHROPIC_AUTH_TOKEN: 'other-test-value',
      ANTHROPIC_BASE_URL: 'https://gateway.invalid',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'old-oauth-test-value',
      CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '4',
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      LANG: 'en_US.UTF-8',
    };
    const clean = buildOAuthEnv('selected-oauth-test-value', env);
    expect(clean).toEqual({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      LANG: 'en_US.UTF-8',
      CLAUDE_CODE_OAUTH_TOKEN: 'selected-oauth-test-value',
    });
    expect(env.ANTHROPIC_API_KEY).toBe('api-test-source-value');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('old-oauth-test-value');
  });

  it('stores mixed credentials privately and only exposes masked metadata', async () => {
    const dir = await temporary();
    await addProfile('work', 'oauth', 'test-oauth-secret-7890', dir);
    await addProfile('backup', 'api-key', 'test-api-secret-1234', dir, { priority: 4 });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'credentials.json'))).mode & 0o777).toBe(0o600);
    const summaries = await listCredentials(dir);
    expect(summaries.map(({ name, type, masked }) => ({ name, type, masked }))).toEqual([
      { name: 'work', type: 'oauth', masked: '••••7890' },
      { name: 'backup', type: 'api-key', masked: '••••1234' },
    ]);
    expect(JSON.stringify(summaries)).not.toContain('test-oauth-secret');
    expect(await listProfiles(dir)).toEqual([
      { name: 'work', type: 'oauth' },
      { name: 'backup', type: 'api-key' },
    ]);
  });

  it('orders healthy candidates by preference, priority, insertion, then environment', async () => {
    const dir = await temporary();
    await addProfile('first', 'api-key', 'first-credential-value', dir);
    await addProfile('preferred', 'oauth', 'preferred-credential-value', dir, { priority: 10 });
    await addProfile('top', 'api-key', 'top-credential-value', dir, { priority: -1 });
    await addProfile('disabled', 'oauth', 'disabled-credential-value', dir, {
      enabled: false,
      priority: -2,
    });
    const env = {
      ANTHROPIC_API_KEY: 'environment-credential-value',
      CLAUDE_CODE_OAUTH_TOKEN: 'preferred-credential-value',
    };
    expect(
      (await loadCredentialCandidates({}, env, dir)).map((credential) => credential.name),
    ).toEqual(['top', 'first', 'preferred', 'env:api-key']);
    expect(
      (await loadCredentialCandidates({ profile: 'preferred' }, env, dir)).map(
        (credential) => credential.name,
      ),
    ).toEqual(['preferred', 'top', 'first', 'env:api-key']);
    expect(
      (await loadCredentialCandidates({ authRestriction: 'oauth' }, env, dir)).map(
        (credential) => credential.name,
      ),
    ).toEqual(['preferred']);
    expect(
      (await loadCredentialCandidates({ pinnedCredential: 'first' }, env, dir)).map(
        (credential) => credential.name,
      ),
    ).toEqual(['first']);
    await expect(
      loadCredentialCandidates({ pinnedCredential: 'disabled' }, {}, dir),
    ).rejects.toThrow('disabled');
    await expect(
      loadCredentialCandidates({ pinnedCredential: 'missing' }, {}, dir),
    ).rejects.toThrow('not found');
  });

  it('supports enable, disable, priority, preferred selection, and removal', async () => {
    const dir = await temporary();
    await addProfile('work', 'oauth', 'work-test-credential', dir);
    await addProfile('other', 'api-key', 'other-test-credential', dir);
    await setCredentialPriority('other', -10, dir);
    await enableCredential('work', false, dir);
    await expect(useProfile('work', dir)).rejects.toThrow('disabled');
    await enableCredential('work', true, dir);
    await writeConfig({ auth: 'api-key' }, dir);
    await useProfile('work', dir);
    expect(await readConfig(dir)).toEqual({ profile: 'work' });
    await removeProfile('work', dir);
    expect(await readConfig(dir)).toEqual({});
    expect((await listCredentials(dir)).map(({ name, priority }) => ({ name, priority }))).toEqual([
      { name: 'other', priority: -10 },
    ]);
  });

  it('serializes concurrent updates and never replaces a duplicate name', async () => {
    const dir = await temporary();
    await Promise.all([
      addProfile('one', 'api-key', 'one-test-credential', dir),
      addProfile('two', 'oauth', 'two-test-credential', dir),
      addProfile('three', 'api-key', 'three-test-credential', dir),
    ]);
    expect((await listCredentials(dir)).map(({ name }) => name).sort()).toEqual([
      'one',
      'three',
      'two',
    ]);
    await expect(addProfile('one', 'oauth', 'replacement-test-credential', dir)).rejects.toThrow(
      'already exists',
    );
    expect(await readFile(join(dir, 'credentials.json'), 'utf8')).not.toContain(
      'replacement-test-credential',
    );
  });

  it('rejects corrupt credential data without quoting it', async () => {
    const dir = await temporary();
    await writeFile(join(dir, 'credentials.json'), '{"secret":"private-invalid-data"}');
    await expect(listCredentials(dir)).rejects.toThrow('Invalid credentials.json');
    await expect(addProfile('../escape', 'oauth', 'valid-test-credential', dir)).rejects.toThrow(
      'credential name',
    );
  });

  it('refuses to store credentials inside a repository', async () => {
    const dir = await temporary();
    await mkdir(join(dir, '.git'));
    await expect(
      addProfile('private', 'oauth', 'repo-test-credential', join(dir, '.arncode')),
    ).rejects.toThrow('outside a Git repository');
    await expect(readFile(join(dir, '.arncode', 'credentials.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
