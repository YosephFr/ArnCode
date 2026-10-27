import { randomUUID } from 'node:crypto';
import { mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { AgentUI, Approve, ExitPlan, TodoItem } from '../types.js';
import { redact } from '../redact.js';
import {
  editText,
  listDirectory,
  readDocument,
  readImage,
  readText,
  truncate,
  writeText,
} from './files.js';
import type { PreparedImage } from '../images.js';
import type { Hooks } from '../hooks.js';
import { globFiles, grepFiles } from './search.js';
import { runProcess } from './process.js';
import { loadSkill } from '../skills.js';
import { createPathPolicy } from './paths.js';

export { toolDefinitions } from './definitions.js';

const filePath = z.string().min(1).max(4096);
const schemas = {
  skill: z.object({ name: z.string().min(1).max(64) }).strict(),
  exit_plan_mode: z.object({ plan: z.string().min(1).max(200_000) }).strict(),
  task: z
    .object({
      description: z.string().min(1).max(200),
      prompt: z.string().min(1).max(100_000),
      subagent_type: z.enum(['explore', 'general']).default('explore'),
    })
    .strict(),
  todo_write: z
    .object({
      todos: z
        .array(
          z
            .object({
              content: z.string().min(1).max(500),
              status: z.enum(['pending', 'in_progress', 'completed']),
              activeForm: z.string().min(1).max(500),
            })
            .strict(),
        )
        .max(50),
    })
    .strict(),
  read_file: z
    .object({
      path: filePath,
      offset: z.number().int().min(1).default(1),
      limit: z.number().int().min(1).max(2000).default(2000),
    })
    .strict(),
  write_file: z.object({ path: filePath, content: z.string().max(5 * 1024 * 1024) }).strict(),
  edit_file: z
    .object({
      path: filePath,
      old_string: z
        .string()
        .min(1)
        .max(5 * 1024 * 1024),
      new_string: z.string().max(5 * 1024 * 1024),
      replace_all: z.boolean().default(false),
    })
    .strict(),
  list_dir: z.object({ path: filePath.default('.') }).strict(),
  glob: z.object({ pattern: z.string().min(1).max(4096), path: filePath.default('.') }).strict(),
  grep: z
    .object({
      pattern: z.string().min(1).max(4096),
      path: filePath.default('.'),
      glob: z.string().min(1).max(4096).default('**/*'),
      literal: z.boolean().default(false),
      ignore_case: z.boolean().default(false),
    })
    .strict(),
  bash: z
    .object({
      command: z.string().min(1).max(128_000),
      timeout_ms: z.number().int().min(1).max(1_800_000).default(120_000),
    })
    .strict(),
};

export { schemas as toolSchemas };

const OUTPUT_DIRECTORY = path.join(tmpdir(), `arncode-output-${process.getuid?.() ?? 'user'}`);
let pruned = false;

/** A private file for one command's complete output; logs older than a day are removed. */
async function outputLogPath(): Promise<string> {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true, mode: 0o700 });
  if (!pruned) {
    pruned = true;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of await readdir(OUTPUT_DIRECTORY).catch(() => [])) {
      const file = path.join(OUTPUT_DIRECTORY, name);
      if (((await stat(file).catch(() => undefined))?.mtimeMs ?? Infinity) < cutoff)
        await rm(file, { force: true });
    }
  }
  return path.join(OUTPUT_DIRECTORY, `${randomUUID()}.log`);
}

// Tools without side effects can run concurrently within one model turn.
const parallelSafe = new Set(['read_file', 'list_dir', 'glob', 'grep', 'skill', 'task']);

export function isParallelSafe(name: string): boolean {
  return parallelSafe.has(name);
}

export type SubagentRequest = z.infer<(typeof schemas)['task']>;

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; image: PreparedImage }
  | { type: 'document'; data: Buffer; pages: number };

export interface ToolResult {
  content: string | ToolContent[];
  is_error?: boolean;
}

function kilobytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('en-US')} KB`;
}

function format(mediaType: string): string {
  return mediaType.replace('image/', '').toUpperCase();
}

export function describeImage(file: string, image: PreparedImage): string {
  const { original } = image;
  const source = `${original.width}×${original.height} ${format(original.mediaType)}, ${kilobytes(original.bytes)}`;
  const sent =
    image.data.length === original.bytes
      ? ''
      : `; sent as ${image.width}×${image.height} ${format(image.mediaType)}, ${kilobytes(image.data.length)}`;
  return `Image ${file} (${source}${sent})`;
}

export function todoSummary(todos: TodoItem[]): string {
  const done = todos.filter((item) => item.status === 'completed').length;
  const active = todos.find((item) => item.status === 'in_progress');
  return `Todos updated: ${done}/${todos.length} completed${active ? `; in progress: ${active.content}` : ''}.`;
}

/** Text form of a result, for transcripts, terminal output and text-only consumers. */
export function resultText(result: ToolResult): string {
  if (typeof result.content === 'string') return result.content;
  return result.content
    .map((part) =>
      part.type === 'text'
        ? part.text
        : part.type === 'image'
          ? `[Image ${part.image.width}×${part.image.height}]`
          : `[PDF, about ${part.pages} pages]`,
    )
    .join('\n');
}

export class ToolRunner {
  constructor(
    private readonly options: {
      cwd: string;
      approve: Approve;
      ui: AgentUI;
      protectedPaths?: readonly string[];
      exitPlan?: ExitPlan;
      onTodos?: (items: TodoItem[]) => void;
      /** Run a subagent; absent where subagents are unavailable, such as inside one. */
      subagent?: (input: SubagentRequest, signal?: AbortSignal) => Promise<ToolResult>;
      /** Tools this runner may execute; every tool when absent. */
      allowedTools?: readonly string[];
      hooks?: Hooks;
      /** Called before a write or edit changes a file, so the change can be undone. */
      beforeChange?: (file: string) => Promise<void>;
      /** Tools served elsewhere, such as MCP servers. */
      external?: {
        has(name: string): boolean;
        call(
          name: string,
          input: Record<string, unknown>,
          signal?: AbortSignal,
        ): Promise<ToolResult>;
      };
    },
  ) {}

  async run(name: string, input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const started = Date.now();
    const { hooks } = this.options;
    const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    try {
      if (hooks?.has('PreToolUse')) {
        const outcome = await hooks.run('PreToolUse', { tool_input: args }, { tool: name, signal });
        if (outcome.blocked) {
          this.options.ui.tool(name, args);
          const blocked = { content: `Blocked by a hook: ${outcome.blocked}`, is_error: true };
          this.options.ui.toolResult(name, blocked.content, { isError: true });
          return blocked;
        }
      }
      const result = await this.execute(name, input, signal);
      if (hooks?.has('PostToolUse')) {
        const outcome = await hooks.run(
          'PostToolUse',
          { tool_input: args, tool_response: resultText(result).slice(0, 20_000) },
          { tool: name, signal },
        );
        const feedback = outcome.blocked ?? outcome.context;
        if (feedback) {
          const note = { type: 'text' as const, text: `Hook feedback: ${feedback}` };
          result.content =
            typeof result.content === 'string'
              ? `${result.content}\n\n${note.text}`
              : [...result.content, note];
        }
      }
      this.options.ui.toolResult(name, resultText(result), {
        isError: result.is_error,
        durationMs: Date.now() - started,
      });
      return result;
    } finally {
      this.options.ui.idle();
    }
  }

  private async execute(name: string, input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    try {
      signal?.throwIfAborted();
      const { external } = this.options;
      if (external?.has(name)) {
        const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
        this.options.ui.tool(name, args);
        const approval = await this.options.approve(name, args, signal);
        if (!approval.allowed) throw new Error(approval.reason ?? `Permission denied for ${name}.`);
        this.options.ui.status(`Running ${name}`);
        return await external.call(name, args, signal);
      }
      if (!Object.hasOwn(schemas, name)) throw new Error(`Unknown tool: ${name}`);
      if (this.options.allowedTools && !this.options.allowedTools.includes(name))
        throw new Error(`${name} is not available to this agent.`);
      const tool = name as keyof typeof schemas;
      const parsed = schemas[tool].safeParse(input);
      if (!parsed.success) {
        const details = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
          .join('; ');
        throw new Error(`Invalid ${name} input: ${details}`);
      }
      const value = parsed.data;
      const cwd = await realpath(this.options.cwd);
      const policy = ['bash', 'skill', 'exit_plan_mode', 'todo_write', 'task'].includes(tool)
        ? undefined
        : await createPathPolicy(cwd, this.options.protectedPaths);
      this.options.ui.tool(name, value);
      const approval = await this.options.approve(name, value, signal);
      if (!approval.allowed) {
        const reason = approval.reason ?? `Permission denied for ${name}.`;
        throw new Error(reason);
      }
      signal?.throwIfAborted();
      this.options.ui.status(`Running ${name}`);
      let content: string;
      switch (tool) {
        case 'task': {
          if (!this.options.subagent) throw new Error('Subagents are not available here.');
          return await this.options.subagent(schemas.task.parse(value), signal);
        }
        case 'todo_write': {
          const { todos } = schemas.todo_write.parse(value);
          if (todos.filter((item) => item.status === 'in_progress').length > 1)
            throw new Error('Mark at most one item in_progress at a time.');
          this.options.onTodos?.(todos);
          this.options.ui.todos?.(todos);
          return { content: todoSummary(todos) };
        }
        case 'exit_plan_mode': {
          const { plan } = schemas.exit_plan_mode.parse(value);
          if (!this.options.exitPlan) {
            this.options.ui.text(`${plan.trimEnd()}\n`);
            this.options.ui.endText();
            return {
              content:
                'The plan was shown to the user, who will review it before anything changes. Stop here without making changes.',
            };
          }
          const decision = await this.options.exitPlan(plan, signal);
          if (!decision.approved)
            return {
              content: decision.feedback
                ? `The user wants changes to the plan: ${decision.feedback}`
                : 'The user did not approve the plan yet. Ask what should change, then present a revised plan.',
            };
          return {
            content: `The user approved the plan${decision.mode && decision.mode !== 'plan' ? `; plan mode is off and ${decision.mode} permissions apply` : ''}. Carry it out now.`,
          };
        }
        case 'skill': {
          const skill = await loadSkill(cwd, schemas.skill.parse(value).name);
          return {
            content: redact(
              `Skill: ${skill.name}\nBase directory: ${skill.basePath}\n\n${skill.body}`,
            ),
          };
        }
        case 'read_file': {
          const request = schemas.read_file.parse(value);
          const document = await readDocument(cwd, request.path, policy);
          if (document)
            return {
              content: [
                {
                  type: 'text',
                  text: redact(
                    `PDF ${document.path} (about ${document.pages} page${document.pages === 1 ? '' : 's'}, ${kilobytes(document.data.length)})`,
                  ),
                },
                { type: 'document', data: document.data, pages: document.pages },
              ],
            };
          const image = await readImage(cwd, request.path, policy);
          if (image)
            return {
              content: [
                { type: 'text', text: redact(describeImage(image.path, image.image)) },
                { type: 'image', image: image.image },
              ],
            };
          content = await readText(cwd, request, signal, policy);
          break;
        }
        case 'write_file':
          content = await writeText(
            cwd,
            schemas.write_file.parse(value),
            this.options.ui,
            policy,
            this.options.beforeChange,
          );
          break;
        case 'edit_file':
          content = await editText(
            cwd,
            schemas.edit_file.parse(value),
            this.options.ui,
            policy,
            this.options.beforeChange,
          );
          break;
        case 'list_dir':
          content = await listDirectory(cwd, schemas.list_dir.parse(value), policy);
          break;
        case 'glob':
          content = await globFiles(cwd, schemas.glob.parse(value), signal, policy);
          break;
        case 'grep':
          content = await grepFiles(cwd, schemas.grep.parse(value), signal, policy);
          break;
        case 'bash': {
          const { command, timeout_ms } = schemas.bash.parse(value);
          const logFile = await outputLogPath();
          const result = await runProcess({
            command: 'bash',
            args: ['-c', command],
            cwd,
            timeoutMs: timeout_ms,
            signal,
            logFile,
          });
          const status = result.aborted
            ? 'Cancelled'
            : result.timedOut
              ? `Timed out after ${timeout_ms} ms`
              : result.signal
                ? `Stopped by ${result.signal}`
                : `Exit code: ${result.exitCode}`;
          content = `${status}\nstdout:\n${result.stdout || '(empty)'}\nstderr:\n${result.stderr || '(empty)'}`;
          if (result.truncated)
            content += `\n[Full output saved to ${logFile}. Search it with grep or read parts with sed instead of running the command again.]`;
          else await rm(logFile, { force: true });
          return {
            content: redact(content),
            is_error: result.aborted || result.timedOut || result.exitCode !== 0,
          };
        }
      }
      return { content: truncate(redact(content)) };
    } catch (error) {
      return {
        content: truncate(redact(error instanceof Error ? error.message : String(error))),
        is_error: true,
      };
    }
  }
}
