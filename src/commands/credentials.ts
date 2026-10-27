import { Command, Option, InvalidArgumentError } from 'commander';
import {
  addProfile,
  detectCredentialType,
  enableCredential,
  renameProfile,
  setCredentialPriority,
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
import { duration } from '../tui/text.js';
import type { AuthMode } from '../types.js';

export function integer(value: string): number {
  if (!/^-?\d+$/.test(value)) throw new InvalidArgumentError('Use an integer.');
  return Number(value);
}

function until(iso?: string): string {
  if (!iso) return 'later';
  const left = Date.parse(iso) - Date.now();
  return left > 0 ? `in ${duration(left)}` : 'now';
}

/** One line per credential: order, type, status, and the plan limits last seen for it. */
export async function credentialLines(): Promise<{ name: string; line: string }[]> {
  const stored = await listCredentials();
  const candidates = await loadCredentialCandidates({});
  const environment = candidates
    .filter((c) => c.source === 'environment')
    .map(({ secret, ...c }) => ({ ...c, masked: `••••${secret.slice(-4)}` }));
  const usage = await new MeterStore().read();
  const config = await readConfig();
  return [...stored, ...environment].map((credential) => {
    const active = candidates.find((c) => c.name === credential.name);
    const state = active ? credentialState(usage, active) : undefined;
    const status = !credential.enabled
      ? 'disabled'
      : isAvailable(state)
        ? 'ready'
        : `limited, back ${until(state?.resetAt)}`;
    const plan = state?.plan;
    const limits = [
      plan?.fiveHour ? `5h ${Math.round(plan.fiveHour.used * 100)}%` : '',
      plan?.weekly ? `wk ${Math.round(plan.weekly.used * 100)}%` : '',
    ].filter(Boolean);
    const preferred = config.profile === credential.name ? ' · preferred' : '';
    return {
      name: credential.name,
      line: `${credential.name}  ${credential.type} ${credential.masked} · priority ${credential.priority} · ${status}${limits.length ? ` · ${limits.join(' · ')}` : ''}${preferred}`,
    };
  });
}

export async function printCredentials(ui: TerminalUI): Promise<void> {
  const lines = await credentialLines();
  ui.notice(
    lines.length
      ? lines.map((entry) => entry.line).join('\n')
      : 'No credentials. Run arncode creds add <name>.',
  );
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
        new Option(
          '--type <type>',
          'Credential type; detected from the token when omitted',
        ).choices(['api-key', 'oauth']),
      )
      .option('--priority <number>', 'Lower values are tried first', integer, 0)
      .description('Add a credential from hidden input or stdin')
      .action(async (name: string, options: { type?: AuthMode; priority: number }) => {
        const input = new TerminalInput();
        try {
          const secret = await input.secret(
            options.type === 'oauth'
              ? 'OAuth token: '
              : options.type === 'api-key'
                ? 'API key: '
                : 'API key or token from claude setup-token: ',
          );
          const type = options.type ?? detectCredentialType(secret) ?? 'oauth';
          await addProfile(name, type, secret, undefined, { priority: options.priority });
          ui.notice(`Added ${name} (${type}).`);
        } finally {
          input.close();
        }
      });
    group
      .command('priority <name> <number>')
      .description('Set the order: lower values are tried first')
      .action(async (name: string, value: string) => {
        await setCredentialPriority(name, integer(value));
        ui.notice(`${name}: priority ${integer(value)}.`);
      });
    group
      .command('rename <name> <new-name>')
      .description('Rename a stored credential, keeping its usage history')
      .action(async (name: string, next: string) => {
        await renameProfile(name, next);
        await new MeterStore().rename(name, next);
        ui.notice(`Renamed ${name} to ${next}.`);
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
      .action((name: string) => testCredential(name, ui));
  }
}

/** Make one tiny Haiku request with a credential to confirm that it works. */
export async function testCredential(name: string, ui: TerminalUI): Promise<void> {
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
}
