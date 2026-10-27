import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeConfig, type UserConfig } from './config.js';
import { printCredentials, printUsage } from './commands/credentials.js';
import { expandCommand, type CustomCommand } from './commands/custom.js';
import { KNOWN_MODELS, MODEL_ALIASES, modelFeatures, resolveModel } from './models.js';
import { referencedBytes } from './blobs.js';
import { connectMcp } from './mcp.js';
import { newSession, type Session } from './session.js';
import { MODE_LABELS, contextBudget, type PlanUsage } from './status.js';
import { compactNumber, duration } from './tui/text.js';
import type { Choice } from './tui/select.js';
import type { TerminalUI } from './ui.js';
import type { PermissionManager } from './permissions.js';
import type { Settings } from './types.js';
import { formatUsage } from './usage.js';

export interface SlashCommand {
  name: string;
  usage?: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'Show commands' },
  { name: '/model', usage: '[id]', description: 'Choose the model' },
  { name: '/effort', usage: '[level]', description: 'low, medium, high, xhigh, or max' },
  { name: '/mode', usage: '[mode]', description: 'full, edits, ask, or plan' },
  { name: '/plan', description: 'Plan before changing anything' },
  { name: '/compact', description: 'Summarize the conversation to free context' },
  { name: '/context', description: 'Show context use' },
  { name: '/status', description: 'Show the session, model, and plan limits' },
  { name: '/resume', description: 'Continue an earlier conversation in this project' },
  { name: '/clear', description: 'Start a new conversation' },
  { name: '/init', description: 'Write AGENTS.md for this project' },
  { name: '/mcp', description: 'Show MCP servers and their tools' },
  { name: '/export', usage: '[file]', description: 'Save the conversation as Markdown' },
  { name: '/fast', usage: '[on|off]', description: 'Toggle fast mode' },
  { name: '/auth', usage: '[type|auto]', description: 'Choose api-key, oauth, or the mixed bank' },
  { name: '/cost', description: 'Show session usage' },
  { name: '/creds', description: 'Show credential status' },
  { name: '/usage', description: 'Show usage per credential' },
  { name: '/exit', description: 'Exit' },
];

export function helpText(custom: readonly CustomCommand[] = []): string {
  const rows = [
    ...SLASH_COMMANDS.map((command) => ({
      name: `${command.name}${command.usage ? ` ${command.usage}` : ''}`,
      description: command.description,
    })),
    ...custom.map((command) => ({
      name: `${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ''}`,
      description: command.description,
    })),
  ];
  return rows.map((row) => `${row.name.padEnd(22)}${row.description}`).join('\n');
}

export const slashHelp = helpText();

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

const INIT_PROMPT =
  'Explore this repository and write AGENTS.md at its root for coding agents: how to install, build, test, lint, and run it; the architecture and where things live; conventions to follow; and anything easy to get wrong. Verify each command before listing it. Keep it short and specific to this repository. If AGENTS.md already exists, improve it instead of replacing what is still accurate.';

export interface ReplState {
  settings: Settings;
  session: Session;
  permissions: PermissionManager;
  ui: TerminalUI;
  /** Apply a permission mode everywhere it is tracked. */
  setMode?: (mode: Settings['permissionMode']) => void;
  custom?: readonly CustomCommand[];
  plan?: () => PlanUsage;
  compact?: () => Promise<void>;
  resume?: () => Promise<void>;
  select?: <T>(question: string, choices: Choice<T>[], initial?: number) => Promise<T | undefined>;
}

export type SlashResult = 'exit' | 'handled' | { prompt: string };

function transcriptMarkdown(session: Session): string {
  const sections = session.transcript.map((entry) =>
    entry.role === 'user'
      ? `## You\n\n${entry.text}`
      : entry.role === 'assistant'
        ? `## ArnCode\n\n${entry.text}`
        : `<details><summary>Tool</summary>\n\n\`\`\`\n${entry.text.slice(0, 4000)}\n\`\`\`\n\n</details>`,
  );
  return `# Conversation ${session.createdAt.slice(0, 10)}\n\n${sections.join('\n\n')}\n`;
}

function resets(at?: number): string {
  if (!at) return '';
  const left = at * 1000 - Date.now();
  return left > 0 ? `, resets in ${duration(left)}` : '';
}

export async function slashCommand(line: string, state: ReplState): Promise<SlashResult> {
  const [command = '', ...args] = line.trim().split(/\s+/);
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
      ui.notice(helpText(state.custom));
      break;
    case '/clear':
      state.session = newSession(settings);
      ui.notice('Started a new conversation.');
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
    case '/model': {
      let model = value && value !== 'list' ? resolveModel(value) : undefined;
      if (!model && state.select) {
        const ids = [...new Set([...Object.values(MODEL_ALIASES), ...KNOWN_MODELS])];
        model = await state.select(
          'Choose a model',
          ids.map((id) => ({ label: modelFeatures(id).label, value: id, hint: id })),
          Math.max(0, ids.indexOf(settings.model)),
        );
      }
      if (model && model !== settings.model) await persist({ model });
      ui.notice(`Model: ${modelFeatures(settings.model).label} (${settings.model})`);
      break;
    }
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
    case '/compact':
      if (!state.compact) throw new Error('Compaction is available in interactive sessions.');
      await state.compact();
      break;
    case '/context': {
      const { session } = state;
      const budget = contextBudget(settings, session);
      const used = session.contextTokens ?? 0;
      const window = modelFeatures(settings.model).contextWindow;
      const images = referencedBytes(session.messages);
      ui.notice(
        [
          `Context: ${compactNumber(used)} of ${compactNumber(budget)} tokens (${Math.round((used / budget) * 100)}%)`,
          budget < window
            ? `Summarized automatically at ${compactNumber(budget)}; the model's window is ${compactNumber(window)}.`
            : `The model's window is ${compactNumber(window)}.`,
          `${session.messages.length} messages${session.compactions ? `, summarized ${session.compactions} time${session.compactions === 1 ? '' : 's'}` : ''}${images ? `, ${compactNumber(images / 1024)} KB of images` : ''}.`,
        ].join('\n'),
      );
      break;
    }
    case '/status': {
      const plan = state.plan?.() ?? {};
      const lines = [
        `Model: ${modelFeatures(settings.model).label} (${settings.model}) · effort ${settings.effort}${settings.fast ? ' · fast' : ''}`,
        `Permissions: ${MODE_LABELS[settings.permissionMode]}`,
        `Credential: ${state.session.credential ?? 'chosen on the first request'}`,
        `Directory: ${settings.cwd}`,
        `Session: ${state.session.id}`,
        ...(plan.fiveHour
          ? [
              `5-hour limit: ${Math.round(plan.fiveHour.used * 100)}% used${resets(plan.fiveHour.resetsAt)}`,
            ]
          : []),
        ...(plan.weekly
          ? [
              `Weekly limit: ${Math.round(plan.weekly.used * 100)}% used${resets(plan.weekly.resetsAt)}`,
            ]
          : []),
        `Usage: ${formatUsage(state.session.usage)}`,
      ];
      ui.notice(lines.join('\n'));
      break;
    }
    case '/resume':
      if (!state.resume) throw new Error('Use arncode --resume in a terminal.');
      await state.resume();
      break;
    case '/export': {
      const file = path.resolve(
        settings.cwd,
        value ||
          `arncode-${state.session.createdAt.slice(0, 10)}-${state.session.id.slice(0, 8)}.md`,
      );
      await writeFile(file, transcriptMarkdown(state.session), { mode: 0o600 });
      ui.notice(`Saved the conversation to ${path.relative(settings.cwd, file) || file}.`);
      break;
    }
    case '/init':
      return { prompt: INIT_PROMPT };
    case '/mcp': {
      if (!settings.mcpServers || !Object.keys(settings.mcpServers).length) {
        ui.notice('No MCP servers. Add them under "mcpServers" in ~/.arncode/config.json.');
        break;
      }
      const { status } = await connectMcp(settings.mcpServers, settings.cwd);
      ui.notice(
        status
          .map((server) =>
            server.error
              ? `${server.server}: unavailable (${server.error})`
              : `${server.server}: ${server.tools} tool${server.tools === 1 ? '' : 's'}`,
          )
          .join('\n'),
      );
      break;
    }
    default: {
      const custom = state.custom?.find((item) => item.name === command);
      if (custom) return { prompt: expandCommand(custom, value) };
      ui.notice(`Unknown command ${command}. Use /help.`);
    }
  }
  return 'handled';
}
