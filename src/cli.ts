#!/usr/bin/env node
import { Command, Option } from 'commander';
import fg from 'fast-glob';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { credentialCommands, integer } from './commands/credentials.js';
import { addProfile, loadCredentialCandidates } from './auth.js';
import { resolveConfiguration } from './config.js';
import { loadHistory, saveHistory } from './history.js';
import { TerminalInput, readStdin } from './input.js';
import { PERMISSION_MODES, PermissionManager } from './permissions.js';
import { registerEnvironmentSecrets, redact } from './redact.js';
import { newSession, latestSession, loadSession, saveSession } from './session.js';
import { errorText, runTask } from './runner.js';
import { SLASH_COMMANDS, slashCommand } from './repl.js';
import { MODE_LABELS, planUsageFrom, statusLine, type PlanUsage } from './status.js';
import { InteractiveApp, type Suggestion } from './tui/app.js';
import { themeFor } from './tui/theme.js';
import { TerminalUI, displayName, toolSummary } from './ui.js';
import { formatUsage } from './usage.js';
import { usageDifference } from './engines/oauth.js';
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
  resume?: string;
  continue?: boolean;
}

const ui = new TerminalUI();
registerEnvironmentSecrets(process.env);
const program = new Command()
  .name('arncode')
  .description('A coding agent with a multi-account credential bank and automatic failover')
  .version('0.1.0')
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
  .option('--model <id>', 'Model (default: claude-opus-5-5)')
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
  .option('-r, --resume <id>', 'Resume a saved session')
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
  const input = new TerminalInput();
  const oneShot = options.print !== undefined || !input.interactive;
  const piped = !process.stdin.isTTY ? await readStdin() : '';
  const prompt = [typeof options.print === 'string' ? options.print : '', piped]
    .filter(Boolean)
    .join('\n\n');
  if (oneShot && !prompt.trim()) {
    program.outputHelp();
    return;
  }
  if (!(await loadCredentialCandidates(settings)).length && input.interactive) {
    try {
      const preferred = settings.authRestriction ?? 'api-key';
      const typeAnswer =
        settings.authRestriction ??
        (await input.question(`Credential type [api-key/oauth] (${preferred}): `));
      if (typeAnswer === undefined) return;
      const type = typeAnswer.trim() || preferred;
      if (type !== 'api-key' && type !== 'oauth') throw new Error('Choose api-key or oauth.');
      const nameAnswer = await input.question('Credential name (main): ');
      if (nameAnswer === undefined) return;
      const name = nameAnswer.trim() || 'main';
      const secret = await input.secret(
        type === 'oauth' ? 'Token from claude setup-token: ' : 'API key: ',
      );
      await addProfile(name, type, secret);
      ui.notice(`Added ${name}.`);
    } finally {
      input.close();
    }
  }
  let session = options.resume
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

  const theme = themeFor(process.stderr);
  // Assigned once the session is ready; earlier callbacks see undefined and fall back.
  let app: InteractiveApp | undefined = undefined;
  let previousMode: PermissionMode =
    settings.permissionMode === 'plan' ? 'full' : settings.permissionMode;
  const permissions = new PermissionManager(
    settings.permissionMode,
    input.interactive,
    async (name, args, signal) => {
      if (app) {
        const tool = displayName(name);
        const answer = await app.select(
          `Allow ${toolSummary(tool, args)}?`,
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
    if (next === 'plan' && settings.permissionMode !== 'plan')
      previousMode = settings.permissionMode;
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
      Math.max(0, options.indexOf(previousMode)),
      signal,
    );
    if (!choice || choice === 'plan') return { approved: false };
    setMode(choice);
    return { approved: true, mode: choice };
  };
  let plan: PlanUsage = {};
  const state = { settings, session, permissions, ui, setMode };
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

  const execute = async (text: string) => {
    active = new AbortController();
    const before = { ...state.session.usage };
    const started = Date.now();
    let failed = false;
    try {
      await runTask({
        settings,
        session: state.session,
        prompt: text,
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
        ui.turnEnd(Date.now() - started, cost, failed);
      } else {
        ui.notice(`Turn: ${formatUsage(turn)}`);
        if (oneShot) ui.notice(`Session: ${formatUsage(state.session.usage)}`);
      }
    }
  };

  if (oneShot) {
    ui.notice(
      `ArnCode · ${MODE_LABELS[settings.permissionMode]}\n${settings.cwd}\nSession: ${state.session.id}`,
    );
    try {
      await execute(prompt);
    } finally {
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
    files = await fg('**/*', {
      cwd: settings.cwd,
      dot: true,
      onlyFiles: true,
      deep: 12,
      followSymbolicLinks: false,
      suppressErrors: true,
      ignore: ['**/.git/**', '**/node_modules/**', '**/dist/**', '**/build/**', '**/.env*'],
    })
      .then((found) => found.slice(0, 20_000))
      .catch(() => files);
  };
  void indexFiles();
  const suggest = (text: string, cursor: number) => {
    const before = text.slice(0, cursor);
    if (before.startsWith('/') && !before.includes(' ')) {
      const items: Suggestion[] = SLASH_COMMANDS.filter((command) =>
        command.name.startsWith(before),
      ).map((command) => ({
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
  if (resumed) {
    for (const entry of state.session.transcript.filter((item) => item.role !== 'tool').slice(-2)) {
      const lines = entry.text.split('\n').slice(0, 3).join('\n');
      if (entry.role === 'user') ui.user(lines);
      else app.print(`${theme.muted(redact(lines))}\n`);
    }
  }
  try {
    while (!closing) {
      const line = await app.nextPrompt();
      if (line === undefined) break;
      const trimmed = line.trim();
      if (trimmed.startsWith('/')) {
        try {
          if ((await slashCommand(trimmed, state)) === 'exit') break;
        } catch (error) {
          ui.notice(errorText(error));
        }
        app.render();
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

await program.parseAsync().catch((error: unknown) => {
  ui.notice(errorText(error));
  process.exitCode = 1;
});
