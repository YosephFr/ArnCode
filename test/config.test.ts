import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addProfile } from '../src/auth.js';
import {
  DEFAULT_PROTECTED_PATHS,
  getConfigDir,
  readConfig,
  resolveConfiguration,
  resolveSettings,
  writeConfig,
} from '../src/config.js';

const directories: string[] = [];
async function temporary(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arncode-config-'));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('configuration', () => {
  it('merges protected paths without removing defaults or repeating entries', async () => {
    const dir = await temporary();
    await writeConfig({ protectedPaths: ['private', '~/.ssh', 'private'] }, dir);
    const settings = resolveSettings(
      { protectedPaths: ['extra', 'private'] },
      {},
      await readConfig(dir),
    );
    expect(settings.protectedPaths).toEqual([...DEFAULT_PROTECTED_PATHS, 'private', 'extra']);
    expect(
      resolveSettings({ protectedPaths: [] }, {}, { protectedPaths: [] }).protectedPaths,
    ).toEqual(DEFAULT_PROTECTED_PATHS);
    await expect(writeConfig({ protectedPaths: [''] }, dir)).rejects.toThrow('protectedPaths');
    expect(await readConfig(dir)).toEqual({ protectedPaths: ['private', '~/.ssh', 'private'] });
    const custom = Array.from({ length: 256 }, (_, index) => `private-${index}`);
    await writeConfig({ protectedPaths: custom }, dir);
    expect(resolveSettings({}, {}, await readConfig(dir)).protectedPaths).toEqual([
      ...DEFAULT_PROTECTED_PATHS,
      ...custom,
    ]);
  });

  it('resolves an optional isolated configuration directory', () => {
    vi.stubEnv('ARNCODE_CONFIG_DIR', '../arncode-state');
    expect(getConfigDir()).toBe(resolve('../arncode-state'));
  });

  it('uses CLI, environment, config, and defaults in that order', () => {
    const settings = resolveSettings(
      { model: 'from-cli', fast: false, maxTokens: 200 },
      {
        ARNCODE_MODEL: 'from-env',
        ARNCODE_AUTH: 'oauth',
        ARNCODE_FAST: 'true',
        ARNCODE_EFFORT: 'high',
      },
      { model: 'from-config', auth: 'api-key', maxTokens: 99, maxTurns: 12 },
    );
    expect(settings).toMatchObject({
      model: 'from-cli',
      auth: 'oauth',
      authRestriction: 'oauth',
      fast: false,
      effort: 'high',
      maxTokens: 200,
      maxTurns: 12,
      permissionMode: 'full',
    });
    expect(resolveSettings({}, {})).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'medium',
      maxTokens: 64000,
    });
  });

  it('rejects bad settings without echoing supplied values', () => {
    expect(() => resolveSettings({}, { ARNCODE_AUTH: 'bad-sensitive-value' })).toThrow(
      'check auth',
    );
    expect(() => resolveSettings({}, { ARNCODE_MAX_TURNS: 'NaN' })).toThrow('maxTurns');
    expect(() => resolveSettings({}, { ARNCODE_FAST: 'perhaps' })).toThrow('must be true');
    expect(() => resolveSettings({ baseUrl: 'https://user:password@example.com' }, {})).toThrow(
      'baseUrl',
    );
  });

  it('runs with full access by default and supports explicit ask mode', async () => {
    expect(resolveSettings({}, {}).permissionMode).toBe('full');
    expect(resolveSettings({ permissionMode: 'ask' }, {}).permissionMode).toBe('ask');
    const dir = await temporary();
    await writeConfig({ permissionMode: 'ask' }, dir);
    expect((await resolveConfiguration({}, {}, dir)).permissionMode).toBe('ask');
    expect((await resolveConfiguration({ permissionMode: 'full' }, {}, dir)).permissionMode).toBe(
      'full',
    );
  });

  it('persists only recognized settings and supports deleting a preference', async () => {
    const dir = await temporary();
    expect(await readConfig(dir)).toEqual({});
    await writeConfig({ profile: 'work', model: 'model-a' }, dir);
    await writeConfig({ profile: undefined, fast: true }, dir);
    expect(await readConfig(dir)).toEqual({ model: 'model-a', fast: true });
    expect(await readFile(join(dir, 'config.json'), 'utf8')).not.toContain('profile');
  });

  it('distinguishes preferred credentials from a pin and auth type restriction', async () => {
    const dir = await temporary();
    await addProfile('account', 'oauth', 'oauth-test-config-value', dir);
    await writeConfig({ profile: 'account' }, dir);
    const preferred = await resolveConfiguration({}, {}, dir);
    expect(preferred).toMatchObject({ auth: 'oauth', profile: 'account' });
    expect(preferred.pinnedCredential).toBeUndefined();
    expect(preferred.authRestriction).toBeUndefined();
    expect(await resolveConfiguration({ profile: 'account' }, {}, dir)).toMatchObject({
      pinnedCredential: 'account',
      auth: 'oauth',
    });
    await expect(
      resolveConfiguration({ profile: 'account', auth: 'api-key' }, {}, dir),
    ).rejects.toThrow('uses oauth');
  });

  it('honors a configured auth restriction and lets CLI and environment override it', async () => {
    const dir = await temporary();
    await addProfile('account', 'oauth', 'oauth-auth-restriction-test-value', dir);
    await addProfile('api', 'api-key', 'api-auth-restriction-test-value', dir);
    await writeConfig({ auth: 'api-key' }, dir);
    expect(await resolveConfiguration({}, {}, dir)).toMatchObject({
      auth: 'api-key',
      authRestriction: 'api-key',
    });
    expect(await resolveConfiguration({}, { ARNCODE_AUTH: 'oauth' }, dir)).toMatchObject({
      auth: 'oauth',
      authRestriction: 'oauth',
    });
    expect(
      await resolveConfiguration({ auth: 'api-key' }, { ARNCODE_AUTH: 'oauth' }, dir),
    ).toMatchObject({ auth: 'api-key', authRestriction: 'api-key' });
  });
});
