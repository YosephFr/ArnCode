import { setTimeout as wait } from 'node:timers/promises';
import { redact } from './redact.js';

export interface RetryNotice {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: string;
  failure: RequestError;
  rateLimits: Record<string, string>;
}

export interface RetryOptions {
  signal?: AbortSignal;
  maxRetries?: number;
  maxDelayMs?: number;
  onRetry?: (notice: RetryNotice) => void | Promise<void>;
  shouldRetry?: (error: unknown) => boolean;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface ApiErrorDetails {
  status?: number;
  type?: string;
  message: string;
  headers: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function errorObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function apiErrorDetails(error: unknown): ApiErrorDetails {
  const source = errorObject(error);
  const nested = errorObject(source.error);
  const inner = errorObject(nested.error);
  const status = typeof source.status === 'number' ? source.status : undefined;
  const type = [inner.type, nested.type, source.error, source.type].find(
    (value) =>
      typeof value === 'string' &&
      !['error', 'assistant', 'result', 'system', 'rate_limit_event'].includes(value),
  );
  const message = [source.message, inner.message, nested.message].find(
    (value) => typeof value === 'string',
  );
  const headers: Record<string, string> = {};
  const entries =
    source.headers instanceof Headers
      ? source.headers.entries()
      : Object.entries(errorObject(source.headers));
  for (const [key, value] of entries) {
    const name = key.toLowerCase();
    if (
      (name === 'retry-after' ||
        name.startsWith('anthropic-ratelimit-') ||
        name.startsWith('anthropic-fast-')) &&
      (typeof value === 'string' || typeof value === 'number')
    ) {
      headers[name] = redact(String(value)).slice(0, 200);
    }
  }
  return {
    status,
    type: typeof type === 'string' ? redact(type) : undefined,
    message: redact(
      typeof message === 'string'
        ? message
        : typeof error === 'string'
          ? error
          : 'The provider request failed.',
    ).slice(0, 2000),
    headers,
  };
}

export function formatApiError(error: unknown): string {
  if (error instanceof RequestError) return redact(error.message);
  const details = apiErrorDetails(error);
  const label = details.status ? `HTTP ${details.status}: ` : '';
  const limits = Object.entries(details.headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join(', ');
  return `${label}${details.message}${limits ? ` (${limits})` : ''}`;
}

export class RequestError extends Error {
  readonly status?: number;
  readonly type?: string;
  readonly headers: Record<string, string>;

  constructor(error: unknown, suffix = '') {
    super(`${formatApiError(error)}${suffix}`);
    this.name = 'RequestError';
    const details = apiErrorDetails(error);
    this.status = details.status;
    this.type = details.type;
    this.headers = details.headers;
  }
}

export function retryAtFromHeaders(
  headers: Record<string, string>,
  now = Date.now(),
): number | undefined {
  const resets: number[] = [];
  const retryAfter = headers['retry-after'];
  if (retryAfter !== undefined) {
    const at = /^\d+(?:\.\d+)?$/.test(retryAfter.trim())
      ? now + Number(retryAfter) * 1000
      : Date.parse(retryAfter);
    if (Number.isFinite(at) && at >= now) resets.push(at);
  }
  for (const [name, value] of Object.entries(headers)) {
    if (!name.endsWith('-reset')) continue;
    const prefix = name.slice(0, -6);
    const remaining = headers[`${prefix}-remaining`];
    const status = headers[`${prefix}-status`];
    if (remaining !== undefined && Number(remaining) > 0) continue;
    if (status !== undefined && !/^(?:rejected|exhausted|blocked)$/i.test(status)) continue;
    const at = /^\d+(?:\.\d+)?$/.test(value)
      ? Number(value) * (Number(value) < 1e12 ? 1000 : 1)
      : Date.parse(value);
    if (Number.isFinite(at) && at > now) resets.push(at);
  }
  return resets.length ? Math.max(...resets) : undefined;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const retries = options.maxRetries ?? 4;
  const waitLimit = options.maxDelayMs ?? 60_000;
  const maxRetries = Number.isFinite(retries) ? Math.max(0, Math.min(4, Math.floor(retries))) : 4;
  const maxDelay = Number.isFinite(waitLimit) ? Math.max(0, Math.min(60_000, waitLimit)) : 60_000;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number, signal?: AbortSignal) => wait(milliseconds, undefined, { signal }));

  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new DOMException('Request cancelled.', 'AbortError');
      }
      const details = apiErrorDetails(error);
      const retryable =
        details.status === 429 ||
        details.status === 529 ||
        details.type === 'rate_limit_error' ||
        details.type === 'overloaded_error';
      if (!retryable || options.shouldRetry?.(error) === false) throw new RequestError(error);
      if (attempt >= maxRetries) {
        throw new RequestError(error, ` Retry limit reached after ${maxRetries} retries.`);
      }
      const timestamp = now();
      const providerDelay =
        (retryAtFromHeaders(details.headers, timestamp) ?? timestamp) - timestamp;
      if (providerDelay > maxDelay) {
        throw new RequestError(
          error,
          ` Retry requires ${Math.ceil(providerDelay / 1000)}s, beyond the ${maxDelay / 1000}s wait limit.`,
        );
      }
      const backoff = Math.min(maxDelay, 1000 * 2 ** attempt * (0.75 + random() * 0.5));
      const delayMs = Math.ceil(Math.max(providerDelay, backoff));
      await options.onRetry?.({
        attempt: attempt + 1,
        maxRetries,
        delayMs,
        error: formatApiError(error),
        failure: new RequestError(error),
        rateLimits: details.headers,
      });
      await sleep(delayMs, options.signal);
    }
  }
}
