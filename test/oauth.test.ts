import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ModelUsage,
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultError,
  SDKResultSuccess,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULTS } from '../src/config.js';
import { oauthOptions, runOAuth, sdkUsage, usageDifference } from '../src/engines/oauth.js';
import type { EngineContext } from '../src/engines/types.js';
import { classifyCredentialFailure } from '../src/failures.js';
import { MeterStore } from '../src/metering.js';
import { PermissionManager } from '../src/permissions.js';
import { runTask } from '../src/runner.js';
import { appendTranscript, newSession } from '../src/session.js';
import type { Settings } from '../src/types.js';
import { emptyUsage } from '../src/usage.js';

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: sdk.query,
}));

const directories: string[] = [];
const uuid = '11111111-1111-4111-8111-111111111111';
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  sdk.query.mockReset();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function context(overrides: Partial<Settings> = {}): Promise<EngineContext> {
  const dir = await mkdtemp(join(tmpdir(), 'arncode-oauth-'));
  directories.push(dir);
  const settings: Settings = { ...DEFAULTS, cwd: dir, auth: 'oauth', ...overrides };
  return {
    settings,
    session: newSession(settings),
    credential: {
      name: 'account',
      type: 'oauth',
      secret: 'selected-oauth-fixture-token',
      enabled: true,
      priority: 0,
      createdAt: '2026-10-26T00:00:00.000Z',
      source: 'stored',
    },
    ui: {
      text: vi.fn(),
      endText: vi.fn(),
      status: vi.fn(),
      idle: vi.fn(),
      notice: vi.fn(),
      tool: vi.fn(),
      diff: vi.fn(),
    },
    approve: vi.fn(async () => ({ allowed: true })),
    signal: new AbortController().signal,
    budget: { remaining: settings.maxTurns },
    canFailover: true,
    checkpoint: vi.fn(async () => undefined),
    onRequest: vi.fn(async () => undefined),
    onUsage: vi.fn(async () => undefined),
  };
}

function modelUsage(overrides: Partial<ModelUsage> = {}): ModelUsage {
  return {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadInputTokens: 40,
    cacheCreationInputTokens: 10,
    webSearchRequests: 0,
    costUSD: 0.01,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    costBasis: 'list',
    ...overrides,
  };
}

function result(overrides: Partial<SDKResultSuccess> = {}): SDKResultSuccess {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: 'Done.',
    stop_reason: 'end_turn',
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 10,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 10 },
      fallback_credit: null,
      inference_geo: 'not_available',
      iterations: [],
      output_tokens_details: { thinking_tokens: 0 },
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
      service_tier: 'standard',
      speed: 'standard',
    },
    modelUsage: { 'claude-haiku-5-5': modelUsage() },
    permission_denials: [],
    uuid,
    session_id: 'sdk-thread',
    ...overrides,
  };
}

function stream(messages: SDKMessage[]) {
  const iterator = (async function* () {
    yield* messages;
  })();
  return Object.assign(iterator, { close: vi.fn() });
}

describe('OAuth configuration and permissions', () => {
  it('passes only the selected OAuth credential without mutating the parent environment', async () => {
    const conflicting = {
      ANTHROPIC_API_KEY: 'other-api-fixture-token',
      ANTHROPIC_AUTH_TOKEN: 'other-auth-fixture-token',
      ANTHROPIC_BASE_URL: 'https://example.com/provider',
      ANTHROPIC_CUSTOM_HEADERS: 'x-api-key: other-header-fixture-token',
      CLAUDE_CODE_OAUTH_TOKEN: 'other-oauth-fixture-token',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_API_KEY_HELPER: '/example/helper',
      CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '8',
      CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '9',
    };
    for (const [name, value] of Object.entries(conflicting)) vi.stubEnv(name, value);
    const ctx = await context();
    const options = await oauthOptions(ctx, new AbortController());
    for (const name of Object.keys(conflicting)) {
      if (name === 'CLAUDE_CODE_OAUTH_TOKEN') continue;
      expect(options.env).not.toHaveProperty(name);
      expect(process.env[name]).toBe(conflicting[name as keyof typeof conflicting]);
    }
    expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(ctx.credential.secret);
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('other-oauth-fixture-token');
    expect(options.settingSources).toEqual([]);
    expect(options.includePartialMessages).toBe(true);
    expect(options.persistSession).toBe(false);
    expect(options.debug).toBe(false);
    expect(options.resume).toBeUndefined();
    expect(options.cwd).toBe(ctx.settings.cwd);
    expect(options.maxTurns).toBe(ctx.budget.remaining);
  });

  it('gates even read-only Bash through PreToolUse and denies without a TTY', async () => {
    const ctx = await context({ permissionMode: 'ask' });
    const prompt = vi.fn(async () => 'y');
    ctx.approve = new PermissionManager('ask', false, prompt).approve;
    const options = await oauthOptions(ctx, new AbortController());
    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error('PreToolUse hook is required');
    const decision = await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pwd' },
        tool_use_id: 'bash-read',
        session_id: 'sdk-thread',
        transcript_path: join(ctx.settings.cwd, 'transcript.jsonl'),
        cwd: ctx.settings.cwd,
      },
      'bash-read',
      { signal: ctx.signal },
    );
    expect(decision).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    });
    expect(ctx.session.transcript.at(-1)?.text).toContain('interactive terminal');
    expect(prompt).not.toHaveBeenCalled();
    expect(options.permissionMode).toBe('default');
  });

  it('shares approvals with canUseTool so a tool is not prompted twice', async () => {
    const ctx = await context({ permissionMode: 'ask' });
    const options = await oauthOptions(ctx, new AbortController());
    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
    if (!hook || !options.canUseTool) throw new Error('Both permission handlers are required');
    const args = { command: 'npm test' };
    await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: args,
        tool_use_id: 'bash-test',
        session_id: 'sdk-thread',
        transcript_path: join(ctx.settings.cwd, 'transcript.jsonl'),
        cwd: ctx.settings.cwd,
      },
      'bash-test',
      { signal: ctx.signal },
    );
    expect(
      await options.canUseTool('Bash', args, {
        signal: ctx.signal,
        toolUseID: 'bash-test',
        requestId: uuid,
      }),
    ).toEqual({ behavior: 'allow', updatedInput: args });
    expect(ctx.approve).toHaveBeenCalledTimes(1);
  });

  it('maps default full access to the SDK bypass mode', async () => {
    const ctx = await context({ effort: 'xhigh', fast: true });
    const options = await oauthOptions(ctx, new AbortController());
    expect(ctx.settings.permissionMode).toBe('full');
    expect(options.permissionMode).toBe('bypassPermissions');
    expect(options.allowDangerouslySkipPermissions).toBe(true);
    expect(options.canUseTool).toBeUndefined();
    expect(options.effort).toBe('xhigh');
    expect(options.thinking).toEqual({ type: 'adaptive' });
    expect(options.settings).toMatchObject({ fastMode: true });
  });

  it('redacts native tool outputs before returning them to the SDK and portable transcript', async () => {
    const ctx = await context();
    const options = await oauthOptions(ctx, new AbortController());
    const hook = options.hooks?.PostToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error('PostToolUse hook is required');
    const output = await hook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'printenv' },
        tool_response: { content: [{ type: 'text', text: `Value: ${ctx.credential.secret}` }] },
        tool_use_id: 'bash-env',
        session_id: 'sdk-thread',
        transcript_path: join(ctx.settings.cwd, 'transcript.jsonl'),
        cwd: ctx.settings.cwd,
      },
      'bash-env',
      { signal: ctx.signal },
    );
    expect(output).toHaveProperty('hookSpecificOutput.updatedToolOutput');
    expect(JSON.stringify(output)).not.toContain(ctx.credential.secret);
    expect(JSON.stringify(ctx.session.transcript)).not.toContain(ctx.credential.secret);
  });
});

describe('OAuth usage and failure events', () => {
  it.each([
    {
      kind: 'HTTP 401',
      diagnostic: 'API Error: 401 Invalid token sk-ant-startup-fixture-secret',
    },
    {
      kind: 'structured authentication error',
      diagnostic:
        '{"error":{"type":"authentication_error","message":"Invalid token sk-ant-startup-fixture-secret"}}',
    },
  ])(
    'rotates after a startup failure reported only on SDK stderr ($kind)',
    async ({ diagnostic }) => {
      const ctx = await context();
      const meter = new MeterStore(join(ctx.settings.cwd, 'state'));
      const close = vi.fn();
      sdk.query.mockImplementation(({ options }: { options: Options }) =>
        Object.assign(
          (async function* () {
            options.stderr?.(diagnostic);
            yield* [];
            throw new Error('Agent process exited with code 1');
          })(),
          { close },
        ),
      );
      const backup = vi.fn(async (next: EngineContext) => {
        await next.onRequest();
        expect(next.session.messages[0]?.content).toContain('Complete the task');
      });
      await runTask({
        settings: ctx.settings,
        session: ctx.session,
        prompt: 'Complete the task',
        ui: ctx.ui,
        approve: ctx.approve,
        signal: ctx.signal,
        meter,
        save: async () => undefined,
        candidates: [
          ctx.credential,
          { ...ctx.credential, name: 'backup', type: 'api-key', secret: 'backup-api-fixture' },
        ],
        engines: { oauth: runOAuth, 'api-key': backup },
      });
      expect(backup).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      const usage = (await meter.read()).credentials.account;
      expect(usage).toMatchObject({ status: 'exhausted', requests: 1, errors: 1, limitHits: 1 });
      expect(usage?.lastError).toContain('[redacted]');
      expect(usage?.lastError).not.toContain('sk-ant-startup-fixture-secret');
    },
  );

  it('subtracts resumed cumulative usage without double-counting cache or cost', () => {
    const previous = sdkUsage(result());
    const current = sdkUsage(
      result({
        total_cost_usd: 0.018,
        modelUsage: {
          'claude-haiku-5-5': modelUsage({
            inputTokens: 160,
            outputTokens: 30,
            cacheReadInputTokens: 100,
            cacheCreationInputTokens: 12,
          }),
        },
      }),
    );
    const delta = usageDifference(current, previous);
    expect(delta).toMatchObject({
      inputTokens: 60,
      outputTokens: 10,
      cacheReadTokens: 60,
      cacheWriteTokens: 2,
      requests: 0,
      unpricedRequests: 0,
    });
    expect(delta.costUsd).toBeCloseTo(0.008);
    expect(usageDifference(emptyUsage(), previous)).toEqual(emptyUsage());
  });

  it('accounts for every fresh OAuth query and carries context without native session files', async () => {
    const ctx = await context();
    appendTranscript(ctx.session, 'user', 'Create hello.txt');
    sdk.query
      .mockReturnValueOnce(
        stream([result({ modelUsage: { custom: modelUsage({ costBasis: 'unknown' }) } })]),
      )
      .mockReturnValueOnce(
        stream([
          result({
            modelUsage: { custom: modelUsage({ inputTokens: 150, costBasis: 'unknown' }) },
          }),
        ]),
      );
    await runOAuth(ctx, 'Create hello.txt');
    await runOAuth(ctx);
    const usages = vi.mocked(ctx.onUsage).mock.calls.map(([usage]) => usage);
    expect(usages).toHaveLength(2);
    expect(usages[0]).toMatchObject({ inputTokens: 100, unpricedRequests: 1, requests: 1 });
    expect(usages[1]).toMatchObject({ inputTokens: 150, unpricedRequests: 1, requests: 1 });
    const secondQuery = sdk.query.mock.calls[1]?.[0];
    expect(secondQuery?.prompt).toContain('Create hello.txt');
    expect(secondQuery?.prompt).toContain('Done.');
    expect(secondQuery?.options.persistSession).toBe(false);
    expect(secondQuery?.options.resume).toBeUndefined();
  });

  it('preserves a subscription reset when a later assistant error repeats the limit', async () => {
    const ctx = await context();
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const errorMessage: SDKAssistantMessage = {
      type: 'assistant',
      error: 'rate_limit',
      uuid,
      parent_tool_use_id: null,
      session_id: 'sdk-thread',
      message: {
        id: 'limit-message',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-5-5',
        content: [{ type: 'text', text: "You've hit your limit", citations: null }],
        container: null,
        context_management: null,
        diagnostics: null,
        stop_details: null,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: result().usage,
      },
    };
    const failedResult: SDKResultError = {
      ...result(),
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Rate limit reached'],
    };
    const events = stream([
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt },
        uuid,
        session_id: 'sdk-thread',
      },
      errorMessage,
      failedResult,
    ]);
    sdk.query.mockReturnValue(events);
    const failure: unknown = await runOAuth(ctx, 'Complete the task').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(classifyCredentialFailure(failure)?.resetAt).toBe(
      new Date(resetsAt * 1000).toISOString(),
    );
    expect(events.close).toHaveBeenCalledTimes(1);
    expect(ctx.checkpoint).toHaveBeenCalled();
  });
});
