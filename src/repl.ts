import { writeConfig, type UserConfig } from './config.js';
import { loadCredentialCandidates } from './auth.js';
import { apiClient } from './engines/api.js';
import { newSession, type Session } from './session.js';
import { formatUsage } from './usage.js';
import { printCredentials, printUsage } from './commands/credentials.js';
import type { TerminalUI } from './ui.js';
import type { PermissionManager } from './permissions.js';
import type { Settings } from './types.js';
import { MODE_LABELS } from './status.js';

export interface SlashCommand {
  name: string;
  usage?: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'Show commands' },
  { name: '/model', usage: '[id|list]', description: 'Show, select, or list models' },
  { name: '/effort', usage: '[level]', description: 'low, medium, high, xhigh, or max' },
  { name: '/mode', usage: '[mode]', description: 'full, edits, ask, or plan' },
  { name: '/plan', description: 'Plan before changing anything' },
  { name: '/fast', usage: '[on|off]', description: 'Toggle fast mode' },
  { name: '/auth', usage: '[type|auto]', description: 'Choose api-key, oauth, or the mixed bank' },
  { name: '/clear', description: 'Start a new conversation' },
  { name: '/cost', description: 'Show session usage' },
  { name: '/creds', description: 'Show credential status' },
  { name: '/usage', description: 'Show usage per credential' },
  { name: '/exit', description: 'Exit' },
];

export const slashHelp = SLASH_COMMANDS.map(
  (command) =>
    `${`${command.name}${command.usage ? ` ${command.usage}` : ''}`.padEnd(22)}${command.description}`,
).join('\n');

const MODE_ALIASES: Record<string, Settings['permissionMode']> = {
  full: 'full',
  yolo: 'full',
  default: 'full',
  edits: 'edits',
  'auto-edit': 'edits',
  ask: 'ask',
  safe: 'ask',
  plan: 'plan',
};

interface ReplState {
  settings: Settings;
  session: Session;
  permissions: PermissionManager;
  ui: TerminalUI;
  /** Apply a permission mode everywhere it is tracked. */
  setMode?: (mode: Settings['permissionMode']) => void;
}

export async function slashCommand(line: string, state: ReplState): Promise<'exit' | 'handled'> {
  const [command, ...args] = line.trim().split(/\s+/);
  const value = args.join(' ');
  const { settings, ui } = state;
  const persist = async (patch: Partial<UserConfig>) => {
    await writeConfig(patch);
    Object.assign(settings, patch);
  };
  switch (command) {
    case '/exit':
      return 'exit';
    case '/help':
      ui.notice(slashHelp);
      break;
    case '/clear':
      state.session = newSession(settings);
      ui.notice(`New session: ${state.session.id}`);
      break;
    case '/cost':
      ui.notice(formatUsage(state.session.usage));
      break;
    case '/creds':
      await printCredentials(ui);
      break;
    case '/usage':
      await printUsage(ui);
      break;
    case '/model':
      if (value === 'list') {
        const key = (await loadCredentialCandidates({ authRestriction: 'api-key' }))[0];
        if (!key) {
          ui.notice('claude-opus-5-5\nclaude-sonnet-5-5\nclaude-haiku-5-5');
          break;
        }
        const models = await apiClient(key.secret, settings.baseUrl).models.list({ limit: 100 });
        ui.notice(models.data.map((model) => `${model.id}  ${model.display_name}`).join('\n'));
      } else if (value) {
        await persist({ model: value });
        ui.notice(`Model: ${settings.model}`);
      } else ui.notice(`Model: ${settings.model}`);
      break;
    case '/auth':
      if (!value) {
        ui.notice(
          `Authentication: ${settings.authRestriction ?? 'auto'}${settings.pinnedCredential ? ` · pinned ${settings.pinnedCredential}` : ''}`,
        );
        break;
      }
      if (!['auto', 'api-key', 'oauth'].includes(value))
        throw new Error('Use /auth api-key, /auth oauth, or /auth auto.');
      settings.authRestriction = value === 'auto' ? undefined : (value as 'api-key' | 'oauth');
      settings.auth = settings.authRestriction ?? settings.auth;
      delete settings.pinnedCredential;
      delete settings.profile;
      await writeConfig({ auth: settings.authRestriction, profile: undefined });
      ui.notice(`Authentication: ${value}`);
      break;
    case '/mode':
    case '/plan': {
      const requested = command === '/plan' ? 'plan' : value;
      const mode = requested ? MODE_ALIASES[requested] : undefined;
      if (requested && !mode) throw new Error('Use /mode full, edits, ask, or plan.');
      if (mode) {
        if (state.setMode) state.setMode(mode);
        else {
          settings.permissionMode = mode;
          state.permissions.setMode(mode);
        }
      }
      ui.notice(`Permissions: ${MODE_LABELS[settings.permissionMode]}`);
      break;
    }
    case '/fast':
      if (value && !['on', 'off'].includes(value)) throw new Error('Use /fast on or /fast off.');
      await persist({ fast: value ? value === 'on' : !settings.fast });
      ui.notice(`Fast mode: ${settings.fast ? 'on' : 'off'}`);
      break;
    case '/effort':
      if (value) {
        if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(value))
          throw new Error('Use low, medium, high, xhigh, or max.');
        await persist({ effort: value as Settings['effort'] });
      }
      ui.notice(`Effort: ${settings.effort}`);
      break;
    default:
      ui.notice(`Unknown command ${command}. Use /help.`);
  }
  return 'handled';
}
