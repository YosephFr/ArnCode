import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type {
  HookCallback,
  Options,
  Query,
  SDKRateLimitInfo,
} from '@anthropic-ai/claude-agent-sdk';
import { buildOAuthEnv } from '../auth.js';
import { appendTranscript, portableContext } from '../session.js';
import { systemPrompt } from '../prompt.js';
import { emptyUsage, type UsageTotals } from '../usage.js';
import { projectPath } from '../tools/paths.js';
import { discoverSkills, loadSkill } from '../skills.js';
import { z } from 'zod';
import { redact, StreamingRedactor } from '../redact.js';
import { formatToolResult } from '../ui.js';
import type { Approval } from '../types.js';
import type { EngineContext } from './types.js';
import { OAuthUsageTracker } from './oauth-usage.js';

export { sdkUsage } from './oauth-usage.js';

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
    ctx.ui.tool(input.tool_name === 'mcp__arncode__skill' ? 'skill' : input.tool_name, args);
    try {
      if (
        ['Read', 'Write', 'Edit'].includes(input.tool_name) &&
        typeof args.file_path === 'string'
      ) {
        await projectPath(ctx.settings.cwd, args.file_path, input.tool_name === 'Write');
      } else if (['Glob', 'Grep'].includes(input.tool_name)) {
        await projectPath(ctx.settings.cwd, typeof args.path === 'string' ? args.path : '.');
        if (
          input.tool_name === 'Glob' &&
          typeof args.pattern === 'string' &&
          (path.isAbsolute(args.pattern) || args.pattern.split(/[\\/]/).includes('..'))
        )
          throw new Error('Glob pattern must stay inside the project directory.');
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
      const before = await fileSnapshot(file);
      if (before !== undefined) snapshots.set(input.tool_use_id, { file, before });
    }
    started.set(input.tool_use_id, { name: input.tool_name, at: Date.now() });
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
        ctx.ui.notice(
          formatToolResult(
            input.tool_name,
            input.tool_name === 'Bash' ? bashOutput(output) : (text ?? ''),
            {
              isError,
              durationMs: start === undefined ? undefined : Date.now() - start.at,
            },
          ),
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
      const safeOutput: unknown = JSON.parse(
        JSON.stringify(output ?? null, (_key, value: unknown) =>
          typeof value === 'string' ? redact(value) : value,
        ),
      );
      return {
        hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: safeOutput },
      };
    }
    return {};
  };
  const skills = await discoverSkills(ctx.settings.cwd);
  const mcpServers: NonNullable<Options['mcpServers']> = {};
  if (skills.length) {
    const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
    mcpServers.arncode = createSdkMcpServer({
      name: 'arncode',
      version: '0.1.0',
      tools: [
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
      ],
    });
  }
  return {
    cwd: ctx.settings.cwd,
    model: ctx.settings.model,
    maxTurns: ctx.budget.remaining,
    env: {
      ...buildOAuthEnv(ctx.credential.secret),
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    },
    settingSources: [],
    mcpServers,
    strictMcpConfig: true,
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    permissionMode: ctx.settings.permissionMode === 'full' ? 'bypassPermissions' : 'default',
    allowDangerouslySkipPermissions: ctx.settings.permissionMode === 'full',
    ...(ctx.settings.permissionMode === 'ask'
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

export function usageDifference(current: UsageTotals, previous = emptyUsage()): UsageTotals {
  return {
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    cacheReadTokens: Math.max(0, current.cacheReadTokens - previous.cacheReadTokens),
    cacheWriteTokens: Math.max(0, current.cacheWriteTokens - previous.cacheWriteTokens),
    costUsd: Math.max(0, current.costUsd - previous.costUsd),
    unpricedRequests: Math.max(0, current.unpricedRequests - previous.unpricedRequests),
    requests: 0,
    fastRequests: 0,
  };
}

export async function runOAuth(ctx: EngineContext, prompt?: string): Promise<void> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const abortController = new AbortController();
  const abort = () => abortController.abort(ctx.signal.reason);
  ctx.signal.throwIfAborted();
  ctx.signal.addEventListener('abort', abort, { once: true });
  const options = await oauthOptions(ctx, abortController);
  const stderrRedactor = new StreamingRedactor();
  let diagnostic = '';
  options.stderr = (text) => {
    diagnostic = (diagnostic + stderrRedactor.write(text)).slice(-4000);
  };
  await ctx.onRequest();
  const usage = new OAuthUsageTracker(ctx);
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
    stream = query({ prompt: prompt ?? portableContext(ctx.session), options });
    for await (const message of stream) {
      if (message.type === 'system' && message.subtype === 'init') await ctx.checkpoint();
      if (message.type === 'stream_event') {
        await usage.observe(message);
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
      } else if (message.type === 'assistant' && !seen.has(message.uuid)) {
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
        ctx.ui.notice(
          formatToolResult('Background task', message.summary, {
            isError: message.status !== 'completed',
            durationMs: message.usage?.duration_ms,
          }),
        );
      } else if (message.type === 'result') {
        gotResult = true;
        ctx.budget.remaining -= await usage.finish(message);
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
