import type { Credential } from '../auth.js';
import type { Session } from '../session.js';
import type { UsageTotals } from '../usage.js';
import type { AgentUI, Approve, Settings } from '../types.js';

export interface EngineContext {
  settings: Settings;
  session: Session;
  credential: Credential;
  /** The user's prompt for this turn, when the turn started from one. */
  prompt?: string;
  ui: AgentUI;
  approve: Approve;
  signal: AbortSignal;
  budget: { remaining: number };
  canFailover: boolean;
  checkpoint(): Promise<void>;
  onUsage(usage: UsageTotals): Promise<void>;
  onRequest(count?: number): Promise<void>;
  onRetryError?(error: unknown): Promise<void>;
}
