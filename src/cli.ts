#!/usr/bin/env node
import { Command, Option } from 'commander';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { credentialCommands, integer } from './commands/credentials.js';
import { addProfile, detectCredentialType, loadCredentialCandidates } from './auth.js';
import { resolveConfiguration } from './config.js';
import { loadHistory, saveHistory } from './history.js';
import { TerminalInput, readStdin } from './input.js';
import { PERMISSION_MODES, PermissionManager } from './permissions.js';
import { registerEnvironmentSecrets, redact } from './redact.js';
import { newSession, latestSession, listSessions, loadSession, saveSession } from './session.js';
import { compactSession, errorText, runTask } from './runner.js';
import { SLASH_COMMANDS, slashCommand, type ReplState } from './repl.js';
import { loadCustomCommands } from './commands/custom.js';
import { closeMcp } from './mcp.js';
import {
  MODE_LABELS,
  currentPlanUsage,
  planUsageFrom,
  statusLine,
  type PlanUsage,
} from './status.js';
import { InteractiveApp, type Suggestion } from './tui/app.js';
import { themeFor } from './tui/theme.js';
import { duration } from './tui/text.js';
import { TerminalUI, displayName, setDisplayRoot, toolSummary } from './ui.js';
import { formatUsage } from './usage.js';
import { MeterStore } from './metering.js';
import { proposedChange } from './tools/files.js';
import { projectFiles } from './tools/search.js';
import { killAllJobs, stopAllJobs } from './tools/background.js';
import { usageDifference } from './engines/oauth.js';
import { JsonUI, type OutputFormat } from './json-output.js';
import type { ExitPlan, PermissionMode, Settings } from './types.js';

interface CliOptions {
  print?: string | boolean;
  cwd?: string;
  auth?: Settings['auth'];
  model?: string;
  credential?: string;
  profile?: string;
  baseUrl?: string;
  effort?: Settings['effort'];
  fast?: boolean;
  maxTokens?: number;
  maxTurns?: number;
  permissionMode?: PermissionMode;
  plan?: boolean;
  dangerouslySkipPermissions?: boolean;
  yolo?: boolean;
  safe?: boolean;
  ask?: boolean;
  resume?: string | boolean;
  continue?: boolean;
  outputFormat?: OutputFormat;
}

const ui = new TerminalUI();
registerEnvironmentSecrets(process.env);
// Background commands never outlive ArnCode.
process.on('exit', killAllJobs);
const program = new Command()
  .name('arncode')
  .description('A coding agent with a multi-account credential bank and automatic failover')
  .version('0.1.0', '-V, --version', 'Show the version')
  .helpOption('-h, --help', 'Show help')
  .helpCommand('help [command]', 'Show help for a command')
  .option('-p, --print [prompt]', 'Run one task, with optional input from stdin')
  .option('--cwd <directory>', 'Project directory')
  .addOption(
    new Option('--auth <type>', 'Restrict the credential bank to one type').choices([
      'api-key',
      'oauth',
    ]),
  )
  .option('--credential <name>', 'Pin a credential and disable failover')
  .option('--profile <name>', 'Alias for --credential')
  .option('--model <id>', 'Model ID, or opus, sonnet, haiku, or fable (default: opus)')
  .option('--base-url <url>', 'Messages API endpoint')
  .option('--fast', 'Enable fast mode')
  .option('--no-fast', 'Disable fast mode')
  .addOption(
    new Option('--effort <level>', 'Reasoning effort (default: medium)').choices([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]),
  )
  .option(
    '--max-tokens <number>',
    'Maximum output tokens per API request (default: 64000)',
    integer,
  )
  .option('--max-turns <number>', 'Maximum agent turns per task (default: 80)', integer)
  .addOption(
    new Option('--permission-mode <mode>', 'Permission mode (default: full)').choices(
      PERMISSION_MODES,
    ),
  )
  .option('--plan', 'Start in plan mode: explore and propose a plan before changing anything')
  .option('--dangerously-skip-permissions', 'Allow all tool actions without asking')
  .option('--yolo', 'Alias for --dangerously-skip-permissions')
  .option('--safe', 'Ask before writes, edits, and shell commands')
  .option('--ask', 'Alias for --safe')
  .addOption(
    new Option('--output-format <format>', 'Output with -p (default: text)').choices([
      'text',
      'json',
      'stream-json',
    ]),
  )
  .option('-r, --resume [id]', 'Resume a saved session; choose one when the ID is omitted')
  .option('-c, --continue', 'Resume the latest session in this project')
  .showHelpAfterError()
  .configureOutput({
    writeErr: (value) => process.stderr.write(redact(value)),
    writeOut: (value) => process.stdout.write(redact(value)),
  });

credentialCommands(program, ui);

function requestedMode(options: CliOptions): PermissionMode | undefined {
  if (options.permissionMode) return options.permissionMode;
  if (options.plan) return 'plan';
  if (options.safe || options.ask) return 'ask';
  if (options.yolo || options.dangerouslySkipPermissions) return 'full';
  return undefined;
}

function shortPath(directory: string): string {
  const home = homedir();
  return directory === home || directory.startsWith(`${home}/`)
    ? `~${directory.slice(home.length)}`
    : directory;
}

program.action(async (options: CliOptions) => {
  if (options.resume && options.continue) throw new Error('Choose --resume or --continue.');
  if (options.credential && options.profile && options.credential !== options.profile)
    throw new Error('--credential and --profile must name the same credential.');
  const mode = requestedMode(options);
  const flags: Partial<Settings> = {
    cwd: options.cwd,
    auth: options.auth,
    model: options.model,
    pinnedCredential: options.credential ?? options.profile,
    baseUrl: options.baseUrl,
    effort: options.effort,
    maxTokens: options.maxTokens,
    maxTurns: options.maxTurns,
    ...(program.getOptionValueSource('fast') === 'cli' ? { fast: options.fast } : {}),
    ...(mode ? { permissionMode: mode } : {}),
  };
  const settings = await resolveConfiguration(flags);
  settings.cwd = await realpath(settings.cwd).catch(() => {
    throw new Error(`Project directory does not exist: ${settings.cwd}`);
  });
  if (!(await stat(settings.cwd)).isDirectory()) throw new Error('--cwd must be a directory.');
  setDisplayRoot(settings.cwd);
  const input = new TerminalInput();
  const oneShot = options.print !== undefined || !input.interactive;
  let piped = '';
  if (!process.stdin.isTTY) {
    // A prompt on the command line makes stdin optional, so an idle pipe must not block the run.
    const stdin = await readStdin(typeof options.print === 'string' ? { waitMs: 3000 } : {});
    if (stdin.skipped)
      ui.notice('No input arrived on stdin within 3 seconds, so the run continues without it.');
    piped = stdin.text;
  }
  const prompt = [typeof options.print === 'string' ? options.print : '', piped]
    .filter(Boolean)
    .join('\n\n');
  if (oneShot && !prompt.trim()) {
    program.outputHelp();
    return;
  }
  if (!(await loadCredentialCandidates(settings)).length && input.interactive) {
    try {
      // The token says what it is, so the only other question is its name.
      const secret = await input.secret(
        'Paste an Anthropic API key, or a token from claude setup-token: ',
      );
      let type = settings.authRestriction ?? detectCredentialType(secret);
      if (!type) {
        const answer = await input.question(
          'Is it an API key or an OAuth token? [api-key/oauth] (oauth): ',
        );
        if (answer === undefined) return;
        type = (answer.trim() || 'oauth') as Settings['auth'];
        if (type !== 'api-key' && type !== 'oauth') throw new Error('Choose api-key or oauth.');
      }
      const nameAnswer = await input.question('Name it (main): ');
      if (nameAnswer === undefined) return;
      const name = nameAnswer.trim() || 'main';
      await addProfile(name, type, secret);
      ui.notice(`Added ${name} (${type}).`);
    } finally {
      input.close();
    }
  }
  if (options.resume === true && oneShot)
    throw new Error('Choose a session with --resume <id>, or use --continue.');
  let session =
    typeof options.resume === 'string'
      ? await loadSession(options.resume)
      : options.continue
        ? await latestSession(settings.cwd)
        : undefined;
  if (options.continue && !session)
    throw new Error('No previous session in this project. Start with arncode.');
  if (session && session.cwd !== settings.cwd)
    throw new Error(`This session belongs to ${session.cwd}. Resume with --cwd pointing there.`);
  const resumed = Boolean(session);
  session ??= newSession(settings);

  let theme = themeFor(process.stderr, settings.theme);
  ui.setTheme(theme);
  // Assigned once the session is ready; earlier callbacks see undefined and fall back.
  let app: InteractiveApp | undefined = undefined;
  // The mode in effect when the user last pressed Enter; approving a plan offers it first, so
  // modes passed through with Shift+Tab on the way to plan mode do not count.
  let workingMode: PermissionMode =
    settings.permissionMode === 'plan' ? 'full' : settings.permissionMode;
  const permissions = new PermissionManager(
    settings.permissionMode,
    input.interactive,
    async (name, args, signal) => {
      if (app) {
        const tool = displayName(name);
        // The tool line is already on screen; show what an edit would change, then ask briefly.
        const change = await proposedChange(settings.cwd, name, args).catch(() => undefined);
        if (change) ui.diff(change.file, change.before, change.after, { proposed: true });
        const answer = await app.select(
          ['bash', 'Bash'].includes(name)
            ? 'Run this command?'
            : change
              ? 'Make this change?'
              : `Allow ${toolSummary(tool, args)}?`,
          [
            { label: 'Yes', value: 'y', key: 'y' },
            {
              label: `Yes, and allow ${tool} for the rest of this session`,
              value: 'always',
              key: 'a',
            },
            { label: 'No', value: 'n', key: 'n' },
          ],
          0,
          signal,
        );
        return answer ?? 'n';
      }
      ui.idle();
      ui.endText();
      return (
        (await input.question(`Allow ${toolSummary(name, args)}? [y/n/always] `, signal)) ?? 'n'
      );
    },
    settings.cwd,
  );
  const setMode = (next: PermissionMode) => {
    settings.permissionMode = next;
    permissions.setMode(next);
    app?.render();
  };
  const exitPlan: ExitPlan = async (plan, signal) => {
    if (permissions.mode !== 'plan' || !app) return { approved: true, mode: permissions.mode };
    ui.plan(plan);
    const options: PermissionMode[] = ['full', 'edits', 'ask'];
    const choice = await app.select(
      'Start working on this plan?',
      [
        { label: 'Yes, with full access', value: 'full' as PermissionMode, key: 'y' },
        { label: 'Yes, approving edits automatically', value: 'edits' as PermissionMode },
        { label: 'Yes, asking before each change', value: 'ask' as PermissionMode },
        { label: 'No, keep planning', value: 'plan' as PermissionMode, key: 'n' },
      ],
      Math.max(0, options.indexOf(workingMode)),
      signal,
    );
    if (!choice || choice === 'plan') return { approved: false };
    setMode(choice);
    return { approved: true, mode: choice };
  };
  // Last known plan limits for the account in use, until the first response refreshes them.
  const knownCredential = session.credential ?? settings.pinnedCredential;
  let plan: PlanUsage = knownCredential
    ? currentPlanUsage(
        (await new MeterStore().read().catch(() => undefined))?.credentials[knownCredential]?.plan,
      )
    : {};
  const setTheme = (preference: NonNullable<typeof settings.theme>) => {
    theme = themeFor(process.stderr, preference);
    app?.setTheme(theme);
    ui.setTheme(theme);
    return theme;
  };
  const state: ReplState = { settings, session, permissions, ui, setMode, setTheme };
  let active: AbortController | undefined;
  let closing = false;
  const interrupt = () => {
    if (active) {
      active.abort();
      app?.flash('Interrupting…');
      ui.idle();
    } else {
      closing = true;
      app?.stop();
      input.close();
    }
  };
  const terminate = () => {
    closing = true;
    active?.abort();
    app?.stop();
    input.close();
  };
  input.onInterrupt = interrupt;
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);

  const execute = async (text: string, typed = text) => {
    active = new AbortController();
    const before = { ...state.session.usage };
    const started = Date.now();
    let failed = false;
    try {
      await runTask({
        settings,
        session: state.session,
        prompt: text,
        mentions: typed,
        ui,
        signal: active.signal,
        approve: permissions.approve,
        ...(app ? { exitPlan } : {}),
        onRateLimit: (info) => {
          plan = planUsageFrom(info, plan);
          app?.render();
        },
      });
    } catch (error) {
      failed = true;
      if (active.signal.aborted) {
        ui.notice('Interrupted. The session is saved.');
        if (oneShot) process.exitCode = 130;
      } else {
        ui.notice(errorText(error));
        if (oneShot) process.exitCode = 1;
      }
    } finally {
      active = undefined;
      app?.setBusy(undefined);
      ui.idle();
      ui.endText();
      await saveSession(state.session);
      const turn = usageDifference(state.session.usage, before);
      turn.requests = state.session.usage.requests - before.requests;
      turn.fastRequests = state.session.usage.fastRequests - before.fastRequests;
      if (app) {
        const cost =
          turn.requests && turn.unpricedRequests < turn.requests && turn.costUsd >= 0.005
            ? `$${turn.costUsd.toFixed(2)}`
            : '';
        const checkpoint = state.session.checkpoints?.at(-1);
        const changed =
          checkpoint && Date.parse(checkpoint.startedAt) >= started ? checkpoint.files.length : 0;
        ui.turnEnd(Date.now() - started, cost, failed, changed);
      } else {
        ui.notice(`Turn: ${formatUsage(turn)}`);
        if (oneShot) ui.notice(`Session: ${formatUsage(state.session.usage)}`);
      }
    }
  };

  if (oneShot && options.outputFormat && options.outputFormat !== 'text') {
    const json = new JsonUI(options.outputFormat);
    json.init(state.session, settings);
    active = new AbortController();
    const before = { ...state.session.usage };
    const started = Date.now();
    let error: string | undefined;
    try {
      await runTask({
        settings,
        session: state.session,
        prompt,
        mentions: typeof options.print === 'string' ? options.print : '',
        ui: json,
        signal: active.signal,
        approve: permissions.approve,
      });
    } catch (failure) {
      if (active.signal.aborted) process.exitCode = 130;
      else {
        error = errorText(failure);
        process.exitCode = 1;
      }
    } finally {
      const interrupted = active.signal.aborted;
      active = undefined;
      await saveSession(state.session);
      const turn = usageDifference(state.session.usage, before);
      turn.requests = state.session.usage.requests - before.requests;
      json.result(state.session, turn, { durationMs: Date.now() - started, error, interrupted });
      await stopAllJobs();
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    }
    return;
  }

  if (oneShot) {
    ui.notice(
      `ArnCode · ${MODE_LABELS[settings.permissionMode]}\n${settings.cwd}\nSession: ${state.session.id}`,
    );
    try {
      await execute(prompt, typeof options.print === 'string' ? options.print : '');
    } finally {
      await stopAllJobs();
      input.close();
      process.stdin.pause();
      ui.idle();
      ui.endText();
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    }
    return;
  }

  // Files for @ completion; refreshed after each turn without blocking input.
  let files: string[] = [];
  const indexFiles = async () => {
    files = await projectFiles(settings.cwd, settings.protectedPaths).catch(() => files);
  };
  void indexFiles();
  const suggest = (text: string, cursor: number) => {
    const before = text.slice(0, cursor);
    if (before.startsWith('/') && !before.includes(' ')) {
      const items: Suggestion[] = [...SLASH_COMMANDS, ...custom]
        .filter((command) => command.name.startsWith(before))
        .map((command) => ({
          value: `${command.name} `,
          label: command.name,
          hint: command.description,
        }));
      return { start: 0, items };
    }
    const mention = /(?:^|\s)@([^\s]*)$/.exec(before);
    if (!mention) return undefined;
    const query = mention[1]!.toLowerCase();
    const items = files
      .filter((file) => file.toLowerCase().includes(query))
      .sort(
        (a, b) =>
          Number(!a.toLowerCase().startsWith(query)) - Number(!b.toLowerCase().startsWith(query)) ||
          a.length - b.length,
      )
      .slice(0, 6)
      .map((file) => ({ value: `@${file} `, label: file }));
    return { start: cursor - mention[1]!.length - 1, items };
  };

  const custom = await loadCustomCommands(
    settings.cwd,
    SLASH_COMMANDS.map((command) => command.name),
  ).catch(() => []);
  const replay = () => {
    for (const entry of state.session.transcript.filter((item) => item.role !== 'tool').slice(-2)) {
      const lines = entry.text.split('\n');
      const limit = entry.role === 'user' ? 3 : 12;
      ui.history(
        entry.role === 'user' ? 'user' : 'assistant',
        `${lines.slice(0, limit).join('\n')}${lines.length > limit ? '\n…' : ''}`,
      );
    }
  };
  Object.assign(state, {
    custom,
    plan: () => plan,
    select: <T>(question: string, choices: { label: string; value: T }[], initial = 0) =>
      app!.select(question, choices, initial),
    compact: async () => {
      active = new AbortController();
      const before = state.session.contextTokens;
      try {
        const done = await compactSession({
          settings,
          session: state.session,
          ui,
          signal: active.signal,
          approve: permissions.approve,
        });
        await saveSession(state.session);
        ui.notice(
          done
            ? `Conversation summarized${before ? ` from about ${before.toLocaleString()} tokens` : ''}.`
            : 'There is nothing to summarize yet.',
        );
      } catch (error) {
        ui.notice(active.signal.aborted ? 'Stopped summarizing.' : errorText(error));
      } finally {
        active = undefined;
        app?.setBusy(undefined);
      }
    },
    resume: async () => {
      const sessions = (await listSessions(settings.cwd)).filter(
        (item) => item.id !== state.session.id,
      );
      if (!sessions.length) {
        ui.notice('No earlier conversations in this project.');
        return;
      }
      const id = await app!.select(
        'Continue which conversation?',
        sessions.map((item) => ({
          label: item.title,
          value: item.id,
          hint: `${duration(Date.now() - Date.parse(item.updatedAt))} ago · ${item.prompts} request${item.prompts === 1 ? '' : 's'}`,
        })),
      );
      if (!id) return;
      state.session = await loadSession(id);
      replay();
    },
  });
  app = new InteractiveApp({
    stdin: process.stdin,
    ui: process.stderr,
    content: process.stdout,
    theme,
    history: await loadHistory(settings.cwd).catch(() => []),
    placeholder: 'What should we build or fix?',
    status: () => statusLine(settings, state.session, plan, theme),
    suggest,
    onInterrupt: interrupt,
    onCycleMode: () => {
      const next =
        PERMISSION_MODES[
          (PERMISSION_MODES.indexOf(settings.permissionMode) + 1) % PERMISSION_MODES.length
        ]!;
      setMode(next);
      app?.flash(`${MODE_LABELS[next]} mode`);
    },
    onExit: () => {
      closing = true;
      app?.stop();
    },
  });
  ui.attach(app, theme);
  const restore = () => app?.stop();
  process.on('exit', restore);
  app.start();
  const location = shortPath(settings.cwd);
  const room = Math.max(12, app.screen.width - 10);
  app.print(
    `${theme.strong('ArnCode')} ${theme.muted(location.length > room ? `…${location.slice(1 - room)}` : location)}\n`,
  );
  if (resumed) replay();
  else if (options.resume === true) await state.resume?.();
  try {
    while (!closing) {
      const line = await app.nextPrompt();
      if (line === undefined) break;
      if (settings.permissionMode !== 'plan') workingMode = settings.permissionMode;
      const trimmed = line.trim();
      if (trimmed.startsWith('/')) {
        let result;
        try {
          result = await slashCommand(trimmed, state);
        } catch (error) {
          ui.notice(errorText(error));
        }
        if (result === 'exit') break;
        app.render();
        if (typeof result !== 'object') continue;
        ui.user(trimmed);
        await execute(result.prompt);
        void indexFiles();
        continue;
      }
      void saveHistory(settings.cwd, line).catch(() => undefined);
      ui.user(line);
      await execute(line);
      void indexFiles();
    }
  } finally {
    app.stop();
    ui.detach();
    await stopAllJobs();
    process.off('exit', restore);
    input.close();
    process.stdin.pause();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
});

for (const stream of [process.stdout, process.stderr])
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });

await program
  .parseAsync()
  .catch((error: unknown) => {
    ui.notice(errorText(error));
    process.exitCode = 1;
  })
  .finally(() => closeMcp());
