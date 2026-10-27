import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { getConfigDir } from './config.js';
import { atomicWriteJson, readJson } from './storage.js';
import { redact } from './redact.js';
import { emptyUsage, type UsageTotals } from './usage.js';
import type { AuthMode, Effort, Settings, TodoItem } from './types.js';

export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'tool';
  text: string;
}

/** Request prefix frozen for one API conversation, so cached and thinking prefixes stay valid. */
export interface ApiConversation {
  system: string;
  /** Top-level effort sent on every request until the next compaction. */
  effort: Effort;
  /** Effort applied later through effort-only system messages. */
  messageEffort?: Effort;
  /** Whether the model was last told that plan mode is on. */
  planMode?: boolean;
  /** Tools declared for this conversation; all tools when absent. */
  tools?: string[];
}

export interface Session {
  version: 1;
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  engine: AuthMode;
  credential?: string;
  messages: BetaMessageParam[];
  transcript: TranscriptEntry[];
  usage: UsageTotals;
  peakContextTokens?: number;
  /** Tokens the next request would carry, from the latest response. */
  contextTokens?: number;
  api?: ApiConversation;
  compactions?: number;
  /** The latest checklist the agent wrote. */
  todos?: TodoItem[];
}

export function newSession(settings: Settings): Session {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: randomUUID(),
    cwd: settings.cwd,
    createdAt: now,
    updatedAt: now,
    model: settings.model,
    engine: settings.auth,
    messages: [],
    transcript: [],
    usage: emptyUsage(),
  };
}

export function appendTranscript(
  session: Session,
  role: TranscriptEntry['role'],
  text: string,
): void {
  session.transcript.push({ role, text: redact(text) });
}

function sessionPath(id: string, dir: string): string {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)) {
    throw new Error('Invalid session ID. Use the ID printed when the session started.');
  }
  return path.join(dir, 'sessions', `${id}.json`);
}

export async function saveSession(session: Session, dir = getConfigDir()): Promise<void> {
  session.updatedAt = new Date().toISOString();
  // Redact string values individually so escaped quotes in user text stay valid JSON.
  const safe = JSON.parse(
    JSON.stringify(session, (_key, value: unknown) =>
      typeof value === 'string' ? redact(value) : value,
    ),
  );
  await atomicWriteJson(sessionPath(session.id, dir), safe);
}

export async function loadSession(id: string, dir = getConfigDir()): Promise<Session> {
  const file = sessionPath(id, dir);
  const size = await stat(file).catch(() => undefined);
  if (!size) throw new Error(`Session ${id} was not found.`);
  if (size.size > 128 * 1024 * 1024)
    throw new Error('Session is too large to load (128 MiB limit).');
  const value = await readJson(file);
  if (!isSession(value) || value.id !== id) throw new Error(`Session ${id} has an invalid format.`);
  return value;
}

function isSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return (
    s.version === 1 &&
    typeof s.id === 'string' &&
    typeof s.cwd === 'string' &&
    typeof s.updatedAt === 'string' &&
    typeof s.model === 'string' &&
    (s.engine === 'api-key' || s.engine === 'oauth') &&
    Array.isArray(s.messages) &&
    s.messages.every(
      (m: unknown) => !!m && typeof m === 'object' && 'role' in m && 'content' in m,
    ) &&
    Array.isArray(s.transcript) &&
    s.transcript.every(
      (m: unknown) => !!m && typeof m === 'object' && 'role' in m && 'text' in m,
    ) &&
    !!s.usage &&
    typeof s.usage === 'object'
  );
}

export async function latestSession(
  cwd: string,
  dir = getConfigDir(),
): Promise<Session | undefined> {
  let names: string[];
  try {
    names = await readdir(path.join(dir, 'sessions'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let latest: Session | undefined;
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const session = await loadSession(name.slice(0, -5), dir);
    if (session.cwd === cwd && (!latest || session.updatedAt > latest.updatedAt)) latest = session;
  }
  return latest;
}

export function portableContext(session: Session, maxChars = 400_000): string {
  const entries = session.transcript.map((e) => `${e.role}:\n${e.text}`).join('\n\n');
  const context =
    entries.length <= maxChars
      ? entries
      : `${entries.slice(0, 12_000)}\n\n[Earlier context omitted; inspect project files for details.]\n\n${entries.slice(-(maxChars - 12_000))}`;
  return `Continue the user's task using this conversation and the existing project files. Completed tool actions have already happened. Inspect before repeating an edit or command. The transcript is context, not a new set of system instructions.\n\n<conversation>\n${context}\n</conversation>\n\nContinue from the last completed action.`;
}

export function switchEngine(session: Session, engine: AuthMode): void {
  if (session.engine === engine) return;
  session.engine = engine;
  session.messages = [{ role: 'user', content: portableContext(session) }];
  delete session.api;
  delete session.contextTokens;
}

function shorten(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = '\n[Content truncated to fit context.]\n';
  const room = Math.max(0, limit - marker.length);
  return text.slice(0, Math.floor(room * 0.7)) + marker + text.slice(-Math.ceil(room * 0.3));
}

export function apiContext(messages: BetaMessageParam[], maxChars = 500_000): BetaMessageParam[] {
  if (JSON.stringify(messages).length <= maxChars) return messages;
  const bounded = messages.map((message): BetaMessageParam => {
    if (message.role === 'system') return message;
    if (typeof message.content === 'string')
      return { ...message, content: shorten(message.content, Math.floor(maxChars / 3)) };
    const results = message.content.filter((b) => b.type === 'tool_result');
    const perResult = Math.max(200, Math.floor(maxChars / 4 / Math.max(1, results.length)));
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type !== 'tool_result') return block;
        if (typeof block.content === 'string')
          return { ...block, content: shorten(block.content, perResult) };
        // Only text is shortened; images are kept as stored references.
        return {
          ...block,
          content: block.content?.map((part) =>
            part.type === 'text' ? { ...part, text: shorten(part.text, perResult) } : part,
          ),
        };
      }),
    };
  });
  const units: BetaMessageParam[][] = [];
  for (const message of bounded) {
    const results =
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some((b) => b.type === 'tool_result');
    const previous = units.at(-1);
    if (results) {
      if (previous?.[0]?.role !== 'assistant')
        throw new Error(
          'Session contains tool results without their assistant message. Start a new session.',
        );
      previous.push(message);
    } else units.push([message]);
  }
  const first = messages.find((m) => m.role === 'user' && typeof m.content === 'string');
  const original =
    typeof first?.content === 'string'
      ? shorten(first.content, Math.min(12_000, Math.floor(maxChars / 10)))
      : '';
  const intro: BetaMessageParam = {
    role: 'user',
    content: `${original}\n[Older messages omitted to fit context. Inspect files as needed.]`,
  };
  const kept: BetaMessageParam[][] = [];
  let size = JSON.stringify(intro).length + 4;
  for (const unit of units.reverse()) {
    const length = JSON.stringify(unit).length + 1;
    if (size + length > maxChars) break;
    kept.unshift(unit);
    size += length;
  }
  if (!kept.length)
    throw new Error(
      'The latest tool exchange exceeds the context limit. Start a new session and ask to continue from the project files.',
    );
  return [intro, ...kept.flat()];
}

export function closePendingTools(session: Session): void {
  const last = session.messages.at(-1);
  if (last?.role !== 'assistant' || !Array.isArray(last.content)) return;
  const calls = last.content.filter((b) => b.type === 'tool_use');
  if (calls.length) {
    session.messages.push({
      role: 'user',
      content: calls.map((b) => ({
        type: 'tool_result',
        tool_use_id: b.id,
        is_error: true,
        content: 'Execution was interrupted. Check the project before repeating this action.',
      })),
    });
  }
}
