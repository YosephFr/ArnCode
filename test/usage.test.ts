import { describe, expect, it } from 'vitest';
import { addUsage, emptyUsage, formatUsage, usageFromAPI } from '../src/usage.js';

describe('usage accounting', () => {
  it('charges uncached input, both cache lifetimes and output separately', () => {
    const usage = usageFromAPI('claude-opus-5-5', {
      input_tokens: 1000,
      output_tokens: 2000,
      cache_read_input_tokens: 10_000,
      cache_creation_input_tokens: 3000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
    });
    expect(usage.costUsd).toBeCloseTo(0.004 + 0.04 + 0.002 + 0.005 + 0.016);
    expect(usage.inputTokens).toBe(1000);
    expect(usage.cacheWriteTokens).toBe(3000);
    expect(usage.requests).toBe(1);
    expect(formatUsage(usage)).toContain('1,000 uncached in');
    expect(formatUsage(usage)).toContain('10,000 cache read');
    expect(formatUsage(usage)).toContain('3,000 cache write');
  });

  it('uses the reported speed and current double-price fast mode', () => {
    const input = { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 2000 };
    const standard = usageFromAPI('claude-opus-5-5', { ...input, speed: 'standard' });
    const fast = usageFromAPI('claude-opus-5-5', { ...input, speed: 'fast' });
    expect(fast.costUsd).toBeCloseTo(standard.costUsd * 2);
    expect(fast.fastRequests).toBe(1);
    expect(standard.fastRequests).toBe(0);
  });

  it('uses the higher Haiku tier only above 100k including cache tokens', () => {
    const atThreshold = usageFromAPI('claude-haiku-5-5', {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 99_000,
    });
    const aboveThreshold = usageFromAPI('claude-haiku-5-5', {
      input_tokens: 1001,
      output_tokens: 100,
      cache_read_input_tokens: 99_000,
    });
    expect(atThreshold.costUsd).toBeCloseTo((100 + 50 + 990) / 1_000_000);
    expect(aboveThreshold.costUsd).toBeCloseTo((500.5 + 250 + 4950) / 1_000_000);
  });

  it('bills each fallback and compaction attempt at its own model rate', () => {
    const usage = usageFromAPI('claude-opus-5-5', {
      input_tokens: 400,
      output_tokens: 200,
      iterations: [
        { type: 'message', model: 'claude-opus-5-5', input_tokens: 500, output_tokens: 100 },
        {
          type: 'fallback_message',
          model: 'claude-opus-5',
          input_tokens: 400,
          output_tokens: 200,
          cache_read_input_tokens: 1000,
        },
        { type: 'compaction', input_tokens: 2000, output_tokens: 300 },
      ],
    });
    const opus55 = (500 * 4 + 100 * 20 + 2000 * 4 + 300 * 20) / 1_000_000;
    const opus5 = (400 * 5 + 200 * 25 + 1000 * 0.5) / 1_000_000;
    expect(usage.costUsd).toBeCloseTo(opus55 + opus5);
    expect(usage.inputTokens).toBe(2900);
    expect(usage.outputTokens).toBe(600);
    expect(usage.cacheReadTokens).toBe(1000);
    expect(usage.requests).toBe(1);
  });

  it('prices Sonnet 5.5 cache reads at the published rate', () => {
    const usage = usageFromAPI('claude-sonnet-5-5', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
    });
    expect(usage.costUsd).toBeCloseTo(0.2);
  });

  it('keeps unknown models and custom provider rates visibly unpriced', () => {
    const input = { input_tokens: 100, output_tokens: 200 };
    for (const usage of [
      usageFromAPI('future-model', input),
      usageFromAPI('claude-opus-5-5', input, 'https://example.com/api'),
      usageFromAPI('claude-haiku-5-5', { ...input, speed: 'fast' }),
      usageFromAPI('claude-opus-5-5', { ...input, service_tier: 'priority' }),
    ]) {
      expect(usage.unpricedRequests).toBe(1);
      expect(usage.inputTokens).toBe(100);
      expect(formatUsage(usage)).toContain('cost unavailable');
      expect(formatUsage(usage)).not.toContain('$0.0000');
    }
  });

  it('adds totals without mutating the turn and exposes partial price coverage', () => {
    const turn = usageFromAPI('claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 500 });
    const first = addUsage(emptyUsage(), turn);
    const total = addUsage(
      first,
      usageFromAPI('unknown', { input_tokens: 2000, output_tokens: 200 }),
    );
    expect(first).toEqual(turn);
    expect(total.requests).toBe(2);
    expect(total.inputTokens).toBe(3000);
    expect(formatUsage(total)).toContain('$0.0070 estimated');
    expect(formatUsage(total)).toContain('1 unpriced request');
    expect(formatUsage(emptyUsage())).toBe('No usage yet.');
  });
});
