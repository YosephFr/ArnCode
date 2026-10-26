import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import type { AgentUI, Approve } from '../types.js';
import { redact } from '../redact.js';
import { editText, listDirectory, readText, truncate, writeText } from './files.js';
import { globFiles, grepFiles } from './search.js';
import { runProcess } from './process.js';
import { loadSkill } from '../skills.js';

export { toolDefinitions } from './definitions.js';

const filePath = z.string().min(1).max(4096);
const schemas = {
  skill: z.object({ name: z.string().min(1).max(64) }).strict(),
  read_file: z
    .object({
      path: filePath,
      offset: z.number().int().min(1).default(1),
      limit: z.number().int().min(1).max(2000).default(200),
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

export interface ToolResult {
  content: string;
  is_error?: boolean;
}

export class ToolRunner {
  constructor(private readonly options: { cwd: string; approve: Approve; ui: AgentUI }) {}

  async run(name: string, input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    try {
      signal?.throwIfAborted();
      if (!Object.hasOwn(schemas, name)) throw new Error(`Unknown tool: ${name}`);
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
      this.options.ui.tool(name, value);
      const approval = await this.options.approve(name, value, signal);
      if (!approval.allowed) {
        const reason = approval.reason ?? `Permission denied for ${name}.`;
        this.options.ui.notice(reason);
        throw new Error(reason);
      }
      signal?.throwIfAborted();
      let content: string;
      switch (tool) {
        case 'skill': {
          const skill = await loadSkill(cwd, schemas.skill.parse(value).name);
          return {
            content: redact(
              `Skill: ${skill.name}\nBase directory: ${skill.basePath}\n\n${skill.body}`,
            ),
          };
        }
        case 'read_file':
          content = await readText(cwd, schemas.read_file.parse(value), signal);
          break;
        case 'write_file':
          content = await writeText(cwd, schemas.write_file.parse(value), this.options.ui);
          break;
        case 'edit_file':
          content = await editText(cwd, schemas.edit_file.parse(value), this.options.ui);
          break;
        case 'list_dir':
          content = await listDirectory(cwd, schemas.list_dir.parse(value));
          break;
        case 'glob':
          content = await globFiles(cwd, schemas.glob.parse(value), signal);
          break;
        case 'grep':
          content = await grepFiles(cwd, schemas.grep.parse(value), signal);
          break;
        case 'bash': {
          const { command, timeout_ms } = schemas.bash.parse(value);
          const result = await runProcess({
            command: 'bash',
            args: ['-c', command],
            cwd,
            timeoutMs: timeout_ms,
            signal,
          });
          const status = result.aborted
            ? 'Cancelled'
            : result.timedOut
              ? `Timed out after ${timeout_ms} ms`
              : result.signal
                ? `Stopped by ${result.signal}`
                : `Exit code: ${result.exitCode}`;
          content = `${status}\nstdout:\n${result.stdout || '(empty)'}\nstderr:\n${result.stderr || '(empty)'}`;
          return {
            content: truncate(redact(content)),
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
