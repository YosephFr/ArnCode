import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addProfile,
  detectCredentialType,
  listCredentials,
  loadCredentialCandidates,
  renameProfile,
  useProfile,
} from '../src/auth.js';
import { credentialLines } from '../src/commands/credentials.js';
import { readConfig } from '../src/config.js';
import { MeterStore, credentialState } from '../src/metering.js';

// Built at runtime so no token-shaped literal appears in the source.
const prefix = ['sk', 'ant'].join('-');
const apiKey = `${prefix}-api03-${'a'.repeat(24)}`;
const oauthToken = `${prefix}-oat01-${'b'.repeat(24)}`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'arncode-creds-'));
  vi.stubEnv('ARNCODE_CONFIG_DIR', dir);
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('credential bank', () => {
  it('tells API keys from setup tokens', () => {
    expect(detectCredentialType(apiKey)).toBe('api-key');
    expect(detectCredentialType(` ${oauthToken}\n`)).toBe('oauth');
    expect(detectCredentialType('something-else-entirely')).toBeUndefined();
  });

  it('renames a credential with its preference and usage history', async () => {
    await addProfile('work', 'api-key', apiKey, dir, { priority: 1 });
    await addProfile('home', 'oauth', oauthToken, dir);
    await useProfile('home', dir);
    const meter = new MeterStore(dir);
    const [home] = await loadCredentialCandidates({ pinnedCredential: 'home' }, {}, dir);
    await meter.request(home!);
    await renameProfile('home', 'personal', dir);
    await meter.rename('home', 'personal');
    expect((await listCredentials(dir)).map((item) => item.name)).toEqual(['personal', 'work']);
    expect((await readConfig(dir)).profile).toBe('personal');
    const usage = await meter.read();
    expect(usage.credentials.personal?.requests).toBe(1);
    expect(usage.credentials.home).toBeUndefined();
    await expect(renameProfile('personal', 'work', dir)).rejects.toThrow('already exists');
  });

  it('remembers plan limits per credential and lists them with readable reset times', async () => {
    await addProfile('claude', 'oauth', oauthToken, dir);
    const [credential] = await loadCredentialCandidates({ pinnedCredential: 'claude' }, {}, dir);
    const meter = new MeterStore(dir);
    await meter.plan(credential!, {
      fiveHour: { used: 0.34, resetsAt: Math.floor(Date.now() / 1000) + 7200 },
    });
    await meter.plan(credential!, { weekly: { used: 0.61 } });
    const state = credentialState(await meter.read(), credential!);
    expect(state?.plan).toMatchObject({ fiveHour: { used: 0.34 }, weekly: { used: 0.61 } });
    await meter.failure(
      credential!,
      Object.assign(new Error('rate limited'), {
        status: 429,
        headers: new Headers({ 'retry-after': '5400' }),
      }),
    );
    const [line] = await credentialLines();
    expect(line?.line).toContain('5h 34% · wk 61%');
    expect(line?.line).toMatch(/limited, back in 1h 29m|limited, back in 1h 30m/);
  });
});
