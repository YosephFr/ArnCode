import type { SDKPartialAssistantMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { addUsage, emptyUsage, type UsageTotals } from '../usage.js';
import type { EngineContext } from './types.js';

const tokenFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;

export function sdkUsage(result: SDKResultMessage): UsageTotals {
  const totals = emptyUsage();
  for (const usage of Object.values(result.modelUsage)) {
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.cacheReadTokens += usage.cacheReadInputTokens;
    totals.cacheWriteTokens += usage.cacheCreationInputTokens;
    if (usage.costBasis === 'unknown') totals.unpricedRequests++;
  }
  totals.costUsd = result.total_cost_usd;
  return totals;
}

/** Save streamed tokens before a final result exists, then reconcile its authoritative bill. */
export class OAuthUsageTracker {
  private readonly messages = new Map<string, UsageTotals>();
  private readonly active = new Map<string | null, string>();
  private reported = emptyUsage();
  private reservedRequest = true;
  private finalized = false;
  private finalTurns = 0;

  constructor(private readonly ctx: Pick<EngineContext, 'onRequest' | 'onUsage' | 'session'>) {}

  async retry(): Promise<void> {
    await this.ctx.onRequest();
    this.reservedRequest = true;
  }

  async observe(message: SDKPartialAssistantMessage): Promise<void> {
    const { event, parent_tool_use_id: parent } = message;
    if (event.type !== 'message_start' && event.type !== 'message_delta') return;
    if (event.type === 'message_start') {
      this.active.set(parent, event.message.id);
      if (!this.messages.has(event.message.id)) {
        if (!this.reservedRequest) await this.ctx.onRequest();
        this.reservedRequest = false;
        this.messages.set(event.message.id, {
          ...emptyUsage(),
          requests: 1,
          unpricedRequests: 1,
          fastRequests: event.message.usage.speed === 'fast' ? 1 : 0,
        });
      }
    }
    const id = this.active.get(parent);
    const current = id && this.messages.get(id);
    if (!current) return;
    const usage = event.type === 'message_start' ? event.message.usage : event.usage;
    current.inputTokens = Math.max(current.inputTokens, usage.input_tokens ?? 0);
    current.outputTokens = Math.max(current.outputTokens, usage.output_tokens ?? 0);
    current.cacheReadTokens = Math.max(current.cacheReadTokens, usage.cache_read_input_tokens ?? 0);
    current.cacheWriteTokens = Math.max(
      current.cacheWriteTokens,
      usage.cache_creation_input_tokens ?? 0,
    );
    this.ctx.session.peakContextTokens = Math.max(
      this.ctx.session.peakContextTokens ?? 0,
      current.inputTokens + current.cacheReadTokens + current.cacheWriteTokens,
    );
    await this.commit(this.observed());
  }

  async finish(result: SDKResultMessage): Promise<number> {
    const observed = this.observed();
    const requests = Math.max(1, result.num_turns, this.messages.size);
    if (!this.finalized) {
      const missing = Math.max(0, requests - this.messages.size - Number(this.reservedRequest));
      if (missing) await this.ctx.onRequest(missing);
    } else if (requests > this.finalTurns) {
      await this.ctx.onRequest(requests - this.finalTurns);
    }
    const totals = sdkUsage(result);
    let incomplete = !Object.keys(result.modelUsage).length;
    for (const field of tokenFields) {
      if (totals[field] < observed[field]) incomplete = true;
      // An error result can contain zeroed counters after a partially billed response.
      totals[field] = Math.max(totals[field], observed[field]);
    }
    totals.requests = requests;
    totals.fastRequests = result.usage.speed === 'fast' ? requests : observed.fastRequests;
    totals.costUsd = Math.max(totals.costUsd, this.reported.costUsd);
    // Model-level price metadata cannot tell which individual turns were unpriced.
    totals.unpricedRequests = incomplete || totals.unpricedRequests ? requests : 0;
    await this.commit(totals);
    const turns = requests - this.finalTurns;
    this.finalTurns = requests;
    this.finalized = true;
    return turns;
  }

  async interrupted(): Promise<{ hasTokens: boolean; turns: number }> {
    if (this.finalized) return { hasTokens: false, turns: 0 };
    const observed = this.observed();
    observed.requests = Math.max(1, observed.requests);
    observed.unpricedRequests = observed.requests;
    await this.commit(observed);
    const turns = observed.requests - this.finalTurns;
    this.finalTurns = observed.requests;
    this.finalized = true;
    return { hasTokens: tokenFields.some((field) => observed[field] > 0), turns };
  }

  private observed(): UsageTotals {
    return [...this.messages.values()].reduce(addUsage, emptyUsage());
  }

  private async commit(totals: UsageTotals): Promise<void> {
    const delta = emptyUsage();
    for (const key of Object.keys(delta) as (keyof UsageTotals)[]) {
      delta[key] = totals[key] - this.reported[key];
    }
    if (!Object.values(delta).some((value) => value !== 0)) return;
    // Signed deltas clear provisional unpriced counts; stored aggregate totals stay nonnegative.
    await this.ctx.onUsage(delta);
    this.reported = { ...totals };
  }
}
