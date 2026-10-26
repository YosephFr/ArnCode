import { Command, Option, InvalidArgumentError } from 'commander';
import {
  addProfile,
  enableCredential,
  listProfiles,
  loadCredentialCandidates,
  listCredentials,
  removeProfile,
  useProfile,
} from '../auth.js';
import { readConfig, resolveSettings } from '../config.js';
import { MeterStore, isAvailable, credentialState } from '../metering.js';
import { TerminalInput } from '../input.js';
import { TerminalUI } from '../ui.js';
import { runTask } from '../runner.js';
import { newSession } from '../session.js';
import { addUsage, emptyUsage, formatUsage } from '../usage.js';
import type { AuthMode } from '../types.js';

export function integer(value: string): number {
  if (!/^-?\d+$/.test(value)) throw new InvalidArgumentError('Use an integer.');
  return Number(value);
}

export async function printCredentials(ui: TerminalUI): Promise<void> {
  const stored = await listCredentials();
  const candidates = await loadCredentialCandidates({});
  const environment = candidates
    .filter((c) => c.source === 'environment')
    .map(({ secret, ...c }) => ({ ...c, masked: `••••${secret.slice(-4)}` }));
  const all = [...stored, ...environment];
  if (!all.length) {
    ui.notice('No credentials. Run arncode creds add <name>.');
    return;
  }
  const usage = await new MeterStore().read();
  const config = await readConfig();
  for (const credential of all) {
    const active = candidates.find((c) => c.name === credential.name);
    const state = active ? credentialState(usage, active) : undefined;
    const status = !credential.enabled
      ? 'disabled'
      : isAvailable(state)
        ? 'ready'
        : `resets ${state?.resetAt}`;
    ui.notice(
      `${credential.name}${config.profile === credential.name ? ' (preferred)' : ''}  ${credential.type}  ${credential.masked}  priority ${credential.priority}  ${status}`,
    );
  }
}

export async function printUsage(ui: TerminalUI, stats = false): Promise<void> {
  const usage = await new MeterStore().read();
  const entries = Object.entries(usage.credentials);
  if (!entries.length) {
    ui.notice('No usage recorded.');
    return;
  }
  if (stats) {
    const total = entries.reduce((sum, [, value]) => addUsage(sum, value), emptyUsage());
    const errors = entries.reduce((sum, [, value]) => sum + value.errors, 0);
    const hits = entries.reduce((sum, [, value]) => sum + value.limitHits, 0);
    ui.notice(
      `${entries.length} credentials · ${total.requests} requests · ${errors} errors · ${hits} limit hits\n${formatUsage(total)}`,
    );
    return;
  }
  for (const [name, value] of entries) {
    ui.notice(
      `${name} (${value.type}) · ${value.requests} requests · ${value.errors} errors · ${value.limitHits} limit hits\n  ${formatUsage(value)}\n  Last used: ${value.lastUsed ?? 'never'}${isAvailable(value) ? '' : ` · resets ${value.resetAt}`}`,
    );
  }
}

export function credentialCommands(program: Command, ui: TerminalUI): void {
  for (const kind of ['creds', 'auth']) {
    const group = program
      .command(kind)
      .description(
        kind === 'creds'
          ? 'Manage the credential bank and usage'
          : 'Manage named authentication profiles',
      );
    group
      .command('add <name>')
      .addOption(
        new Option('--type <type>', 'Credential type')
          .choices(['api-key', 'oauth'])
          .default('oauth'),
      )
      .option('--priority <number>', 'Lower values are tried first', integer, 0)
      .description('Add a credential from hidden input or stdin')
      .action(async (name: string, options: { type: AuthMode; priority: number }) => {
        const input = new TerminalInput();
        try {
          const secret = await input.secret(
            options.type === 'oauth' ? 'OAuth token: ' : 'API key: ',
          );
          await addProfile(name, options.type, secret, undefined, { priority: options.priority });
          ui.notice(`Added ${name} (${options.type}).`);
        } finally {
          input.close();
        }
      });
    group
      .command('use <name>')
      .description('Prefer a credential while retaining failover')
      .action(async (name: string) => {
        await useProfile(name);
        ui.notice(`Preferred credential: ${name}.`);
      });
    group
      .command('remove <name>')
      .description('Remove a stored credential')
      .action(async (name: string) => {
        await removeProfile(name);
        ui.notice(`Removed ${name}.`);
      });
    group
      .command('list')
      .description('List credentials without revealing tokens')
      .action(async () => {
        if (kind === 'creds') await printCredentials(ui);
        else {
          const profiles = await listProfiles();
          ui.notice(
            profiles.length
              ? profiles.map((p) => `${p.name}  ${p.type}`).join('\n')
              : 'No profiles. Run arncode auth add <name>.',
          );
        }
      });
    for (const action of ['enable', 'disable'])
      group
        .command(`${action} <name>`)
        .description(`${action === 'enable' ? 'Enable' : 'Disable'} a stored credential`)
        .action(async (name: string) => {
          await enableCredential(name, action === 'enable');
          ui.notice(`${name}: ${action === 'enable' ? 'enabled' : 'disabled'}.`);
        });
    group
      .command('usage')
      .description('Show usage per credential')
      .action(() => printUsage(ui));
    group
      .command('stats')
      .description('Show aggregate usage')
      .action(() => printUsage(ui, true));
    group
      .command('test <name>')
      .description('Check a credential with a small Haiku request')
      .action(async (name: string) => {
        const credential = (await loadCredentialCandidates({ pinnedCredential: name }))[0];
        if (!credential) throw new Error(`Credential '${name}' was not found.`);
        const settings = {
          ...resolveSettings({}, process.env, await readConfig()),
          auth: credential.type,
          authRestriction: credential.type,
          pinnedCredential: name,
          model: 'claude-haiku-5-5',
          maxTurns: 1,
          maxTokens: 256,
          fast: false,
        };
        const controller = new AbortController();
        const cancel = () => controller.abort();
        process.once('SIGINT', cancel);
        try {
          const usage = await runTask({
            settings,
            session: newSession(settings),
            prompt: 'Reply with only OK. Do not use tools.',
            ui,
            signal: controller.signal,
            approve: async () => ({
              allowed: false,
              reason: 'Tools are disabled during credential checks.',
            }),
            candidates: [credential],
            ignoreCooldown: true,
            save: async () => undefined,
          });
          ui.notice(`${name}: connected. ${formatUsage(usage)}`);
        } finally {
          process.off('SIGINT', cancel);
        }
      });
  }
}
