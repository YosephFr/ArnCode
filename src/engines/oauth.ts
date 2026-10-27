import { constants } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  HookCallback,
  Options,
  Query,
  SDKRateLimitInfo,
} from '@anthropic-ai/claude-agent-sdk';
import { buildOAuthEnv } from '../auth.js';
import { getConfigDir } from '../config.js';
import { appendTranscript, portableContext, transcriptText } from '../session.js';
import { SUMMARY_INSTRUCTIONS } from '../summary.js';
import { PLAN_MODE_OFF, planModeReminder, subagentPrompt, systemPrompt } from '../prompt.js';
import { createPathPolicy, projectPath } from '../tools/paths.js';
import { ToolRunner, resultText, toolSchemas } from '../tools/index.js';
import { discoverSkills, loadSkill } from '../skills.js';
import { z } from 'zod';
import { redact, redactDeep, registerServerSecrets, StreamingRedactor } from '../redact.js';
import type { Approval, TodoItem } from '../types.js';
import type { EngineContext } from './types.js';
import { OAuthUsageTracker, sdkUsage } from './oauth-usage.js';

export { sdkUsage, usageDifference } from './oauth-usage.js';

class SDKFailure extends Error {
  constructor(
    message: string,
    readonly type?: string,
    readonly rateLimitInfo?: SDKRateLimitInfo,
  ) {
    super(redact(message));
  }
}

export function sdkDiagnosticError(error: unknown, diagnostic: string): Error {
  const message = redact(
    `${error instanceof Error ? error.message : String(error)}${diagnostic ? `\n${diagnostic}` : ''}`,
  );
  const status = /\b(?:HTTP|API Error:?)\s*(401|402|429)\b/i.exec(message)?.[1];
  const type =
    /["']type["']\s*:\s*["'](authentication_error|billing_error|rate_limit_error)["']/.exec(
      message,
    )?.[1];
  return Object.assign(new SDKFailure(message, type), status ? { status: Number(status) } : {});
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function bashOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  const response = record(output);
  if (response.isImage) return 'Image output returned.';
  const parts = [response.stdout, response.stderr].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (typeof response.timedOutAfterMs === 'number')
    parts.push(`Command timed out after ${Number(response.timedOutAfterMs) / 1000}s.`);
  else if (response.interrupted) parts.push('Command interrupted.');
  const exitCode = response.exitCode ?? response.exit_code;
  if (typeof exitCode === 'number' && Number.isFinite(exitCode) && exitCode !== 0)
    parts.push(`Exit status ${exitCode}.`);
  if (Array.isArray(response.content)) {
    for (const block of response.content) {
      const content = record(block);
      if (content.type === 'text' && typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n');
}

async function fileSnapshot(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 200_000) return undefined;
    const buffer = Buffer.alloc(200_001);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > 200_000 ? undefined : buffer.subarray(0, bytesRead).toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    return undefined;
  } finally {
    await handle?.close();
  }
}

/** The Agent SDK keeps its transcripts with ArnCode's state, out of the user's Claude Code history. */
export function sdkConfigDir(): string {
  return path.join(getConfigDir(), 'claude');
}

async function sdkThreadExists(id: string): Promise<boolean> {
  if (!/^[\w-]{1,80}$/.test(id)) return false;
  const projects = path.join(sdkConfigDir(), 'projects');
  for (const folder of await readdir(projects).catch(() => [])) {
    const found = await stat(path.join(projects, folder, `${id}.jsonl`)).then(
      (info) => info.isFile(),
      () => false,
    );
    if (found) return true;
  }
  return false;
}

export async function oauthOptions(
  ctx: EngineContext,
  abortController: AbortController,
): Promise<Options> {
  const approved = new Map<string, Approval>();
  const snapshots = new Map<string, { file: string; before: string }>();
  const started = new Map<string, { name: string; at: number }>();
  const activity = () => {
    const active = [...started.values()][0];
    ctx.ui.status(
      active ? (started.size > 1 ? 'Running tools' : `Running ${active.name}`) : 'Thinking',
    );
  };
  const pre: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const args = record(input.tool_input);
    const displayName = input.tool_name.replace(/^mcp__arncode__/, '');
    if (input.tool_name === 'TodoWrite' && Array.isArray(args.todos)) {
      const items = args.todos as TodoItem[];
      ctx.session.todos = items;
      ctx.ui.todos?.(items);
      return {};
    }
    ctx.ui.tool(displayName, args);
    try {
      if (
        ['Read', 'Write', 'Edit'].includes(input.tool_name) &&
        typeof args.file_path === 'string'
      ) {
        const policy = await createPathPolicy(ctx.settings.cwd, ctx.settings.protectedPaths);
        await projectPath(ctx.settings.cwd, args.file_path, input.tool_name === 'Write', policy);
      } else if (['Glob', 'Grep'].includes(input.tool_name)) {
        throw new Error('Native search is disabled. Use the provided glob and grep tools.');
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Invalid tool path.';
      ctx.ui.notice(reason);
      activity();
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      };
    }
    if (ctx.hooks?.has('PreToolUse')) {
      const outcome = await ctx.hooks.run(
        'PreToolUse',
        { tool_input: args },
        { tool: input.tool_name, signal: ctx.signal },
      );
      if (outcome.blocked) {
        const reason = `Blocked by a hook: ${outcome.blocked}`;
        ctx.ui.notice(reason);
        activity();
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        };
      }
    }
    const decision = await ctx.approve(input.tool_name, args, ctx.signal);
    approved.set(input.tool_use_id, decision);
    if (!decision.allowed) {
      ctx.ui.notice(decision.reason ?? 'Permission denied.');
      appendTranscript(
        ctx.session,
        'tool',
        `${input.tool_name}: ${decision.reason ?? 'Permission denied.'}`,
      );
      activity();
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: decision.reason,
        },
      };
    }
    if (['Write', 'Edit'].includes(input.tool_name) && typeof args.file_path === 'string') {
      const file = path.resolve(ctx.settings.cwd, args.file_path);
      await ctx.recordChange?.(file);
      const before = await fileSnapshot(file);
      if (before !== undefined) snapshots.set(input.tool_use_id, { file, before });
    }
    started.set(input.tool_use_id, { name: displayName, at: Date.now() });
    activity();
    return ctx.settings.permissionMode === 'full'
      ? {}
      : {
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
        };
  };
  const post: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PostToolUse' && input.hook_event_name !== 'PostToolUseFailure')
      return {};
    ctx.ui.idle();
    const output = input.hook_event_name === 'PostToolUse' ? input.tool_response : input.error;
    const text = typeof output === 'string' ? output : JSON.stringify(output);
    const response = record(output);
    const exitCode = response.exitCode ?? response.exit_code;
    const isError =
      input.hook_event_name === 'PostToolUseFailure' ||
      response.isError === true ||
      response.is_error === true ||
      response.interrupted === true ||
      typeof response.timedOutAfterMs === 'number' ||
      (typeof exitCode === 'number' && Number.isFinite(exitCode) && exitCode !== 0);
    const start = started.get(input.tool_use_id);
    if (input.tool_name === 'Bash' || isError) {
      if (!isError && response.backgroundTaskId) {
        ctx.ui.notice('Bash is running in the background.');
      } else {
        ctx.ui.toolResult(
          input.tool_name.replace(/^mcp__arncode__/, ''),
          input.tool_name === 'Bash' ? bashOutput(output) : (text ?? ''),
          { isError, durationMs: start === undefined ? undefined : Date.now() - start.at },
        );
      }
    }
    appendTranscript(
      ctx.session,
      'tool',
      `${input.tool_name} ${JSON.stringify(input.tool_input)}\n${redact(text ?? '').slice(0, 48_000)}`,
    );
    const snapshot = snapshots.get(input.tool_use_id);
    if (snapshot && input.hook_event_name === 'PostToolUse') {
      const after = await fileSnapshot(snapshot.file);
      if (after !== undefined && snapshot.before !== after)
        ctx.ui.diff(path.relative(ctx.settings.cwd, snapshot.file), snapshot.before, after);
    }
    snapshots.delete(input.tool_use_id);
    approved.delete(input.tool_use_id);
    started.delete(input.tool_use_id);
    await ctx.checkpoint();
    activity();
    if (input.hook_event_name === 'PostToolUse') {
      const safeOutput = redactDeep(output);
      const outcome = ctx.hooks?.has('PostToolUse')
        ? await ctx.hooks.run(
            'PostToolUse',
            {
              tool_input: record(input.tool_input),
              tool_response: redact(text ?? '').slice(0, 20_000),
            },
            { tool: input.tool_name, signal: ctx.signal },
          )
        : {};
      const feedback = outcome.blocked ?? outcome.context;
      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          updatedToolOutput: safeOutput,
          ...(feedback ? { additionalContext: `Hook feedback: ${feedback}` } : {}),
        },
      };
    }
    return {};
  };
  const skills = await discoverSkills(ctx.settings.cwd);
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
  const quiet = () => {};
  const search = new ToolRunner({
    cwd: ctx.settings.cwd,
    protectedPaths: ctx.settings.protectedPaths,
    approve: ctx.approve,
    exitPlan: ctx.exitPlan,
    ui: {
      // A plan presented without an interactive approver is the run's output.
      text: (value) => ctx.ui.text(value),
      endText: () => ctx.ui.endText(),
      status: quiet,
      idle: quiet,
      notice: quiet,
      progress: quiet,
      tool: quiet,
      toolResult: quiet,
      diff: quiet,
    },
  });
  const searchResult = async (name: 'glob' | 'grep', args: unknown) => {
    const result = await search.run(name, args, ctx.signal);
    return {
      content: [{ type: 'text' as const, text: resultText(result) }],
      isError: result.is_error,
    };
  };
  for (const server of Object.values(ctx.settings.mcpServers ?? {}))
    registerServerSecrets(
      'env' in server ? server.env : undefined,
      'headers' in server ? server.headers : undefined,
    );
  const mcpServers: NonNullable<Options['mcpServers']> = {
    ...(ctx.settings.mcpServers as NonNullable<Options['mcpServers']> | undefined),
    arncode: createSdkMcpServer({
      name: 'arncode',
      version: '0.1.0',
      tools: [
        tool(
          'glob',
          'Find project files while excluding protected paths.',
          toolSchemas.glob.shape,
          (args) => searchResult('glob', args),
        ),
        tool(
          'grep',
          'Search project text while excluding protected paths.',
          toolSchemas.grep.shape,
          (args) => searchResult('grep', args),
        ),
        tool(
          'exit_plan_mode',
          'In plan mode, present the finished plan so the user can approve it before anything changes. Write it in Markdown: the goal, the files to change and how, and how the result will be verified. Outside plan mode it does nothing.',
          { plan: z.string() },
          async ({ plan }) => {
            const result = await search.run('exit_plan_mode', { plan }, ctx.signal);
            return { content: [{ type: 'text' as const, text: resultText(result) }] };
          },
        ),
        ...(skills.length
          ? [
              tool(
                'skill',
                'Load the full instructions of an available skill by name.',
                { name: z.string() },
                async ({ name }) => {
                  try {
                    const skill = await loadSkill(ctx.settings.cwd, name);
                    return {
                      content: [
                        {
                          type: 'text',
                          text: redact(
                            `Skill: ${skill.name}\nBase directory: ${skill.basePath}\n\n${skill.body}`,
                          ),
                        },
                      ],
                    };
                  } catch (error) {
                    return {
                      isError: true,
                      content: [
                        {
                          type: 'text',
                          text: redact(error instanceof Error ? error.message : String(error)),
                        },
                      ],
                    };
                  }
                },
              ),
            ]
          : []),
      ],
    }),
  };
  return {
    cwd: ctx.settings.cwd,
    model: ctx.settings.model,
    maxTurns: ctx.budget.remaining,
    env: {
      ...buildOAuthEnv(ctx.credential.secret),
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      CLAUDE_CONFIG_DIR: sdkConfigDir(),
    },
    settingSources: [],
    mcpServers,
    strictMcpConfig: true,
    tools: [
      'Read',
      'Write',
      'Edit',
      'Bash',
      'TodoWrite',
      'Agent',
      ...(ctx.settings.webTools ? ['WebFetch', 'WebSearch'] : []),
    ],
    agents: {
      explore: {
        description:
          'Read-only investigation: searches and reads the project, then reports findings with file paths. Use it for broad searches whose intermediate output you do not need.',
        prompt: await subagentPrompt(ctx.settings.cwd, 'explore'),
        tools: ['Read', 'mcp__arncode__glob', 'mcp__arncode__grep'],
        model: 'haiku',
        effort: 'low',
      },
      general: {
        description:
          'Delegated work that may edit files and run commands; reports what it changed.',
        prompt: await subagentPrompt(ctx.settings.cwd, 'general'),
        tools: ['Read', 'Write', 'Edit', 'Bash', 'mcp__arncode__glob', 'mcp__arncode__grep'],
      },
    },
    // ArnCode enforces edits, ask and plan modes itself through hooks and canUseTool.
    permissionMode: ctx.settings.permissionMode === 'full' ? 'bypassPermissions' : 'default',
    allowDangerouslySkipPermissions: ctx.settings.permissionMode === 'full',
    ...(ctx.settings.permissionMode !== 'full'
      ? ({
          canUseTool: async (name, args, options) => {
            const decision =
              approved.get(options.toolUseID) ?? (await ctx.approve(name, args, options.signal));
            return decision.allowed
              ? { behavior: 'allow', updatedInput: args }
              : { behavior: 'deny', message: decision.reason ?? 'Permission denied.' };
          },
        } satisfies Partial<Options>)
      : {}),
    hooks: {
      PreToolUse: [{ hooks: [pre] }],
      PostToolUse: [{ hooks: [post] }],
      PostToolUseFailure: [{ hooks: [post] }],
    },
    includePartialMessages: true,
    persistSession: false,
    debug: false,
    abortController,
    thinking: { type: 'adaptive' },
    effort: ctx.settings.effort,
    settings: { fastMode: ctx.settings.fast },
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: await systemPrompt(ctx.settings.cwd, true),
    },
  };
}

/** Replace the portable transcript with a summary written by the model. */
export async function compactOAuth(ctx: EngineContext): Promise<boolean> {
  if (!ctx.session.transcript.length) return false;
  const start = ctx.session.transcript.length;
  ctx.ui.status('Compacting conversation');
  await runOAuth(
    ctx,
    `<conversation>\n${transcriptText(ctx.session)}\n</conversation>\n\n${SUMMARY_INSTRUCTIONS}`,
    { detached: true },
  );
  const summary = ctx.session.transcript
    .slice(start)
    .filter((entry) => entry.role === 'assistant')
    .map((entry) => entry.text)
    .join('\n')
    .trim();
  if (!summary) return false;
  ctx.session.transcript = [{ role: 'assistant', text: `[Conversation summary]\n${summary}` }];
  ctx.session.compactions = (ctx.session.compactions ?? 0) + 1;
  // The next request starts a new SDK session from the summary.
  delete ctx.session.oauth;
  await ctx.checkpoint();
  return true;
}

export interface OAuthRun {
  /** The newest user message, sent alone when the SDK session can be resumed. */
  latest?: string;
  /** A one-off request, such as a summary, outside the conversation's SDK session. */
  detached?: boolean;
}

/**
 * Run one request through the Agent SDK. While the credential stays the same, the SDK session is
 * resumed so the model keeps its real history and the cached prefix; otherwise `prompt` (or the
 * portable transcript) starts a new one.
 */
export async function runOAuth(
  ctx: EngineContext,
  prompt?: string,
  run: OAuthRun = {},
): Promise<void> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const abortController = new AbortController();
  const abort = () => abortController.abort(ctx.signal.reason);
  ctx.signal.throwIfAborted();
  ctx.signal.addEventListener('abort', abort, { once: true });
  const options = await oauthOptions(ctx, abortController);
  const thread = ctx.session.oauth;
  const keep = !run.detached && ctx.settings.oauthSessions;
  const resume =
    keep &&
    run.latest !== undefined &&
    thread?.credential === ctx.credential.name &&
    thread.totals !== undefined &&
    (await sdkThreadExists(thread.id))
      ? thread.id
      : undefined;
  if (keep) options.persistSession = true;
  if (resume) options.resume = resume;
  const planMode = ctx.settings.permissionMode === 'plan';
  const reminder = planMode
    ? planModeReminder(true)
    : resume && thread?.planMode
      ? PLAN_MODE_OFF
      : undefined;
  const stderrRedactor = new StreamingRedactor();
  let diagnostic = '';
  options.stderr = (text) => {
    diagnostic = (diagnostic + stderrRedactor.write(text)).slice(-4000);
  };
  await ctx.onRequest();
  const usage = new OAuthUsageTracker(ctx, resume ? thread?.totals : undefined);
  ctx.ui.status('Thinking');
  let stream: Query | undefined;
  const streamed = new Set<string>();
  const seen = new Set<string>();
  let messageId = '';
  let gotResult = false;
  let lastError: SDKFailure | undefined;
  let printed = false;
  let pendingText = '';
  let waitingToRetry = false;
  try {
    const text = resume ? run.latest! : (prompt ?? portableContext(ctx.session));
    stream = query({
      prompt: reminder ? `<system-reminder>${reminder}</system-reminder>\n\n${text}` : text,
      options,
    });
    for await (const message of stream) {
      if (message.type === 'rate_limit_event') ctx.onRateLimit?.(message.rate_limit_info);
      if (message.type === 'system' && message.subtype === 'init') {
        if (keep)
          ctx.session.oauth = {
            id: message.session_id,
            credential: ctx.credential.name,
            ...(planMode ? { planMode } : {}),
          };
        await ctx.checkpoint();
      }
      if (message.type === 'stream_event') {
        await usage.observe(message);
        // A subagent's own messages are its work, not the reply; only its report comes back.
        if (message.parent_tool_use_id !== null) continue;
        const event = message.event;
        if (event.type === 'message_start') {
          messageId = event.message.id;
          if (waitingToRetry) {
            waitingToRetry = false;
            ctx.ui.status('Thinking');
          }
        }
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          ctx.ui.text(event.delta.text);
          pendingText += event.delta.text;
          streamed.add(messageId);
          printed = true;
        }
        if (event.type === 'message_stop') ctx.ui.endText();
      } else if (
        message.type === 'assistant' &&
        message.parent_tool_use_id === null &&
        !seen.has(message.uuid)
      ) {
        seen.add(message.uuid);
        const text = message.message.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        if (message.error) {
          if (!lastError?.rateLimitInfo)
            lastError = new SDKFailure(text || message.error, message.error);
          pendingText = '';
        } else if (text) {
          appendTranscript(ctx.session, 'assistant', text);
          pendingText = '';
          if (!streamed.has(message.message.id)) {
            ctx.ui.text(text);
            ctx.ui.endText();
            printed = true;
          }
        }
        await ctx.checkpoint();
      } else if (
        message.type === 'rate_limit_event' &&
        message.rate_limit_info.status === 'rejected' &&
        !message.rate_limit_info.isUsingOverage &&
        !message.rate_limit_info.overageInUse
      ) {
        lastError = new SDKFailure(
          'Subscription limit reached.',
          'rate_limit_event',
          message.rate_limit_info,
        );
      } else if (
        message.type === 'system' &&
        message.subtype === 'api_retry' &&
        !seen.has(message.uuid)
      ) {
        seen.add(message.uuid);
        const failure = Object.assign(new SDKFailure(message.error, message.error), {
          status: message.error_status ?? undefined,
        });
        await ctx.onRetryError?.(failure);
        await usage.retry();
        ctx.ui.notice(
          `Request retry ${message.attempt}/${message.max_retries} in ${(message.retry_delay_ms / 1000).toFixed(1)}s.`,
        );
        ctx.ui.status('Waiting to retry');
        waitingToRetry = true;
      } else if (
        message.type === 'system' &&
        message.subtype === 'task_started' &&
        message.is_backgrounded
      ) {
        ctx.ui.notice('Background task started.');
      } else if (message.type === 'system' && message.subtype === 'task_notification') {
        ctx.ui.toolResult('Background task', message.summary, {
          isError: message.status !== 'completed',
          durationMs: message.usage?.duration_ms,
        });
      } else if (message.type === 'result') {
        gotResult = true;
        ctx.budget.remaining -= await usage.finish(message);
        // A resumed session reports totals since it began; keep them to bill the next request.
        if (keep && ctx.session.oauth)
          ctx.session.oauth.totals = { usage: sdkUsage(message), turns: message.num_turns };
        await ctx.checkpoint();
        if (message.is_error || message.subtype !== 'success') {
          throw (
            lastError ??
            Object.assign(
              new Error(message.subtype === 'success' ? message.result : message.errors.join('\n')),
              { subtype: message.subtype },
            )
          );
        }
        if (!printed && message.result) {
          ctx.ui.text(message.result);
          ctx.ui.endText();
          appendTranscript(ctx.session, 'assistant', message.result);
          printed = true;
        }
      }
    }
    if (!gotResult)
      throw (
        lastError ??
        new Error(
          `The agent stopped before completing the turn.${diagnostic ? ` ${diagnostic}` : ''}`,
        )
      );
  } catch (error) {
    // Without a final result the SDK's totals are unknown, so the next request starts afresh.
    if (!gotResult && keep) delete ctx.session.oauth;
    const interrupted = await usage.interrupted();
    ctx.budget.remaining -= interrupted.turns;
    if (interrupted.hasTokens) ctx.ui.notice('Usage saved so far; final cost is unavailable.');
    if (pendingText)
      appendTranscript(ctx.session, 'assistant', `${pendingText}\n[Response interrupted.]`);
    if (ctx.signal.aborted) throw error;
    throw lastError ?? sdkDiagnosticError(error, diagnostic + stderrRedactor.flush());
  } finally {
    stream?.close();
    ctx.signal.removeEventListener('abort', abort);
    ctx.ui.idle();
    ctx.ui.endText();
    await ctx.checkpoint();
  }
}
