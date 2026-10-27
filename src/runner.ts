import { loadCredentialCandidates, type Credential } from './auth.js';
import { MeterStore, isAvailable, credentialState } from './metering.js';
import { classifyCredentialFailure } from './failures.js';
import { formatApiError } from './backoff.js';
import { runAPI } from './engines/api.js';
import { runOAuth } from './engines/oauth.js';
import type { EngineContext } from './engines/types.js';
import {
  appendTranscript,
  closePendingTools,
  portableContext,
  saveSession,
  switchEngine,
  type Session,
} from './session.js';
import { addUsage, emptyUsage, type UsageTotals } from './usage.js';
import type { AgentUI, Approve, ExitPlan, Settings } from './types.js';
import { redact } from './redact.js';

interface RunOptions {
  settings: Settings;
  session: Session;
  prompt: string;
  ui: AgentUI;
  approve: Approve;
  exitPlan?: ExitPlan;
  onRateLimit?: (info: unknown) => void;
  signal: AbortSignal;
  candidates?: Credential[];
  meter?: MeterStore;
  save?: (session: Session) => Promise<void>;
  engines?: { 'api-key': typeof runAPI; oauth: typeof runOAuth };
  ignoreCooldown?: boolean;
}

export async function runTask(options: RunOptions): Promise<UsageTotals> {
  const { settings, session, ui, signal } = options;
  const meter = options.meter ?? new MeterStore();
  const save = options.save ?? saveSession;
  const engines = options.engines ?? { 'api-key': runAPI, oauth: runOAuth };
  const candidates = (options.candidates ?? (await loadCredentialCandidates(settings))).filter(
    (credential) =>
      credential.enabled &&
      (!settings.pinnedCredential || credential.name === settings.pinnedCredential) &&
      (!settings.authRestriction || credential.type === settings.authRestriction),
  );
  if (!candidates.length)
    throw new Error(
      'No enabled credentials match. Run arncode creds add <name> or set ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN.',
    );
  closePendingTools(session);
  const userPrompt = redact(options.prompt);
  appendTranscript(session, 'user', userPrompt);
  session.messages.push({ role: 'user', content: userPrompt });
  session.model = settings.model;
  await save(session);
  const budget = { remaining: settings.maxTurns };
  let turnUsage = emptyUsage();
  let lastFailure: string | undefined;
  let tried = 0;
  for (const credential of candidates) {
    signal.throwIfAborted();
    const usage = credentialState(await meter.read(), credential);
    if (!options.ignoreCooldown && !isAvailable(usage)) {
      lastFailure = `${credential.name} is unavailable until ${usage?.resetAt}.`;
      continue;
    }
    if (budget.remaining <= 0)
      throw new Error(`Reached --max-turns (${settings.maxTurns}). Use --continue to resume.`);
    const changedEngine = session.engine !== credential.type;
    const previousCredential = session.credential;
    switchEngine(session, credential.type);
    session.credential = credential.name;
    const ctx: EngineContext = {
      settings: { ...settings, auth: credential.type },
      session,
      credential,
      prompt: userPrompt,
      ui,
      approve: options.approve,
      exitPlan: options.exitPlan,
      signal,
      budget,
      canFailover: !settings.pinnedCredential && candidates.length > 1,
      checkpoint: () => save(session),
      onRequest: (count) => meter.request(credential, count),
      onRetryError: (error) => meter.retry(credential, error),
      onRateLimit: options.onRateLimit,
      onUsage: async (usage) => {
        turnUsage = addUsage(turnUsage, usage);
        session.usage = addUsage(session.usage, usage);
        await meter.usage(credential, usage);
        await save(session);
      },
    };
    // The status bar names the active credential; mention it here only when it changes.
    if (tried > 0 || (previousCredential && previousCredential !== credential.name))
      ui.notice(`Using ${credential.name} (${credential.type}).`);
    try {
      if (credential.type === 'api-key') await engines['api-key'](ctx);
      else {
        const prompt =
          tried > 0 || changedEngine || session.transcript.length > 1
            ? portableContext(session)
            : userPrompt;
        await engines.oauth(ctx, prompt);
      }
      if (options.ignoreCooldown) await meter.reset(credential);
      await save(session);
      return turnUsage;
    } catch (error) {
      if (signal.aborted) throw error;
      await meter.failure(credential, error);
      const failure = classifyCredentialFailure(error);
      if (!failure) throw error;
      lastFailure = `${credential.name}: ${failure.reason} Available again at ${failure.resetAt}.`;
      tried++;
      if (settings.pinnedCredential) break;
      ui.notice(`${credential.name} is temporarily unavailable. Trying the next credential…`);
      await save(session);
    } finally {
      ui.idle();
      ui.endText();
    }
  }
  throw new Error(
    `${settings.pinnedCredential ? 'The pinned credential is unavailable.' : 'No healthy credentials remain.'} ${lastFailure ?? ''} Your session is saved; use --continue after a reset or add a credential.`,
  );
}

export function errorText(error: unknown): string {
  return formatApiError(error);
}
