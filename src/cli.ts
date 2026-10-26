#!/usr/bin/env node
import { Command, Option } from 'commander';
import { realpath, stat } from 'node:fs/promises';
import { credentialCommands, integer } from './commands/credentials.js';
import { addProfile, loadCredentialCandidates } from './auth.js';
import { resolveConfiguration } from './config.js';
import { TerminalInput, readStdin } from './input.js';
import { PermissionManager } from './permissions.js';
import { registerEnvironmentSecrets, redact } from './redact.js';
import { newSession, latestSession, loadSession, saveSession } from './session.js';
import { errorText, runTask } from './runner.js';
import { slashCommand } from './repl.js';
import { TerminalUI, toolSummary } from './ui.js';
import { formatUsage } from './usage.js';
import { usageDifference } from './engines/oauth.js';
import type { Settings } from './types.js';

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

program.action(async (options: CliOptions) => {
  if (options.resume && options.continue) throw new Error('Choose --resume or --continue.');
  if (options.credential && options.profile && options.credential !== options.profile)
    throw new Error('--credential and --profile must name the same credential.');
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
    ...(options.safe || options.ask
      ? { permissionMode: 'ask' }
      : options.yolo || options.dangerouslySkipPermissions
        ? { permissionMode: 'full' }
        : {}),
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
  session ??= newSession(settings);
  const permissions = new PermissionManager(
    settings.permissionMode,
    input.interactive,
    async (name, args, signal) => {
      ui.idle();
      ui.endText();
      return (
        (await input.question(`Allow ${toolSummary(name, args)}? [y/n/always] `, signal)) ?? 'n'
      );
    },
  );
  const state = { settings, session, permissions, ui };
  let active: AbortController | undefined;
  let closing = false;
  const interrupt = () => {
    if (active) {
      active.abort();
      ui.idle();
    } else {
      closing = true;
      input.close();
    }
  };
  const terminate = () => {
    closing = true;
    active?.abort();
    input.close();
  };
  input.onInterrupt = interrupt;
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  ui.notice(
    `ArnCode · ${settings.permissionMode === 'full' ? 'full access' : 'ask before changes'}\n${settings.cwd}\nSession: ${state.session.id}`,
  );
  if (!oneShot) ui.notice('/help for commands');
  const execute = async (text: string) => {
    active = new AbortController();
    const before = { ...state.session.usage };
    try {
      await runTask({
        settings,
        session: state.session,
        prompt: text,
        ui,
        signal: active.signal,
        approve: permissions.approve,
      });
    } catch (error) {
      if (active.signal.aborted) {
        ui.notice('Interrupted. The session is saved.');
        if (oneShot) process.exitCode = 130;
      } else {
        ui.notice(errorText(error));
        if (oneShot) process.exitCode = 1;
      }
    } finally {
      active = undefined;
      ui.idle();
      ui.endText();
      await saveSession(state.session);
      const turn = usageDifference(state.session.usage, before);
      turn.requests = state.session.usage.requests - before.requests;
      turn.fastRequests = state.session.usage.fastRequests - before.fastRequests;
      ui.notice(`Turn: ${formatUsage(turn)}`);
      if (oneShot) ui.notice(`Session: ${formatUsage(state.session.usage)}`);
    }
  };
  try {
    if (oneShot) await execute(prompt);
    else
      while (!closing) {
        const line = await input.question('› ');
        if (line === undefined) break;
        if (!line.trim()) continue;
        if (line.trim().startsWith('/')) {
          try {
            if ((await slashCommand(line, state)) === 'exit') break;
          } catch (error) {
            ui.notice(errorText(error));
          }
        } else await execute(line);
      }
  } finally {
    input.close();
    process.stdin.pause();
    ui.idle();
    ui.endText();
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
