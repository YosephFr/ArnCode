import { writeConfig, type UserConfig } from './config.js';
import { loadCredentialCandidates } from './auth.js';
import { apiClient } from './engines/api.js';
import { newSession, type Session } from './session.js';
import { formatUsage } from './usage.js';
import { printCredentials, printUsage } from './commands/credentials.js';
import type { TerminalUI } from './ui.js';
import type { PermissionManager } from './permissions.js';
import type { Settings } from './types.js';

export const slashHelp = `/help                 Show commands
/model [id|list]      Show, select, or list models
/auth [type|auto]     Choose api-key, oauth, or the mixed bank
/mode [full|ask]      Choose permission mode
/fast [on|off]        Toggle fast mode
/effort [level]       low, medium, high, xhigh, max
/clear                Start a new conversation
/cost                 Show session usage
/creds                Show credential status
/usage                Show usage per credential
/exit                 Exit`;

interface ReplState {
  settings: Settings;
  session: Session;
  permissions: PermissionManager;
  ui: TerminalUI;
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
      if (value && !['full', 'ask', 'safe', 'default', 'yolo'].includes(value))
        throw new Error('Use /mode full or /mode ask.');
      if (value) {
        settings.permissionMode = ['ask', 'safe'].includes(value) ? 'ask' : 'full';
        state.permissions.setMode(settings.permissionMode);
      }
      ui.notice(`Permissions: ${settings.permissionMode}`);
      break;
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
