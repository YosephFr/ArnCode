import Anthropic from '@anthropic-ai/sdk';
import type { Message, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { withRetry } from '../backoff.js';
import { classifyCredentialFailure } from '../failures.js';
import { appendTranscript, apiContext } from '../session.js';
import { systemPrompt } from '../prompt.js';
import { ToolRunner, toolDefinitions } from '../tools/index.js';
import { usageFromAPI } from '../usage.js';
import type { EngineContext } from './types.js';

export function apiClient(secret: string, baseURL?: string): Anthropic {
  return new Anthropic({
    apiKey: secret,
    authToken: null,
    baseURL,
    maxRetries: 0,
    timeout: 10 * 60_000,
  });
}

export async function runAPI(ctx: EngineContext): Promise<void> {
  const { settings, session, ui, signal } = ctx;
  const client = apiClient(ctx.credential.secret, settings.baseUrl);
  const runner = new ToolRunner({ cwd: settings.cwd, approve: ctx.approve, ui });
  const system = await systemPrompt(settings.cwd);
  let cutoffs = 0;
  while (ctx.budget.remaining > 0) {
    signal.throwIfAborted();
    ctx.budget.remaining--;
    ui.status('Thinking');
    let partialText = '';
    let message: Message;
    try {
      message = await withRetry(
        async () => {
          await ctx.onRequest();
          const stream = client.messages.stream(
            {
              model: settings.model,
              max_tokens: settings.maxTokens,
              thinking: { type: 'adaptive' },
              output_config: { effort: settings.effort },
              ...(settings.fast ? { speed: 'fast' as const } : {}),
              system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
              tools: toolDefinitions.map((tool, i) =>
                i === toolDefinitions.length - 1
                  ? { ...tool, cache_control: { type: 'ephemeral' as const } }
                  : tool,
              ),
              messages: apiContext(session.messages),
            },
            {
              signal,
              ...(settings.fast ? { headers: { 'anthropic-beta': 'fast-mode-2026-02-01' } } : {}),
            },
          );
          stream.on('text', (text) => {
            partialText += text;
            ui.text(text);
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
      if (partialText)
        appendTranscript(session, 'assistant', `${partialText}\n[Response interrupted.]`);
      await ctx.checkpoint();
      throw error;
    } finally {
      ui.idle();
      ui.endText();
    }

    await ctx.onUsage(usageFromAPI(message.model, message.usage, settings.baseUrl));
    if (partialText) appendTranscript(session, 'assistant', partialText);
    if (message.stop_reason === 'max_tokens') {
      // Never execute a potentially truncated tool call or reuse unsigned partial thinking.
      const text = message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
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
    session.messages.push({ role: 'assistant', content: message.content });
    await ctx.checkpoint();
    const calls = message.content.filter((b) => b.type === 'tool_use');
    if (calls.length) {
      const results: ToolResultBlockParam[] = [];
      for (const call of calls) {
        // Every call gets a result, even when cancellation interrupts a batch.
        const result = signal.aborted
          ? { content: 'Interrupted before execution.', is_error: true }
          : await runner.run(call.name, call.input, signal);
        results.push({ type: 'tool_result', tool_use_id: call.id, ...result });
        appendTranscript(
          session,
          'tool',
          `${call.name} ${JSON.stringify(call.input)}\n${result.content}`,
        );
        const remaining = calls.slice(results.length).map((pending) => ({
          type: 'tool_result' as const,
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
      await ctx.checkpoint();
      signal.throwIfAborted();
      continue;
    }
    if (message.stop_reason === 'refusal')
      throw new Error('Claude declined this request. Revise the task to continue.');
    if (message.stop_reason === 'pause_turn') {
      session.messages.push({ role: 'user', content: 'Continue the task.' });
      continue;
    }
    if (!partialText) ui.notice('Claude returned no text. Send a follow-up to continue.');
    return;
  }
  throw new Error(
    `Reached --max-turns (${settings.maxTurns}). The session is saved; use --continue to keep working.`,
  );
}
