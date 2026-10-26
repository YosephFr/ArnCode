import { apiErrorDetails, errorObject, retryAtFromHeaders } from './backoff.js';
import { redact } from './redact.js';

export interface CredentialFailure {
  kind: 'rate-limit' | 'billing' | 'authentication' | 'quota';
  reason: string;
  resetAt: string;
  retryable: true;
}

function resetTimestamp(value: unknown, now: number): number | undefined {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
        ? Number(value)
        : undefined;
  const parsed =
    numeric !== undefined
      ? numeric * (numeric < 1e12 ? 1000 : 1)
      : typeof value === 'string'
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(new Date(parsed).getTime()) && parsed > now ? parsed : undefined;
}

export function classifyCredentialFailure(
  error: unknown,
  now = Date.now(),
): CredentialFailure | undefined {
  const source = errorObject(error);
  const nested = errorObject(source.error);
  const inner = errorObject(nested.error);
  const details = apiErrorDetails(error);
  const info = errorObject(
    source.rate_limit_info ?? source.rateLimitInfo ?? nested.rate_limit_info,
  );
  const subtype = source.subtype;
  if (
    details.status === 529 ||
    details.type === 'overloaded_error' ||
    (typeof subtype === 'string' &&
      ['error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries'].includes(
        subtype,
      ))
  ) {
    return undefined;
  }
  const sdkLimitEvent = source.type === 'rate_limit_event';
  if (
    sdkLimitEvent &&
    (info.status !== 'rejected' || info.isUsingOverage === true || info.overageInUse === true)
  ) {
    return undefined;
  }

  const message =
    Array.isArray(source.errors) && source.errors.every((value) => typeof value === 'string')
      ? source.errors.join('\n')
      : details.message;
  let kind: CredentialFailure['kind'] | undefined;
  if (
    details.status === 401 ||
    ['authentication_error', 'authentication_failed', 'oauth_org_not_allowed'].includes(
      details.type ?? '',
    )
  ) {
    kind = 'authentication';
  } else if (sdkLimitEvent) {
    kind = info.errorCode === 'credits_required' ? 'billing' : 'quota';
  } else if (
    details.status === 402 ||
    details.type === 'billing_error' ||
    /\b(?:credit balance is too low|insufficient credits|out of credits|payment required)\b/i.test(
      message,
    )
  ) {
    kind = 'billing';
  } else if (
    /\byou have reached your specified (?:workspace )?api usage limits\b/i.test(message) ||
    /\b(?:you(?:['’]ve| have) hit your (?:weekly |usage )?limit|(?:five.hour|5.hour|weekly|seven.day) (?:usage )?limit (?:reached|exceeded))\b/i.test(
      message,
    ) ||
    details.type === 'quota_exceeded' ||
    details.type === 'insufficient_quota'
  ) {
    kind = 'quota';
  } else if (
    details.status === 429 ||
    details.type === 'rate_limit_error' ||
    details.type === 'rate_limit'
  ) {
    kind = 'rate-limit';
  }
  if (!kind) return undefined;

  const resetCandidates = [
    retryAtFromHeaders(details.headers, now),
    ...[source, nested, inner, info].flatMap((value) => [
      resetTimestamp(value.resetAt, now),
      resetTimestamp(value.resetsAt, now),
      resetTimestamp(value.reset_at, now),
    ]),
    info.overageStatus === 'rejected' ? resetTimestamp(info.overageResetsAt, now) : undefined,
  ].filter(
    (value): value is number => value !== undefined && Number.isFinite(new Date(value).getTime()),
  );
  const cooldown = kind === 'rate-limit' ? 60_000 : kind === 'quota' ? 300_000 : 900_000;
  const resetAt = new Date(
    resetCandidates.length ? Math.max(...resetCandidates) : now + cooldown,
  ).toISOString();
  const windows: Record<string, string> = {
    five_hour: '5-hour window',
    seven_day: 'weekly window',
    seven_day_opus: 'weekly Opus window',
    seven_day_sonnet: 'weekly Sonnet window',
    seven_day_overage_included: 'weekly extra usage window',
    overage: 'extra usage',
  };
  const window = typeof info.rateLimitType === 'string' ? windows[info.rateLimitType] : undefined;
  const reason = sdkLimitEvent
    ? `Subscription limit reached${window ? ` (${window})` : ''}.`
    : redact(message).slice(0, 500);
  return { kind, reason, resetAt, retryable: true };
}
