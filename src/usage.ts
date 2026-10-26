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
  >;

interface Prices {
  input: number;
  output: number;
  read: number;
  fast?: boolean;
}

// USD per million tokens, checked 2026-10-26:
// https://platform.claude.com/docs/en/about-claude/pricing
const prices: Record<string, Prices> = {
  'claude-opus-5-5': { input: 4, output: 20, read: 0.2, fast: true },
  'claude-sonnet-5-5': { input: 2, output: 10, read: 0.1 },
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

export function usageFromAPI(model: string, usage: ApiUsage, baseUrl?: string): UsageTotals {
  const result: UsageTotals = {
    ...emptyUsage(),
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens:
      usage.cache_creation_input_tokens ??
      (usage.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
        (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0),
    requests: 1,
    fastRequests: usage.speed === 'fast' ? 1 : 0,
  };
  const modelId = model.replace(/-\d{8}$/, '');
  let price = prices[modelId];
  const totalInput = result.inputTokens + result.cacheReadTokens + result.cacheWriteTokens;
  if (modelId === 'claude-haiku-5-5' && totalInput > 100_000) {
    price = { input: 0.5, output: 2.5, read: 0.05 };
  }
  if (
    !price ||
    !officialEndpoint(baseUrl) ||
    usage.service_tier === 'priority' ||
    (usage.speed === 'fast' && !price.fast)
  ) {
    result.unpricedRequests = 1;
    return result;
  }
  const hourWrites = Math.min(
    result.cacheWriteTokens,
    usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
  );
  const fiveMinuteWrites = result.cacheWriteTokens - hourWrites;
  const multiplier = (usage.speed === 'fast' ? 2 : 1) * (usage.service_tier === 'batch' ? 0.5 : 1);
  result.costUsd =
    ((result.inputTokens * price.input +
      result.outputTokens * price.output +
      result.cacheReadTokens * price.read +
      fiveMinuteWrites * price.input * 1.25 +
      hourWrites * price.input * 2) *
      multiplier) /
    1_000_000;
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
