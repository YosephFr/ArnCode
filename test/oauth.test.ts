import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ModelUsage,
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultError,
  SDKResultSuccess,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatToolResult } from '../src/ui.js';
import { DEFAULTS } from '../src/config.js';
import { oauthOptions, runOAuth, sdkUsage, usageDifference } from '../src/engines/oauth.js';
import type { EngineContext } from '../src/engines/types.js';
import { classifyCredentialFailure } from '../src/failures.js';
import { MeterStore } from '../src/metering.js';
import { PermissionManager } from '../src/permissions.js';
import { runTask } from '../src/runner.js';
import { appendTranscript, newSession } from '../src/session.js';
import type { Settings } from '../src/types.js';
import { addUsage, emptyUsage, formatUsage } from '../src/usage.js';

const sdk = vi.hoisted(() => ({
  query: vi.fn(),
  createServer:
    vi.fn<
      (
        options: Parameters<typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer>[0],
      ) => void
    >(),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    query: sdk.query,
    createSdkMcpServer: (options: Parameters<typeof actual.createSdkMcpServer>[0]) => {
      sdk.createServer(options);
      return actual.createSdkMcpServer(options);
    },
  };
});

const directories: string[] = [];
const uuid = '11111111-1111-4111-8111-111111111111';
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  sdk.query.mockReset();
  sdk.createServer.mockReset();
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
    ui: plainUI(),
    approve: vi.fn(async () => ({ allowed: true })),
    signal: new AbortController().signal,
    budget: { remaining: settings.maxTurns },
    canFailover: true,
    checkpoint: vi.fn(async () => undefined),
    onRequest: vi.fn(async () => undefined),
    onUsage: vi.fn(async () => undefined),
  };
}

function plainUI() {
  const notice = vi.fn();
  return {
    text: vi.fn(),
    endText: vi.fn(),
    status: vi.fn(),
    idle: vi.fn(),
    notice,
    progress: vi.fn(),
    // Plain terminals print tool results as notices; keep that path observable.
    toolResult: vi.fn(
      (name: string, output: string, options?: { isError?: boolean; durationMs?: number }) =>
        notice(formatToolResult(name, output, options)),
    ),
    tool: vi.fn(),
    diff: vi.fn(),
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

function messageStart(id = 'response-1'): SDKPartialAssistantMessage {
  return {
    type: 'stream_event',
    uuid,
    session_id: 'sdk-thread',
    parent_tool_use_id: null,
    event: {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-5-5',
        content: [],
        container: null,
        context_management: null,
        diagnostics: null,
        stop_details: null,
        stop_reason: null,
        stop_sequence: null,
        usage: { ...result().usage, output_tokens: 0 },
      },
    },
  };
}

function messageDelta(outputTokens: number): SDKPartialAssistantMessage {
  return {
    type: 'stream_event',
    uuid,
    session_id: 'sdk-thread',
    parent_tool_use_id: null,
    event: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null, container: null },
      context_management: null,
      usage: {
        input_tokens: null,
        output_tokens: outputTokens,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        fallback_credit: null,
        iterations: null,
        output_tokens_details: null,
        server_tool_use: null,
      },
    },
  };
}

function persistUsage(ctx: EngineContext): MeterStore {
  const meter = new MeterStore(join(ctx.settings.cwd, 'state'));
  ctx.onRequest = vi.fn((count) => meter.request(ctx.credential, count));
  ctx.onUsage = vi.fn(async (usage) => {
    ctx.session.usage = addUsage(ctx.session.usage, usage);
    await meter.usage(ctx.credential, usage);
  });
  return meter;
}

describe('OAuth configuration and permissions', () => {
  it('guards direct paths and both MCP searches even without running the tool hooks', async () => {
    const ctx = await context({ protectedPaths: ['private'], permissionMode: 'ask' });
    const prompt = vi.fn(async () => 'n');
    ctx.approve = new PermissionManager('ask', false, prompt).approve;
    await mkdir(join(ctx.settings.cwd, 'private'));
    await writeFile(join(ctx.settings.cwd, '.env.example'), 'blocked_payload');
    await writeFile(join(ctx.settings.cwd, 'private', 'account.txt'), 'blocked_payload');
    await writeFile(join(ctx.settings.cwd, 'public.txt'), 'public_payload');
    const options = await oauthOptions(ctx, new AbortController());
    expect(options.tools).not.toContain('Glob');
    expect(options.tools).not.toContain('Grep');
    const registered = sdk.createServer.mock.calls.at(-1)?.[0].tools;
    const glob = registered?.find((entry) => entry.name === 'glob');
    const grep = registered?.find((entry) => entry.name === 'grep');
    if (!glob || !grep) throw new Error('Guarded search tools are required');
    const found = await glob.handler({ pattern: '**/*', path: '.' }, undefined);
    expect(JSON.stringify(found)).toContain('public.txt');
    expect(JSON.stringify(found)).not.toContain('account.txt');
    expect(JSON.stringify(found)).not.toContain('.env');
    const matched = await grep.handler(
      { pattern: 'payload', path: '.', glob: '**/*', literal: true, ignore_case: false },
      undefined,
    );
    expect(JSON.stringify(matched)).toContain('public_payload');
    expect(JSON.stringify(matched)).not.toContain('blocked_payload');
    expect(ctx.ui.tool).not.toHaveBeenCalled();
    expect(ctx.ui.notice).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    const pre = options.hooks?.PreToolUse?.[0]?.hooks[0];
    if (!pre) throw new Error('PreToolUse hook is required');
    const denied = await pre(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: 'private/account.txt' },
        tool_use_id: 'protected-read',
        session_id: 'sdk-thread',
        transcript_path: '',
        cwd: ctx.settings.cwd,
      },
      undefined,
      { signal: ctx.signal },
    );
    expect(denied).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'Path is protected by protectedPaths.',
      },
    });
  });

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
    expect(options.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
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
    expect(JSON.stringify(vi.mocked(ctx.ui.notice).mock.calls)).not.toContain(
      ctx.credential.secret,
    );
  });

  it('shows Bash outcomes and all failures without dumping successful Read contents', async () => {
    const ctx = await context();
    const options = await oauthOptions(ctx, new AbortController());
    const pre = options.hooks?.PreToolUse?.[0]?.hooks[0];
    const post = options.hooks?.PostToolUse?.[0]?.hooks[0];
    const failed = options.hooks?.PostToolUseFailure?.[0]?.hooks[0];
    if (!pre || !post || !failed) throw new Error('Tool hooks are required');
    const common = {
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_use_id: 'test-command',
      session_id: 'sdk-thread',
      transcript_path: join(ctx.settings.cwd, 'transcript.jsonl'),
      cwd: ctx.settings.cwd,
    };
    await pre({ ...common, hook_event_name: 'PreToolUse' }, undefined, { signal: ctx.signal });
    const overlapping = {
      ...common,
      tool_name: 'mcp__arncode__grep',
      tool_input: { pattern: 'needle' },
      tool_use_id: 'search-files',
    };
    await pre({ ...overlapping, hook_event_name: 'PreToolUse' }, undefined, { signal: ctx.signal });
    await post(
      { ...overlapping, hook_event_name: 'PostToolUse', tool_response: 'Search results' },
      undefined,
      { signal: ctx.signal },
    );
    expect(ctx.ui.status).toHaveBeenLastCalledWith('Running Bash');
    await post(
      {
        ...common,
        hook_event_name: 'PostToolUse',
        tool_response: { stdout: 'Tests passed', stderr: '', interrupted: false },
      },
      undefined,
      { signal: ctx.signal },
    );
    await failed(
      {
        ...common,
        tool_name: 'Read',
        hook_event_name: 'PostToolUseFailure',
        error: 'File missing',
      },
      undefined,
      { signal: ctx.signal },
    );
    await post(
      {
        ...common,
        tool_name: 'Read',
        hook_event_name: 'PostToolUse',
        tool_response: 'Long file body',
      },
      undefined,
      { signal: ctx.signal },
    );
    expect(ctx.ui.notice).toHaveBeenCalledTimes(2);
    expect(ctx.ui.notice).toHaveBeenCalledWith(
      expect.stringMatching(/Bash completed · .*s\n {2}Tests passed/),
    );
    expect(ctx.ui.notice).toHaveBeenCalledWith('Read failed\n  File missing');
    expect(ctx.ui.status).toHaveBeenCalledWith('Running Bash');
    expect(ctx.ui.status).toHaveBeenLastCalledWith('Thinking');
    await post(
      {
        ...common,
        hook_event_name: 'PostToolUse',
        tool_response: {
          stdout: '',
          stderr: '',
          interrupted: false,
          backgroundTaskId: 'background',
        },
      },
      undefined,
      { signal: ctx.signal },
    );
    expect(ctx.ui.notice).toHaveBeenLastCalledWith('Bash is running in the background.');
    for (const [tool_response, detail] of [
      [{ timedOutAfterMs: 1000 }, 'Command timed out after 1s.'],
      [{ exitCode: 2, stderr: 'Build failed' }, 'Build failed\n  Exit status 2.'],
    ] as const) {
      await post({ ...common, hook_event_name: 'PostToolUse', tool_response }, undefined, {
        signal: ctx.signal,
      });
      expect(ctx.ui.notice).toHaveBeenLastCalledWith(`Bash failed\n  ${detail}`);
    }
  });
});

describe('OAuth usage and failure events', () => {
  it('persists partial token usage when the SDK exits before a final result', async () => {
    const ctx = await context();
    const meter = persistUsage(ctx);
    sdk.query.mockReturnValue(
      Object.assign(
        (async function* () {
          yield messageStart();
          yield messageDelta(12);
          throw new Error('Agent process exited unexpectedly');
        })(),
        { close: vi.fn() },
      ),
    );
    await expect(runOAuth(ctx, 'Do the task')).rejects.toThrow('Agent process exited unexpectedly');
    const usage = (await meter.read()).credentials.account;
    expect(usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 12,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      requests: 1,
      unpricedRequests: 1,
    });
    expect(formatUsage(ctx.session.usage)).toContain('cost unavailable');
    expect(ctx.session.peakContextTokens).toBe(150);
    expect(ctx.ui.notice).toHaveBeenCalledWith('Usage saved so far; final cost is unavailable.');
    expect(ctx.budget.remaining).toBe(ctx.settings.maxTurns - 1);
  });

  it('carries only the remaining turn budget to a backup after a streamed limit failure', async () => {
    const ctx = await context({ maxTurns: 3 });
    const meter = new MeterStore(join(ctx.settings.cwd, 'state'));
    sdk.query.mockReturnValue(
      Object.assign(
        (async function* () {
          yield messageStart('first-response');
          yield messageDelta(12);
          yield messageStart('second-response');
          yield messageDelta(10);
          throw new Error('API Error: 429 Rate limit reached');
        })(),
        { close: vi.fn() },
      ),
    );
    const backup = vi.fn(async (next: EngineContext) => {
      expect(next.budget.remaining).toBe(1);
    });
    await runTask({
      settings: ctx.settings,
      session: ctx.session,
      prompt: 'Finish the task',
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
    expect((await meter.read()).credentials.account).toMatchObject({
      inputTokens: 200,
      outputTokens: 22,
      requests: 2,
      unpricedRequests: 2,
      status: 'exhausted',
    });
  });

  it('keeps every turn unpriced when final SDK model pricing is unknown', async () => {
    const ctx = await context();
    const meter = persistUsage(ctx);
    const final = result({
      num_turns: 2,
      total_cost_usd: 0,
      modelUsage: {
        custom: modelUsage({
          inputTokens: 200,
          outputTokens: 32,
          cacheReadInputTokens: 80,
          cacheCreationInputTokens: 20,
          costUSD: 0,
          costBasis: 'unknown',
        }),
      },
    });
    sdk.query.mockReturnValue(
      stream([
        messageStart('first-response'),
        messageDelta(12),
        messageStart('second-response'),
        messageDelta(20),
        messageStart('second-response'),
        final,
        final,
      ]),
    );
    await runOAuth(ctx, 'Do the task');
    expect((await meter.read()).credentials.account).toMatchObject({
      inputTokens: 200,
      outputTokens: 32,
      requests: 2,
      unpricedRequests: 2,
      costUsd: 0,
    });
    expect(ctx.budget.remaining).toBe(ctx.settings.maxTurns - 2);
    expect(formatUsage(ctx.session.usage)).toContain('cost unavailable');
    expect(formatUsage(ctx.session.usage)).not.toContain('$0.0000');
  });

  it('reconciles streamed counters once, clears provisional unknown cost, and accepts a zero bill', async () => {
    const ctx = await context();
    const meter = persistUsage(ctx);
    const final = result({
      total_cost_usd: 0,
      modelUsage: { 'claude-haiku-5-5': modelUsage({ costUSD: 0 }) },
    });
    sdk.query.mockReturnValue(
      stream([messageStart(), messageDelta(20), messageStart(), final, final]),
    );
    await runOAuth(ctx, 'Do the task');
    const expected = {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      requests: 1,
      unpricedRequests: 0,
      costUsd: 0,
    };
    expect((await meter.read()).credentials.account).toMatchObject(expected);
    expect(ctx.session.usage).toMatchObject(expected);
    expect(ctx.onRequest).toHaveBeenCalledTimes(1);
    expect(ctx.ui.text).toHaveBeenCalledTimes(1);
    expect(ctx.budget.remaining).toBe(ctx.settings.maxTurns - 1);
    expect(formatUsage(ctx.session.usage)).toContain('$0.0000 estimated');
  });

  it('does not erase streamed usage when an error result contains empty counters', async () => {
    const ctx = await context();
    const meter = persistUsage(ctx);
    const failure: SDKResultError = {
      ...result({ total_cost_usd: 0, modelUsage: {} }),
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Connection closed'],
    };
    sdk.query.mockReturnValue(stream([messageStart(), messageDelta(12), failure]));
    await expect(runOAuth(ctx, 'Do the task')).rejects.toThrow('Connection closed');
    expect((await meter.read()).credentials.account).toMatchObject({
      inputTokens: 100,
      outputTokens: 12,
      requests: 1,
      unpricedRequests: 1,
    });
    expect(formatUsage(ctx.session.usage)).toContain('cost unavailable');
  });

  it('surfaces SDK retries and background failures without restarting tool heartbeats', async () => {
    const ctx = await context();
    const meter = persistUsage(ctx);
    ctx.onRetryError = vi.fn(async () => undefined);
    sdk.query.mockReturnValue(
      stream([
        {
          type: 'system',
          subtype: 'api_retry',
          attempt: 1,
          max_retries: 3,
          retry_delay_ms: 2000,
          error_status: 429,
          error: 'rate_limit',
          uuid,
          session_id: 'sdk-thread',
        },
        messageStart(),
        ...[1, 2, 3].map((elapsed_time_seconds): SDKMessage => ({
          type: 'tool_progress',
          tool_use_id: 'render',
          tool_name: 'Bash',
          elapsed_time_seconds,
          parent_tool_use_id: null,
          uuid,
          session_id: 'sdk-thread',
        })),
        {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'background',
          status: 'failed',
          output_file: '/tmp/output',
          summary: 'Render failed',
          uuid,
          session_id: 'sdk-thread',
        },
        result(),
      ]),
    );
    await runOAuth(ctx, 'Do the task');
    expect(ctx.ui.status).toHaveBeenCalledTimes(3);
    expect(ctx.ui.status).toHaveBeenLastCalledWith('Thinking');
    expect(ctx.ui.notice).toHaveBeenCalledWith('Request retry 1/3 in 2.0s.');
    expect(ctx.ui.notice).toHaveBeenCalledWith('Background task failed\n  Render failed');
    expect(ctx.onRetryError).toHaveBeenCalledWith(
      expect.objectContaining({ status: 429, type: 'rate_limit' }),
    );
    expect((await meter.read()).credentials.account).toMatchObject({
      requests: 2,
      inputTokens: 100,
    });
  });

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
