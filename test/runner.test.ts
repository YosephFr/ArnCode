import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Credential } from '../src/auth.js';
import { DEFAULTS } from '../src/config.js';
import type { EngineContext } from '../src/engines/types.js';
import { MeterStore } from '../src/metering.js';
import { runTask } from '../src/runner.js';
import { appendTranscript, loadSession, newSession, saveSession } from '../src/session.js';
import type { AgentUI, AuthMode, Settings } from '../src/types.js';
import { addUsage, usageFromAPI } from '../src/usage.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function credential(name: string, type: AuthMode = 'api-key'): Credential {
  return {
    name,
    type,
    secret: `fixture-credential-${name}`,
    source: 'stored',
    priority: 0,
    enabled: true,
    createdAt: '2026-10-26T00:00:00.000Z',
  };
}

function ui(): AgentUI {
  return {
    text: vi.fn(),
    endText: vi.fn(),
    status: vi.fn(),
    idle: vi.fn(),
    notice: vi.fn(),
    tool: vi.fn(),
    diff: vi.fn(),
  };
}

async function setup(overrides: Partial<Settings> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'arncode-runner-'));
  directories.push(dir);
  const settings = { ...DEFAULTS, cwd: dir, ...overrides };
  const home = join(dir, 'state');
  const session = newSession(settings);
  const options: Parameters<typeof runTask>[0] = {
    settings,
    session,
    prompt: 'Create hello.txt containing hi.',
    ui: ui(),
    approve: async () => ({ allowed: true }),
    signal: new AbortController().signal,
    meter: new MeterStore(home),
    save: (value) => saveSession(value, home),
    engines: {
      'api-key': async () => {
        throw new Error('Unexpected API engine call');
      },
      oauth: async () => {
        throw new Error('Unexpected OAuth engine call');
      },
    },
  };
  return { options, home, meter: new MeterStore(home) };
}

function limited(status: number, message = 'Rate limit reached') {
  return Object.assign(new Error(message), {
    status,
    headers: new Headers({ 'retry-after': '60' }),
  });
}

function completedWrite(ctx: EngineContext) {
  ctx.session.messages.push(
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'original-tool-call',
          name: 'write_file',
          input: { path: 'hello.txt', content: 'hi' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'original-tool-call', content: 'Wrote hello.txt' },
      ],
    },
  );
  appendTranscript(
    ctx.session,
    'tool',
    'write_file {"path":"hello.txt","content":"hi"}\nWrote hello.txt',
  );
}

describe('credential rotation', () => {
  it('continues the exact API history after 429 and persists usage for both credentials', async () => {
    const { options, meter, home } = await setup();
    options.candidates = [credential('first'), credential('second')];
    const history = options.session.messages;
    const firstUsage = usageFromAPI('claude-haiku-5-5', {
      input_tokens: 20,
      output_tokens: 8,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 5,
    });
    const secondUsage = usageFromAPI('claude-haiku-5-5', { input_tokens: 10, output_tokens: 4 });
    const engine = vi.fn(async (ctx: EngineContext) => {
      await ctx.onRequest();
      if (ctx.credential.name === 'first') {
        completedWrite(ctx);
        await ctx.onUsage(firstUsage);
        await ctx.onRequest();
        throw limited(429);
      }
      expect(ctx.session.messages).toBe(history);
      expect(ctx.session.messages).toHaveLength(3);
      expect(ctx.session.messages.at(-1)).toEqual({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'original-tool-call', content: 'Wrote hello.txt' },
        ],
      });
      await ctx.onUsage(secondUsage);
      appendTranscript(ctx.session, 'assistant', 'Created hello.txt.');
    });
    options.engines = { 'api-key': engine, oauth: async () => undefined };

    expect(await runTask(options)).toEqual(addUsage(firstUsage, secondUsage));
    expect(engine.mock.calls.map(([ctx]) => ctx.credential.name)).toEqual(['first', 'second']);
    const bank = await meter.read();
    expect(bank.credentials.first).toMatchObject({
      requests: 2,
      errors: 1,
      limitHits: 1,
      status: 'exhausted',
      inputTokens: 20,
      outputTokens: 8,
      cacheReadTokens: 3,
      cacheWriteTokens: 5,
    });
    expect(bank.credentials.second).toMatchObject({ requests: 1, errors: 0, status: 'ready' });
    const saved = await loadSession(options.session.id, home);
    expect(saved.usage).toEqual(addUsage(firstUsage, secondUsage));
    expect(saved.transcript.at(-1)?.text).toBe('Created hello.txt.');
  });

  it.each([
    [401, 'Invalid credential'],
    [400, 'Your credit balance is too low to access the API'],
    [402, 'Payment required'],
  ])('rotates after a credential failure (%s)', async (status, message) => {
    const { options, meter } = await setup();
    options.candidates = [credential('first'), credential('backup')];
    const calls: string[] = [];
    options.engines = {
      'api-key': async (ctx) => {
        calls.push(ctx.credential.name);
        await ctx.onRequest();
        if (ctx.credential.name === 'first') throw limited(status, message);
      },
      oauth: async () => undefined,
    };
    await runTask(options);
    expect(calls).toEqual(['first', 'backup']);
    expect((await meter.read()).credentials.first).toMatchObject({ errors: 1, limitHits: 1 });
  });

  it('stops after trying each exhausted credential once and preserves the task', async () => {
    const { options, home } = await setup();
    options.candidates = [credential('first'), credential('backup')];
    const engine = vi.fn(async (ctx: EngineContext) => {
      await ctx.onRequest();
      throw limited(429);
    });
    options.engines = { 'api-key': engine, oauth: async () => undefined };
    await expect(runTask(options)).rejects.toThrow('No healthy credentials remain');
    expect(engine).toHaveBeenCalledTimes(2);
    expect((await loadSession(options.session.id, home)).transcript).toEqual([
      { role: 'user', text: options.prompt },
    ]);
  });

  it('executes only the pinned credential even when supplied candidates contain others first', async () => {
    const { options } = await setup({ pinnedCredential: 'pinned' });
    options.candidates = [credential('other'), credential('pinned')];
    const engine = vi.fn(async (ctx: EngineContext) => {
      expect(ctx.canFailover).toBe(false);
      throw limited(429);
    });
    options.engines = { 'api-key': engine, oauth: async () => undefined };
    await expect(runTask(options)).rejects.toThrow('pinned credential is unavailable');
    expect(engine.mock.calls.map(([ctx]) => ctx.credential.name)).toEqual(['pinned']);
  });

  it('automatically reuses a credential once its reset time passes', async () => {
    const { options, meter } = await setup();
    const first = credential('first');
    const now = Date.now();
    await meter.failure(first, {
      status: 429,
      headers: { 'anthropic-ratelimit-requests-reset': new Date(now + 1000).toISOString() },
    });
    options.candidates = [first, credential('backup')];
    const calls: string[] = [];
    options.engines = {
      'api-key': async (ctx) => {
        calls.push(ctx.credential.name);
        await ctx.onRequest();
      },
      oauth: async () => undefined,
    };
    await runTask(options);
    vi.spyOn(Date, 'now').mockReturnValue(now + 2000);
    await runTask({ ...options, session: newSession(options.settings) });
    expect(calls).toEqual(['backup', 'first']);
    expect((await meter.read()).credentials.first).toMatchObject({ status: 'ready', requests: 1 });
    expect((await meter.read()).credentials.first?.resetAt).toBeUndefined();
  });

  it('carries the original task and completed actions from API to OAuth', async () => {
    const { options } = await setup();
    options.candidates = [credential('api'), credential('account', 'oauth')];
    let carried = '';
    options.engines = {
      'api-key': async (ctx) => {
        completedWrite(ctx);
        throw limited(429);
      },
      oauth: async (ctx, prompt) => {
        carried = prompt ?? '';
        expect(ctx.session.engine).toBe('oauth');
      },
    };
    await runTask(options);
    expect(carried).toContain(options.prompt);
    expect(carried).toContain('Wrote hello.txt');
    expect(carried).toContain('Completed tool actions have already happened');
    expect(carried).not.toContain('original-tool-call');
  });

  it('carries OAuth work into API text context without foreign tool IDs', async () => {
    const { options } = await setup({ auth: 'oauth' });
    options.candidates = [credential('account', 'oauth'), credential('api')];
    options.engines = {
      oauth: async (ctx) => {
        completedWrite(ctx);
        throw limited(401, 'Invalid OAuth credential');
      },
      'api-key': async (ctx) => {
        expect(ctx.session.engine).toBe('api-key');
        expect(ctx.session.messages).toHaveLength(1);
        const content = ctx.session.messages[0]?.content;
        expect(typeof content).toBe('string');
        expect(content).toContain(options.prompt);
        expect(content).toContain('Wrote hello.txt');
        expect(content).not.toContain('original-tool-call');
      },
    };
    await runTask(options);
  });
});

describe('persistent credential metering', () => {
  it('keeps concurrent request, usage and failure updates from independent stores', async () => {
    const { home, meter } = await setup();
    const other = new MeterStore(home);
    const account = credential('account');
    const usage = usageFromAPI('claude-haiku-5-5', {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 3,
    });
    await Promise.all(
      Array.from({ length: 12 }, () =>
        Promise.all([
          meter.request(account),
          other.usage(account, usage),
          other.failure(account, limited(429)),
        ]),
      ),
    );
    const recorded = (await new MeterStore(home).read()).credentials.account;
    expect(recorded).toMatchObject({
      requests: 12,
      errors: 12,
      limitHits: 12,
      inputTokens: 120,
      outputTokens: 60,
      cacheReadTokens: 24,
      cacheWriteTokens: 36,
      status: 'exhausted',
    });
    expect(recorded?.costUsd).toBeCloseTo(usage.costUsd * 12);
    expect(recorded?.lastUsed).toBeTruthy();
    expect(await readFile(meter.file, 'utf8')).not.toContain(account.secret);
    expect((await stat(meter.file)).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
  });

  it('supports credential names that coincide with object prototype properties', async () => {
    const { meter } = await setup();
    const named = credential('constructor');
    await meter.request(named);
    await meter.usage(
      named,
      usageFromAPI('claude-haiku-5-5', { input_tokens: 10, output_tokens: 1 }),
    );
    expect((await meter.read()).credentials.constructor).toMatchObject({
      requests: 1,
      inputTokens: 10,
      outputTokens: 1,
      status: 'ready',
    });
  });
});
