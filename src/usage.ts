import type { Usage } from '@anthropic-ai/sdk/resources/messages';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  unpricedRequests: number;
  requests: number;
  fastRequests: number;
}

export type ApiUsage = Pick<Usage, 'input_tokens' | 'output_tokens'> &
  Partial<
    Pick<
      Usage,
      | 'cache_creation_input_tokens'
      | 'cache_read_input_tokens'
      | 'cache_creation'
      | 'speed'
      | 'service_tier'
    >
  > & { iterations?: IterationUsage[] | null };

/** One billed attempt: a sampling pass, a refusal-fallback pass, or a compaction pass. */
export interface IterationUsage {
  type: string;
  model?: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: Usage['cache_creation'];
}

interface Prices {
  input: number;
  output: number;
  read: number;
  fast?: boolean;
}

// USD per million tokens, checked 2026-10-27:
// https://platform.claude.com/docs/en/about-claude/pricing
const prices: Record<string, Prices> = {
  'claude-fable-5-1': { input: 10, output: 50, read: 0.25 },
  'claude-fable-5': { input: 10, output: 50, read: 1 },
  'claude-opus-5-5': { input: 4, output: 20, read: 0.2, fast: true },
  'claude-sonnet-5-5': { input: 2, output: 10, read: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, read: 0.01 },
  'claude-opus-5': { input: 5, output: 25, read: 0.5, fast: true },
  'claude-opus-4-8': { input: 5, output: 25, read: 0.5, fast: true },
  'claude-opus-4-7': { input: 5, output: 25, read: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, read: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, read: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, read: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, read: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, read: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, read: 0.1 },
};

export function emptyUsage(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    unpricedRequests: 0,
    requests: 0,
    fastRequests: 0,
  };
}

export function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: a.costUsd + b.costUsd,
    unpricedRequests: a.unpricedRequests + b.unpricedRequests,
    requests: a.requests + b.requests,
    fastRequests: a.fastRequests + b.fastRequests,
  };
}

function officialEndpoint(baseUrl?: string): boolean {
  if (!baseUrl) return true;
  try {
    return new URL(baseUrl).origin === 'https://api.anthropic.com';
  } catch {
    return false;
  }
}

function tokenCounts(usage: Omit<IterationUsage, 'type'>) {
  const write =
    usage.cache_creation_input_tokens ??
    (usage.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
      (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    read: usage.cache_read_input_tokens ?? 0,
    write,
    hourWrites: Math.min(write, usage.cache_creation?.ephemeral_1h_input_tokens ?? 0),
  };
}

/** Price one attempt; undefined when the model or tier has no published rate. */
function attemptCost(
  model: string,
  usage: Omit<IterationUsage, 'type'>,
  speed: ApiUsage['speed'],
  tier: ApiUsage['service_tier'],
): number | undefined {
  const modelId = model.replace(/-\d{8}$/, '');
  const tokens = tokenCounts(usage);
  let price = prices[modelId];
  if (modelId === 'claude-haiku-5-5' && tokens.input + tokens.read + tokens.write > 100_000) {
    price = { input: 0.5, output: 2.5, read: 0.05 };
  }
  if (!price || tier === 'priority' || (speed === 'fast' && !price.fast)) return undefined;
  const multiplier = (speed === 'fast' ? 2 : 1) * (tier === 'batch' ? 0.5 : 1);
  return (
    ((tokens.input * price.input +
      tokens.output * price.output +
      tokens.read * price.read +
      (tokens.write - tokens.hourWrites) * price.input * 1.25 +
      tokens.hourWrites * price.input * 2) *
      multiplier) /
    1_000_000
  );
}

const BILLED_ITERATIONS = new Set(['message', 'fallback_message', 'compaction']);

export function usageFromAPI(model: string, usage: ApiUsage, baseUrl?: string): UsageTotals {
  // When present, iterations are the per-attempt bill: refusal fallbacks and compaction passes
  // run at their own model's rates, and compaction is excluded from the top-level counts.
  const iterations = (usage.iterations ?? []).filter((item) => BILLED_ITERATIONS.has(item.type));
  const attempts: Omit<IterationUsage, 'type'>[] = iterations.length ? iterations : [usage];
  const result: UsageTotals = { ...emptyUsage(), requests: 1 };
  let cost: number | undefined = 0;
  for (const attempt of attempts) {
    const tokens = tokenCounts(attempt);
    result.inputTokens += tokens.input;
    result.outputTokens += tokens.output;
    result.cacheReadTokens += tokens.read;
    result.cacheWriteTokens += tokens.write;
    const price = attemptCost(attempt.model ?? model, attempt, usage.speed, usage.service_tier);
    cost = cost === undefined || price === undefined ? undefined : cost + price;
  }
  result.fastRequests = usage.speed === 'fast' ? 1 : 0;
  if (cost === undefined || !officialEndpoint(baseUrl)) result.unpricedRequests = 1;
  else result.costUsd = cost;
  return result;
}

export function formatUsage(usage: UsageTotals): string {
  if (!usage.requests) return 'No usage yet.';
  const parts = [
    `${usage.inputTokens.toLocaleString('en-US')} uncached in`,
    `${usage.outputTokens.toLocaleString('en-US')} out`,
    `${usage.cacheReadTokens.toLocaleString('en-US')} cache read`,
    `${usage.cacheWriteTokens.toLocaleString('en-US')} cache write`,
  ];
  if (usage.unpricedRequests >= usage.requests) {
    parts.push('cost unavailable');
  } else {
    const cost =
      usage.costUsd > 0 && usage.costUsd < 0.0001 ? '<$0.0001' : `$${usage.costUsd.toFixed(4)}`;
    parts.push(`${cost} estimated`);
    if (usage.unpricedRequests) {
      parts.push(
        `${usage.unpricedRequests} unpriced request${usage.unpricedRequests === 1 ? '' : 's'}`,
      );
    }
  }
  if (usage.fastRequests) {
    parts.push(`${usage.fastRequests} fast request${usage.fastRequests === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}
