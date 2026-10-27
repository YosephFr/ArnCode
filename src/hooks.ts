import { z } from 'zod';
import { redact } from './redact.js';
import { runProcess } from './tools/process.js';

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

const hookCommand = z
  .object({
    type: z.literal('command'),
    command: z.string().min(1).max(10_000),
    timeout: z.number().int().min(1).max(600).optional(),
  })
  .strict();

const matcherSchema = z
  .object({ matcher: z.string().max(500).optional(), hooks: z.array(hookCommand).max(20) })
  .strict();
const eventSchema = z.array(matcherSchema).max(50).optional();

export const hooksSchema = z
  .object({
    PreToolUse: eventSchema,
    PostToolUse: eventSchema,
    UserPromptSubmit: eventSchema,
    Stop: eventSchema,
  })
  .strict();

export type HooksConfig = z.infer<typeof hooksSchema>;

/** Tool names as Claude Code hooks know them, so existing matchers keep working. */
const HOOK_NAMES: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  bash: 'Bash',
  glob: 'Glob',
  grep: 'Grep',
  list_dir: 'LS',
  task: 'Task',
  todo_write: 'TodoWrite',
  exit_plan_mode: 'ExitPlanMode',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  mcp__arncode__glob: 'Glob',
  mcp__arncode__grep: 'Grep',
  Agent: 'Task',
};

/** Tool input in Claude Code's field names: `file_path` for the file tools. */
function hookInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  if (['read_file', 'write_file', 'edit_file'].includes(name) && typeof input.path === 'string') {
    const { path: filePath, ...rest } = input;
    return { file_path: filePath, ...rest };
  }
  return input;
}

function matches(matcher: string | undefined, tool: string): boolean {
  if (!matcher || matcher === '*') return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return matcher === tool;
  }
}

export interface HookOutcome {
  /** Set when a hook blocked the action; the text explains why. */
  blocked?: string;
  /** Text hooks added for the model to read. */
  context?: string;
}

/** Runs the user's command hooks with Claude Code's input, exit-code and JSON conventions. */
export class Hooks {
  constructor(
    private readonly config: HooksConfig | undefined,
    private readonly base: { cwd: string; sessionId: () => string },
  ) {}

  has(event: HookEvent): boolean {
    return Boolean(this.config?.[event]?.length);
  }

  async run(
    event: HookEvent,
    payload: Record<string, unknown>,
    options: { tool?: string; signal?: AbortSignal } = {},
  ): Promise<HookOutcome> {
    const tool = options.tool ? (HOOK_NAMES[options.tool] ?? options.tool) : undefined;
    const commands = (this.config?.[event] ?? [])
      .filter((entry) => tool === undefined || matches(entry.matcher, tool))
      .flatMap((entry) => entry.hooks);
    if (!commands.length) return {};
    const input = JSON.stringify({
      session_id: this.base.sessionId(),
      cwd: this.base.cwd,
      hook_event_name: event,
      ...(tool
        ? {
            tool_name: tool,
            tool_input: hookInput(
              options.tool!,
              (payload.tool_input ?? {}) as Record<string, unknown>,
            ),
          }
        : {}),
      ...Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'tool_input')),
    });
    const blocked: string[] = [];
    const context: string[] = [];
    for (const hook of commands) {
      const result = await runProcess({
        command: 'bash',
        args: ['-c', hook.command],
        cwd: this.base.cwd,
        timeoutMs: (hook.timeout ?? 60) * 1000,
        signal: options.signal,
        input,
      }).catch((error: unknown) => ({
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
        signal: null,
        timedOut: false,
        aborted: false,
        truncated: false,
      }));
      const stdout = redact(result.stdout.trim());
      const stderr = redact(result.stderr.trim());
      let decision: { decision?: string; reason?: string; additionalContext?: string } = {};
      try {
        const parsed = JSON.parse(stdout) as Record<string, unknown>;
        const specific = (parsed.hookSpecificOutput ?? {}) as Record<string, unknown>;
        decision = {
          decision:
            parsed.decision === 'block' || specific.permissionDecision === 'deny'
              ? 'block'
              : undefined,
          reason: String(parsed.reason ?? specific.permissionDecisionReason ?? ''),
          additionalContext:
            typeof specific.additionalContext === 'string' ? specific.additionalContext : undefined,
        };
      } catch {
        // Plain text output.
      }
      if (result.exitCode === 2 || decision.decision === 'block') {
        blocked.push(decision.reason || stderr || 'Blocked by a hook.');
      } else if (decision.additionalContext) {
        context.push(decision.additionalContext);
      } else if (stdout && result.exitCode === 0 && ['UserPromptSubmit'].includes(event)) {
        context.push(stdout);
      }
    }
    return {
      ...(blocked.length ? { blocked: blocked.join('\n') } : {}),
      ...(context.length ? { context: context.join('\n') } : {}),
    };
  }
}
