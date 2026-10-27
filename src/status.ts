import { modelFeatures } from './models.js';
import type { Session } from './session.js';
import { compactNumber } from './tui/text.js';
import type { Theme } from './tui/theme.js';
import type { PermissionMode, Settings } from './types.js';

export interface PlanWindow {
  /** Share of the window used, from 0 to 1. */
  used: number;
  resetsAt?: number;
  status?: string;
}

/** Subscription limits reported by the Agent SDK during the live session. */
export interface PlanUsage {
  fiveHour?: PlanWindow;
  weekly?: PlanWindow;
}

export const MODE_LABELS: Record<PermissionMode, string> = {
  full: 'full access',
  edits: 'auto-edit',
  ask: 'ask first',
  plan: 'plan',
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function planWindow(value: unknown): PlanWindow | undefined {
  const window = record(value);
  if (typeof window.utilization !== 'number') return undefined;
  return {
    used: window.utilization,
    ...(typeof window.resetsAt === 'number' ? { resetsAt: window.resetsAt } : {}),
    ...(typeof window.status === 'string' ? { status: window.status } : {}),
  };
}

/** Read the per-window utilization the SDK attaches to a rate-limit event. */
export function planUsageFrom(info: unknown, previous: PlanUsage = {}): PlanUsage {
  const source = record(info);
  const windows = record(source.unifiedWindows);
  const next: PlanUsage = { ...previous };
  const fiveHour = planWindow(windows.five_hour);
  const weekly = planWindow(windows.seven_day);
  if (fiveHour) next.fiveHour = fiveHour;
  if (weekly) next.weekly = weekly;
  // Older events carry only the window that triggered them.
  const single = planWindow(source);
  if (single && source.rateLimitType === 'five_hour' && !fiveHour) next.fiveHour = single;
  if (single && source.rateLimitType === 'seven_day' && !weekly) next.weekly = single;
  return next;
}

/** Tokens the context can hold before the conversation is summarized or the window is full. */
export function contextBudget(settings: Settings, session: Session): number {
  const window = modelFeatures(settings.model).contextWindow;
  return session.engine === 'api-key' && modelFeatures(settings.model).compaction
    ? Math.min(settings.compactAt, Math.floor(window * 0.85))
    : window;
}

/** Stored plan limits without the windows that have reset since they were recorded. */
export function currentPlanUsage(plan: PlanUsage | undefined, now = Date.now()): PlanUsage {
  const current = (window?: PlanWindow) =>
    window && (!window.resetsAt || window.resetsAt * 1000 > now) ? window : undefined;
  const fiveHour = current(plan?.fiveHour);
  const weekly = current(plan?.weekly);
  return { ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}) };
}

export function statusLine(
  settings: Settings,
  session: Session,
  plan: PlanUsage,
  theme: Theme,
): string {
  const parts = [
    `${modelFeatures(settings.model).label}${settings.fast ? ' fast' : ''}`,
    settings.effort,
    MODE_LABELS[settings.permissionMode],
  ];
  const tokens = session.contextTokens ?? 0;
  if (tokens) {
    const share = Math.min(100, Math.round((tokens / contextBudget(settings, session)) * 100));
    const text = `ctx ${share}%`;
    parts.push(share >= 85 ? theme.warning(text) : text);
  }
  for (const [label, window] of [
    ['5h', plan.fiveHour],
    ['wk', plan.weekly],
  ] as const) {
    if (!window) continue;
    const text = `${label} ${Math.round(window.used * 100)}%`;
    parts.push(
      window.status === 'rejected'
        ? theme.error(text)
        : window.status === 'allowed_warning' || window.used >= 0.8
          ? theme.warning(text)
          : text,
    );
  }
  if (session.credential) parts.push(session.credential);
  const cost = session.usage.costUsd;
  if (cost >= 0.005) parts.push(`$${cost.toFixed(2)}`);
  else if (session.usage.requests && session.usage.unpricedRequests >= session.usage.requests)
    parts.push(`${compactNumber(session.usage.outputTokens)} out`);
  return parts.join(' · ');
}
