import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { BetaMessageStream } from '@anthropic-ai/sdk/lib/BetaMessageStream';
import type { MessageStreamParams } from '@anthropic-ai/sdk/resources/messages/messages';
import { withRetry } from '../backoff.js';
import { classifyCredentialFailure } from '../failures.js';
import { modelEffort, modelFeatures } from '../models.js';
import { appendTranscript, apiContext, type Session } from '../session.js';
import { systemPrompt } from '../prompt.js';
import { ToolRunner, isParallelSafe, toolDefinitions, type ToolResult } from '../tools/index.js';
import { usageFromAPI } from '../usage.js';
import type { Settings } from '../types.js';
import type { EngineContext } from './types.js';

/**
 * `full` uses the beta Messages API features the official endpoint supports; `basic` sends only
 * widely compatible fields, for proxies and other compatible endpoints.
 */
export type ApiMode = 'full' | 'basic';

const BETA = {
  binding: 'thinking-binding-controls-2026-08-01',
  updates: 'thinking-display-updates-2026-08-18',
  fallback: 'server-side-fallback-2026-07-01',
  compaction: 'compact-2026-09-04',
  messageEffort: 'mid-conversation-output-config-2026-07-01',
  fast: 'fast-mode-2026-02-01',
} as const;

const CONTINUE_AFTER_SUMMARY =
  'Continue the task from the summary above. Inspect files before repeating an edit or command.';

export function apiClient(secret: string, baseURL?: string): Anthropic {
  return new Anthropic({
    apiKey: secret,
    authToken: null,
    baseURL,
    maxRetries: 0,
    timeout: 10 * 60_000,
  });
}

export function apiMode(
  settings: Pick<Settings, 'baseUrl'>,
  env: NodeJS.ProcessEnv = process.env,
): ApiMode {
  const forced = env.ARNCODE_API_FEATURES;
  if (forced === 'full' || forced === 'basic') return forced;
  if (!settings.baseUrl) return 'full';
  try {
    return new URL(settings.baseUrl).origin === 'https://api.anthropic.com' ? 'full' : 'basic';
  } catch {
    return 'basic';
  }
}

export function cacheConversation(messages: BetaMessageParam[]): BetaMessageParam[] {
  let latestUser = messages.length - 1;
  while (latestUser >= 0 && messages[latestUser]?.role !== 'user') latestUser--;
  return messages.map((message, index): BetaMessageParam => {
    if (message.role === 'system') return message;
    if (typeof message.content === 'string') {
      if (index !== latestUser || !message.content) return message;
      return {
        ...message,
        content: [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }],
      };
    }
    const content = message.content.map((block) =>
      'cache_control' in block ? { ...block, cache_control: undefined } : block,
    ) as BetaContentBlockParam[];
    const last = content.at(-1);
    if (
      index === latestUser &&
      last &&
      last.type !== 'thinking' &&
      last.type !== 'redacted_thinking' &&
      (last.type !== 'text' || last.text)
    ) {
      content[content.length - 1] = {
        ...last,
        cache_control: { type: 'ephemeral' },
      } as BetaContentBlockParam;
    }
    return { ...message, content };
  });
}

function hasBlock(messages: BetaMessageParam[], type: string): boolean {
  return messages.some(
    (message) =>
      Array.isArray(message.content) &&
      (message.content as { type: string }[]).some((block) => block.type === type),
  );
}

/** Build one request. Pure, so the request shape can be tested without a network. */
export function apiRequest(
  settings: Settings,
  session: Session,
  mode: ApiMode,
  options: { compaction?: boolean } = {},
): BetaMessageStreamParams {
  const features = modelFeatures(settings.model);
  const conversation = session.api ?? { system: '', effort: settings.effort };
  const full = mode === 'full';
  const betas = new Set<string>();
  // Full mode never rewrites earlier turns: edits would invalidate later thinking blocks and the
  // prompt cache. Compaction bounds those conversations instead.
  const messages = full && features.compaction ? session.messages : apiContext(session.messages);
  const thinking = features.adaptive
    ? {
        type: 'adaptive' as const,
        ...(full && features.progressUpdates ? { display: 'updates' as const } : {}),
        ...(full ? { block_binding: { prefix_mismatch_behavior: 'drop_block' as const } } : {}),
      }
    : undefined;
  if (thinking && 'display' in thinking) betas.add(BETA.updates);
  if (thinking && 'block_binding' in thinking) betas.add(BETA.binding);
  const fast = settings.fast && features.fast;
  if (fast) betas.add(BETA.fast);
  const fallbacks = full && features.fallbacks && !options.compaction;
  if (fallbacks) betas.add(BETA.fallback);
  if (full && (options.compaction || hasBlock(messages, 'compaction'))) betas.add(BETA.compaction);
  if (full && messages.some((message) => message.role === 'system' && message.output_config))
    betas.add(BETA.messageEffort);
  return {
    model: settings.model,
    max_tokens: options.compaction ? Math.min(settings.maxTokens, 32_000) : settings.maxTokens,
    system: [{ type: 'text', text: conversation.system, cache_control: { type: 'ephemeral' } }],
    tools: toolDefinitions.map((tool, index) => ({
      ...tool,
      ...(full ? { eager_input_streaming: true } : {}),
      ...(index === toolDefinitions.length - 1
        ? { cache_control: { type: 'ephemeral' as const } }
        : {}),
    })),
    messages: cacheConversation(messages),
    ...(thinking ? { thinking } : {}),
    ...(features.adaptive
      ? { output_config: { effort: modelEffort(settings.model, conversation.effort) } }
      : {}),
    ...(fast ? { speed: 'fast' as const } : {}),
    ...(fallbacks ? { fallbacks: 'default' as const } : {}),
    ...(options.compaction ? { compaction: { type: 'summarize' as const } } : {}),
    ...(betas.size ? { betas: [...betas] } : {}),
  };
}

/**
 * Content to keep in history. Before the final fallback boundary, the declining model's thinking
 * and unanswered tool calls are dropped, as the refusal-fallback contract requires.
 */
export function historyContent(content: BetaContentBlock[]): BetaContentBlockParam[] {
  let boundary = content.length - 1;
  while (boundary >= 0 && content[boundary]?.type !== 'fallback') boundary--;
  const kept = content.filter((block, index) => {
    if (index >= boundary) return true;
    if (['thinking', 'redacted_thinking', 'tool_use'].includes(block.type)) return false;
    if (block.type === 'server_tool_use')
      return content.some(
        (other) =>
          other.type.endsWith('_tool_result') &&
          'tool_use_id' in other &&
          other.tool_use_id === block.id,
      );
    return (block.type as string) !== 'connector_text';
  });
  return kept as BetaContentBlockParam[];
}

/** Consecutive read-only calls run together; every other call runs alone, in order. */
export function toolGroups<T extends { name: string }>(calls: T[]): T[][] {
  const groups: T[][] = [];
  for (const call of calls) {
    const previous = groups.at(-1);
    if (previous && isParallelSafe(call.name) && isParallelSafe(previous[0]!.name))
      previous.push(call);
    else groups.push([call]);
  }
  return groups;
}

function contextSize(message: BetaMessage): number {
  const served = [...(message.usage.iterations ?? [])]
    .reverse()
    .find((item) => item.type === 'message' || item.type === 'fallback_message');
  const usage = served ?? message.usage;
  return (
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    usage.output_tokens
  );
}

function compactionLimit(settings: Settings): number {
  return Math.min(
    settings.compactAt,
    Math.floor(modelFeatures(settings.model).contextWindow * 0.85),
  );
}

function canCompact(settings: Settings, mode: ApiMode): boolean {
  return mode === 'full' && modelFeatures(settings.model).compaction;
}

function openStream(
  client: Anthropic,
  params: BetaMessageStreamParams,
  mode: ApiMode,
  signal: AbortSignal,
): BetaMessageStream {
  if (mode === 'full') return client.beta.messages.stream(params, { signal });
  const { betas, ...rest } = params;
  // Compatible endpoints get the stable path; the only beta used there is a header.
  return client.messages.stream(rest as MessageStreamParams, {
    signal,
    ...(betas?.length ? { headers: { 'anthropic-beta': betas.join(',') } } : {}),
  }) as unknown as BetaMessageStream;
}

async function recordUsage(ctx: EngineContext, message: BetaMessage): Promise<void> {
  const usage = usageFromAPI(message.model, message.usage, ctx.settings.baseUrl);
  const size = contextSize(message);
  ctx.session.contextTokens = size;
  ctx.session.peakContextTokens = Math.max(
    ctx.session.peakContextTokens ?? 0,
    size - message.usage.output_tokens,
  );
  await ctx.onUsage(usage);
}

/** Freeze the request prefix for a new conversation and apply effort changes cache-safely. */
async function prepareConversation(ctx: EngineContext, mode: ApiMode): Promise<void> {
  const { settings, session } = ctx;
  const effort = modelEffort(settings.model, settings.effort);
  if (!session.api) {
    session.api = { system: await systemPrompt(settings.cwd), effort };
    return;
  }
  const current = session.api.messageEffort ?? session.api.effort;
  if (current === effort) return;
  const features = modelFeatures(settings.model);
  const last = session.messages.at(-1);
  if (mode === 'full' && features.messageEffort && last?.role === 'user') {
    // An effort-only system message changes effort without restarting the prompt cache.
    session.messages.splice(-1, 0, { role: 'system', content: [], output_config: { effort } });
    session.api.messageEffort = effort;
  } else {
    session.api.effort = effort;
    delete session.api.messageEffort;
  }
}

/**
 * Replace the conversation with a server-written summary. Returns false when the API did not
 * return one; the history is then left unchanged.
 */
export async function compactConversation(
  ctx: EngineContext,
  client = apiClient(ctx.credential.secret, ctx.settings.baseUrl),
  keepLast = false,
): Promise<boolean> {
  const { settings, session, ui, signal } = ctx;
  const mode = apiMode(settings);
  if (!canCompact(settings, mode)) return false;
  session.api ??= {
    system: await systemPrompt(settings.cwd),
    effort: modelEffort(settings.model, settings.effort),
  };
  const kept = keepLast ? session.messages.slice(-1) : [];
  const history = keepLast ? session.messages.slice(0, -1) : session.messages;
  if (!history.length) return false;
  ui.status('Compacting conversation');
  try {
    const message = await withRetry(
      async () => {
        await ctx.onRequest();
        const params = apiRequest(settings, { ...session, messages: history }, mode, {
          compaction: true,
        });
        return openStream(client, params, mode, signal).finalMessage();
      },
      { signal, onRetry: async ({ failure }) => ctx.onRetryError?.(failure) },
    );
    await recordUsage(ctx, message);
    const block = message.content.find((item) => item.type === 'compaction');
    if (message.stop_reason !== 'compaction' || !block?.content) {
      ui.notice('The conversation could not be summarized. Continuing with the full history.');
      return false;
    }
    session.messages = [{ role: 'assistant', content: [block as BetaContentBlockParam] }, ...kept];
    // The cache restarts after a summary, so the effort can move back to the top level.
    session.api.effort = modelEffort(settings.model, settings.effort);
    delete session.api.messageEffort;
    session.compactions = (session.compactions ?? 0) + 1;
    session.contextTokens = Math.ceil(block.content.length / 3);
    appendTranscript(session, 'assistant', `[Conversation summary]\n${block.content}`);
    await ctx.checkpoint();
    ui.notice(`Conversation summarized to about ${session.contextTokens.toLocaleString()} tokens.`);
    return true;
  } catch (error) {
    // Summaries only save context; a failed one must not end the task.
    if (signal.aborted) throw error;
    ui.notice('The conversation could not be summarized. Continuing with the full history.');
    return false;
  } finally {
    ui.idle();
  }
}

function toolResultBlock(call: BetaToolUseBlock, result: ToolResult): BetaToolResultBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: call.id,
    content: result.content,
    ...(result.is_error ? { is_error: true } : {}),
  };
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 3);
}

export async function runAPI(ctx: EngineContext): Promise<void> {
  const { settings, session, ui, signal } = ctx;
  const mode = apiMode(settings);
  const client = apiClient(ctx.credential.secret, settings.baseUrl);
  const runner = new ToolRunner({
    cwd: settings.cwd,
    approve: ctx.approve,
    ui,
    protectedPaths: settings.protectedPaths,
  });
  if (
    session.api &&
    canCompact(settings, mode) &&
    (session.contextTokens ?? 0) > compactionLimit(settings) &&
    session.messages.length > 1
  ) {
    await compactConversation(ctx, client, true);
  }
  await prepareConversation(ctx, mode);
  let cutoffs = 0;
  let malformed = 0;
  while (ctx.budget.remaining > 0) {
    signal.throwIfAborted();
    ctx.budget.remaining--;
    ui.status('Thinking');
    let partialText = '';
    let progress = '';
    let message: BetaMessage;
    try {
      message = await withRetry(
        async () => {
          await ctx.onRequest();
          const stream = openStream(client, apiRequest(settings, session, mode), mode, signal);
          stream.on('text', (text) => {
            partialText += text;
            ui.text(text);
          });
          stream.on('thinking', (delta) => {
            if (!delta) return;
            progress += delta;
            ui.progress(delta);
          });
          stream.on('contentBlock', (block) => {
            if (block.type === 'thinking' && block.thinking) {
              ui.progress('\n');
              progress += '\n';
            } else if (block.type === 'fallback') {
              ui.notice(`${block.from.model} declined; ${block.to.model} continues.`);
            }
          });
          stream.on('streamEvent', (event) => {
            if (event.type === 'content_block_start' && event.content_block.type === 'tool_use')
              ui.status(`Preparing ${event.content_block.name}`);
          });
          return await stream.finalMessage();
        },
        {
          signal,
          shouldRetry: (error) =>
            !partialText && !(ctx.canFailover && classifyCredentialFailure(error)),
          onRetry: async ({ attempt, maxRetries, delayMs, error, failure }) => {
            await ctx.onRetryError?.(failure);
            ui.notice(
              `${error}\nRetry ${attempt}/${maxRetries} in ${(delayMs / 1000).toFixed(1)}s.`,
            );
            ui.status('Waiting to retry');
          },
        },
      );
    } catch (error) {
      if (progress) appendTranscript(session, 'assistant', progress.trim());
      // Eager tool-input streaming can surface unparseable JSON; no tool_use id exists to answer,
      // so the documented recovery is to issue the request again.
      if (
        error instanceof Error &&
        /Unable to parse tool parameter JSON/.test(error.message) &&
        ++malformed <= 2 &&
        !signal.aborted
      ) {
        ui.notice('The model sent an incomplete tool call. Asking again…');
        continue;
      }
      if (partialText)
        appendTranscript(session, 'assistant', `${partialText}\n[Response interrupted.]`);
      await ctx.checkpoint();
      throw error;
    } finally {
      ui.idle();
      ui.endText();
    }

    await recordUsage(ctx, message);
    if (progress.trim()) appendTranscript(session, 'assistant', progress.trim());
    if (partialText) appendTranscript(session, 'assistant', partialText);
    if (message.stop_reason === 'refusal') {
      await ctx.checkpoint();
      const details = message.stop_details;
      throw new Error(
        `Claude declined this request${details?.category ? ` (${details.category})` : ''}. ${details?.explanation ?? 'Revise the task to continue.'}`,
      );
    }
    if (message.stop_reason === 'max_tokens') {
      // Never execute a potentially truncated tool call or reuse unsigned partial thinking.
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      if (text) session.messages.push({ role: 'assistant', content: text });
      session.messages.push({
        role: 'user',
        content:
          'Your previous response reached its output limit. Continue the task from the last completed action. Be concise; do not repeat completed tool actions.',
      });
      await ctx.checkpoint();
      if (++cutoffs > 2)
        throw new Error(
          'Output limit reached repeatedly. Resume with a lower --effort or a larger --max-tokens.',
        );
      ui.notice('Output limit reached. Continuing the task…');
      continue;
    }
    const content = historyContent(message.content);
    if (content.length) session.messages.push({ role: 'assistant', content });
    await ctx.checkpoint();
    if (message.stop_reason === 'pause_turn') continue;
    const calls = content.filter((block): block is BetaToolUseBlock => block.type === 'tool_use');
    if (calls.length) {
      const results: BetaToolResultBlockParam[] = [];
      for (const group of toolGroups(calls)) {
        // Every call gets a result, even when cancellation interrupts a batch.
        const outcomes = await Promise.all(
          group.map((call) =>
            signal.aborted
              ? { content: 'Interrupted before execution.', is_error: true }
              : runner.run(call.name, call.input, signal),
          ),
        );
        group.forEach((call, index) => {
          const outcome = outcomes[index]!;
          results.push(toolResultBlock(call, outcome));
          appendTranscript(
            session,
            'tool',
            `${call.name} ${JSON.stringify(call.input)}\n${outcome.content}`,
          );
        });
        const remaining = calls.slice(results.length).map((pending): BetaToolResultBlockParam => ({
          type: 'tool_result',
          tool_use_id: pending.id,
          is_error: true,
          content:
            'Execution interrupted before this call completed. Inspect files before retrying.',
        }));
        // Persist completed actions before starting the next call in the batch.
        session.messages.push({ role: 'user', content: [...results, ...remaining] });
        await ctx.checkpoint();
        session.messages.pop();
      }
      session.messages.push({ role: 'user', content: results });
      session.contextTokens = (session.contextTokens ?? 0) + estimateTokens(results);
      await ctx.checkpoint();
      signal.throwIfAborted();
      if (
        canCompact(settings, mode) &&
        session.contextTokens > compactionLimit(settings) &&
        (await compactConversation(ctx, client))
      ) {
        session.messages.push({ role: 'user', content: CONTINUE_AFTER_SUMMARY });
        await ctx.checkpoint();
      }
      continue;
    }
    if (!partialText) ui.notice('Claude returned no text. Send a follow-up to continue.');
    return;
  }
  throw new Error(
    `Reached --max-turns (${settings.maxTurns}). The session is saved; use --continue to keep working.`,
  );
}
