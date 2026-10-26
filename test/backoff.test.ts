import { describe, expect, it, vi } from 'vitest';
import { formatApiError, RequestError, withRetry } from '../src/backoff.js';

const timestamp = Date.parse('2026-10-26T12:00:00Z');

describe('bounded provider retries', () => {
  it.each([100, NaN])(
    'caps the retry count even with a malformed bound (%s)',
    async (maxRetries) => {
      const request = vi.fn().mockRejectedValue({ status: 429, message: 'Too many requests' });
      const sleep = vi.fn().mockResolvedValue(undefined);
      await expect(withRetry(request, { sleep, random: () => 0.5, maxRetries })).rejects.toThrow(
        'Retry limit reached after 4 retries',
      );
      expect(request).toHaveBeenCalledTimes(5);
      expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([1000, 2000, 4000, 8000]);
    },
  );

  it('honors retry-after and the latest exhausted token reset', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce({
        status: 429,
        message: 'Input token limit reached',
        headers: new Headers({
          'retry-after': '2',
          'anthropic-ratelimit-input-tokens-remaining': '0',
          'anthropic-ratelimit-input-tokens-reset': '2026-10-26T12:00:05Z',
          'anthropic-ratelimit-requests-remaining': '5',
          'anthropic-ratelimit-requests-reset': '2026-10-26T12:10:00Z',
        }),
      })
      .mockResolvedValue('complete');
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();
    await expect(
      withRetry(request, { sleep, onRetry, now: () => timestamp, random: () => 0.5 }),
    ).resolves.toBe('complete');
    expect(sleep).toHaveBeenCalledWith(5000, undefined);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({
      attempt: 1,
      delayMs: 5000,
      rateLimits: { 'retry-after': '2' },
    });
  });

  it('accepts an HTTP date retry-after and refuses waits beyond the cap', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const request = vi.fn().mockRejectedValue({
      status: 529,
      message: 'Provider overloaded',
      headers: { 'Retry-After': 'Mon, 26 Oct 2026 12:02:00 GMT' },
    });
    await expect(withRetry(request, { sleep, now: () => timestamp })).rejects.toThrow(
      'Retry requires 120s',
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('handles a streaming overload with no HTTP status', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce({ error: { type: 'overloaded_error', message: 'Overloaded' } })
      .mockResolvedValue(42);
    await expect(withRetry(request, { sleep: async () => undefined })).resolves.toBe(42);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('finishes asynchronous retry accounting before waiting or starting the next request', async () => {
    const events: string[] = [];
    let attempts = 0;
    await withRetry(
      async () => {
        events.push('request');
        if (++attempts === 1) throw { status: 529, message: 'Overloaded' };
      },
      {
        onRetry: async ({ failure }) => {
          expect(failure).toBeInstanceOf(RequestError);
          expect(failure.status).toBe(529);
          await Promise.resolve();
          events.push('recorded');
        },
        sleep: async () => {
          events.push('wait');
        },
      },
    );
    expect(events).toEqual(['request', 'recorded', 'wait', 'request']);
  });

  it('lets the caller prevent retries after partial output or select another credential', async () => {
    const request = vi.fn().mockRejectedValue({ status: 429, message: 'Rate limit' });
    await expect(withRetry(request, { shouldRetry: () => false })).rejects.toMatchObject({
      status: 429,
      name: 'RequestError',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not retry authentication failures and removes secrets from error details', async () => {
    const secret = 'sk-ant-test-fixture-value';
    const request = vi.fn().mockRejectedValue({
      status: 401,
      message: `Invalid credential: ${secret}`,
      headers: { authorization: `Bearer ${secret}`, 'retry-after': '1' },
    });
    let failure: unknown;
    try {
      await withRetry(request);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RequestError);
    expect(formatApiError(failure)).toContain('HTTP 401');
    expect(formatApiError(failure)).not.toContain(secret);
    expect(formatApiError(failure)).not.toContain('authorization');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('interrupts a backoff wait promptly', async () => {
    const controller = new AbortController();
    const request = vi.fn().mockRejectedValue({ status: 529, message: 'Overloaded' });
    const promise = withRetry(request, {
      signal: controller.signal,
      onRetry: () => controller.abort(),
    });
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
