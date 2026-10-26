import { describe, expect, it } from 'vitest';
import { classifyCredentialFailure } from '../src/failures.js';

const now = Date.parse('2026-10-26T12:00:00Z');

describe('credential exhaustion classification', () => {
  it('uses the latest provider reset for 429', () => {
    expect(
      classifyCredentialFailure(
        {
          status: 429,
          message: 'Rate limit exceeded',
          headers: new Headers({
            'retry-after': '30',
            'anthropic-ratelimit-tokens-remaining': '0',
            'anthropic-ratelimit-tokens-reset': '2026-10-26T12:01:00Z',
          }),
        },
        now,
      ),
    ).toMatchObject({ kind: 'rate-limit', resetAt: '2026-10-26T12:01:00.000Z', retryable: true });
  });

  it.each([
    [{ status: 401, message: 'Invalid key' }, 'authentication'],
    [{ type: 'assistant', error: 'authentication_failed' }, 'authentication'],
    [{ status: 402, message: 'Payment required' }, 'billing'],
    [{ status: 400, message: 'Your credit balance is too low to access the API' }, 'billing'],
    [{ error: { type: 'billing_error', message: 'Out of credits' } }, 'billing'],
    [{ message: "You've hit your weekly limit" }, 'quota'],
    [{ message: 'You have reached your specified API usage limits' }, 'quota'],
  ])('recognizes %j without a network call', (error, kind) => {
    expect(classifyCredentialFailure(error, now)?.kind).toBe(kind);
    expect(Date.parse(classifyCredentialFailure(error, now)?.resetAt ?? '')).toBeGreaterThan(now);
  });

  it('accepts rejected SDK subscription windows and seconds-based resets', () => {
    expect(
      classifyCredentialFailure(
        {
          type: 'rate_limit_event',
          rate_limit_info: {
            status: 'rejected',
            rateLimitType: 'seven_day',
            resetsAt: (now + 86_400_000) / 1000,
          },
        },
        now,
      ),
    ).toEqual({
      kind: 'quota',
      reason: 'Subscription limit reached (weekly window).',
      resetAt: '2026-10-27T12:00:00.000Z',
      retryable: true,
    });
  });

  it('ignores limit warnings and rejected windows already served by extra usage', () => {
    for (const info of [
      { status: 'allowed' },
      { status: 'allowed_warning', utilization: 0.9 },
      { status: 'rejected', isUsingOverage: true },
      { status: 'rejected', overageInUse: true },
    ]) {
      expect(
        classifyCredentialFailure({ type: 'rate_limit_event', rate_limit_info: info }, now),
      ).toBeUndefined();
    }
  });

  it('never rotates credentials for overload, unsupported models, denials or local budgets', () => {
    for (const error of [
      { status: 529, message: 'Provider overloaded' },
      { error: { type: 'overloaded_error', message: 'Overloaded' } },
      { status: 400, message: 'This model does not support fast mode' },
      { status: 403, message: 'Model is not available for this project' },
      { message: 'Permission denied by user' },
      { subtype: 'error_max_turns', errors: ['Rate limit'] },
      { subtype: 'error_max_budget_usd', errors: ['Out of credits'] },
    ]) {
      expect(classifyCredentialFailure(error, now)).toBeUndefined();
    }
  });

  it('redacts provider reasons before they reach persisted status', () => {
    const failure = classifyCredentialFailure(
      { status: 401, message: 'Invalid key sk-ant-fixture-never-a-real-key' },
      now,
    );
    expect(failure?.reason).not.toContain('sk-ant-fixture');
  });

  it('reads nested error reset times and falls back for invalid timestamps', () => {
    expect(
      classifyCredentialFailure({ status: 429, error: { reset_at: '2026-10-26T12:03:00Z' } }, now)
        ?.resetAt,
    ).toBe('2026-10-26T12:03:00.000Z');
    expect(classifyCredentialFailure({ status: 429, resetAt: 1e308 }, now)?.resetAt).toBe(
      '2026-10-26T12:01:00.000Z',
    );
  });
});
