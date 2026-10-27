import { loadCredentialCandidates, type Credential } from './auth.js';
import { MeterStore, isAvailable, credentialState } from './metering.js';
import { classifyCredentialFailure } from './failures.js';
import { formatApiError } from './backoff.js';
import { compactConversation, runAPI } from './engines/api.js';
import { compactOAuth, runOAuth } from './engines/oauth.js';
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
import { finishCheckpoint, recordChange, startCheckpoint } from './checkpoints.js';
import { Hooks } from './hooks.js';
import { planUsageFrom } from './status.js';

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

// Sessions whose SessionStart hooks already ran in this process.
const startedSessions = new Set<string>();

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
  const hooks = new Hooks(settings.hooks, { cwd: settings.cwd, sessionId: () => session.id });
  let promptText = options.prompt;
  if (hooks.has('SessionStart') && !startedSessions.has(session.id)) {
    startedSessions.add(session.id);
    const source = session.transcript.length ? 'resume' : 'startup';
    const outcome = await hooks.run('SessionStart', { source }, { signal });
    if (outcome.context) promptText = `${outcome.context}\n\n${promptText}`;
  }
  if (hooks.has('UserPromptSubmit')) {
    const outcome = await hooks.run('UserPromptSubmit', { prompt: options.prompt }, { signal });
    if (outcome.blocked) throw new Error(`A hook blocked this request: ${outcome.blocked}`);
    if (outcome.context) promptText += `\n\n${outcome.context}`;
  }
  closePendingTools(session);
  if (session.notes?.length) {
    promptText = `<system-reminder>${session.notes.join('\n')}</system-reminder>\n\n${promptText}`;
    delete session.notes;
  }
  const userPrompt = redact(promptText);
  appendTranscript(session, 'user', userPrompt);
  session.messages.push({ role: 'user', content: userPrompt });
  session.model = settings.model;
  await save(session);
  startCheckpoint(session, options.prompt);
  try {
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
        hooks,
        exitPlan: options.exitPlan,
        signal,
        budget,
        canFailover: !settings.pinnedCredential && candidates.length > 1,
        checkpoint: () => save(session),
        onRequest: (count) => meter.request(credential, count),
        onRetryError: (error) => meter.retry(credential, error),
        recordChange: (file) => recordChange(session, file),
        onRateLimit: (info) => {
          options.onRateLimit?.(info);
          void meter.plan(credential, planUsageFrom(info)).catch(() => undefined);
        },
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
          await engines.oauth(ctx, prompt, { latest: userPrompt });
        }
        // A Stop hook that exits with code 2 sends the agent back to work, a bounded number of times.
        for (let round = 0; round < 3 && hooks.has('Stop'); round++) {
          const outcome = await hooks.run('Stop', { stop_hook_active: round > 0 }, { signal });
          if (!outcome.blocked) break;
          const request = redact(`A hook asked to continue: ${outcome.blocked}`);
          ui.notice(request);
          appendTranscript(session, 'user', request);
          session.messages.push({ role: 'user', content: request });
          if (credential.type === 'api-key') await engines['api-key'](ctx);
          else await engines.oauth(ctx, portableContext(session), { latest: request });
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
  } finally {
    // A request that changed files can be undone with /undo.
    await finishCheckpoint(session).catch(() => 0);
  }
}

/**
 * Summarize the conversation with the first available credential, preferring the engine that
 * holds the conversation. Returns false when there was nothing to summarize.
 */
export async function compactSession(options: Omit<RunOptions, 'prompt'>): Promise<boolean> {
  const { settings, session, ui, signal } = options;
  const meter = options.meter ?? new MeterStore();
  const save = options.save ?? saveSession;
  const candidates = (options.candidates ?? (await loadCredentialCandidates(settings)))
    .filter(
      (credential) =>
        credential.enabled &&
        (!settings.pinnedCredential || credential.name === settings.pinnedCredential) &&
        (!settings.authRestriction || credential.type === settings.authRestriction),
    )
    .sort((a, b) => Number(b.type === session.engine) - Number(a.type === session.engine));
  if (!session.messages.length && !session.transcript.length) return false;
  for (const credential of candidates) {
    signal.throwIfAborted();
    if (!isAvailable(credentialState(await meter.read(), credential))) continue;
    switchEngine(session, credential.type);
    session.credential = credential.name;
    const ctx: EngineContext = {
      settings: { ...settings, auth: credential.type },
      session,
      credential,
      ui,
      approve: async () => ({ allowed: false, reason: 'Tools are off while summarizing.' }),
      signal,
      budget: { remaining: 3 },
      canFailover: candidates.length > 1,
      checkpoint: () => save(session),
      onRequest: (count) => meter.request(credential, count),
      onRetryError: (error) => meter.retry(credential, error),
      onUsage: async (usage) => {
        session.usage = addUsage(session.usage, usage);
        await meter.usage(credential, usage);
        await save(session);
      },
    };
    try {
      const done =
        credential.type === 'api-key' ? await compactConversation(ctx) : await compactOAuth(ctx);
      await save(session);
      return done;
    } catch (error) {
      if (signal.aborted) throw error;
      await meter.failure(credential, error);
      if (!classifyCredentialFailure(error)) throw error;
    } finally {
      ui.idle();
      ui.endText();
    }
  }
  throw new Error('No credential is available to summarize the conversation right now.');
}

export function errorText(error: unknown): string {
  return formatApiError(error);
}
