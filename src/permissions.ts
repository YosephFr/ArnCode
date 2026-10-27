import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { RuleSet, sessionRule, type PermissionRules } from './permission-rules.js';
import type { Approval, PermissionMode } from './types.js';

export type PermissionPrompt = (
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<string>;

/** Plans may be written here while plan mode keeps the rest of the project read-only. */
export const PLAN_DIRECTORY = path.join('.arncode', 'plans');

export const PERMISSION_MODES: PermissionMode[] = ['full', 'edits', 'ask', 'plan'];

const readOnlyTools = new Set([
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'skill',
  'todo_write',
  'exit_plan_mode',
  'task',
  'bash_output',
  'kill_shell',
  'mcp__arncode__skill',
  'mcp__arncode__glob',
  'mcp__arncode__grep',
  'mcp__arncode__exit_plan_mode',
  'Read',
  'Glob',
  'Grep',
  'LS',
  'TodoWrite',
  'ExitPlanMode',
  'Agent',
]);

const editTools = new Set([
  'write_file',
  'edit_file',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);
const shellTools = new Set(['bash', 'Bash']);

export function isReadOnlyTool(name: string): boolean {
  return readOnlyTools.has(name);
}

/** The real location of a path that may not exist yet, through its nearest existing parent. */
async function realLocation(file: string): Promise<string> {
  const rest: string[] = [];
  for (let current = file; ; current = path.dirname(current)) {
    try {
      return path.join(await realpath(current), ...rest);
    } catch {
      if (path.dirname(current) === current) return file;
      rest.unshift(path.basename(current));
    }
  }
}

// Compared by real location, so a plan directory linked elsewhere grants nothing.
async function isPlanFile(cwd: string, input: Record<string, unknown>): Promise<boolean> {
  const target = input.path ?? input.file_path;
  if (typeof target !== 'string') return false;
  const plans = path.join(await realLocation(path.resolve(cwd)), PLAN_DIRECTORY);
  const relative = path.relative(plans, await realLocation(path.resolve(cwd, target)));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export class PermissionManager {
  private readonly rules: RuleSet;

  constructor(
    public mode: PermissionMode,
    private readonly interactive: boolean,
    private readonly prompt: PermissionPrompt,
    private readonly cwd?: string,
    private readonly configured: PermissionRules = {},
  ) {
    this.rules = new RuleSet(configured);
  }

  /** A new mode starts without the approvals given for this session. */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
    this.rules.clearSession(this.configured);
  }

  approve = async (
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Approval> => {
    if (signal?.aborted) return { allowed: false, reason: 'Operation cancelled.' };
    // Deny rules hold in every mode, full access included.
    const ruled = this.rules.check(name, input, this.cwd ?? process.cwd());
    if (ruled?.decision === 'deny')
      return { allowed: false, reason: `Blocked by your permission rule ${ruled.rule}.` };
    if (this.mode === 'full' || readOnlyTools.has(name)) return { allowed: true };
    // Plan mode stays read-only whatever the rules allow, apart from plan files.
    if (ruled?.decision === 'allow' && !(this.mode === 'plan' && editTools.has(name)))
      return { allowed: true };
    if (this.mode === 'plan') {
      if (editTools.has(name) && this.cwd && (await isPlanFile(this.cwd, input)))
        return { allowed: true };
      if (!shellTools.has(name))
        return {
          allowed: false,
          reason: `Plan mode is read-only, so ${name} is unavailable. Write the plan under ${PLAN_DIRECTORY}/ or present it with exit_plan_mode.`,
        };
    } else if (this.mode === 'edits' && editTools.has(name)) {
      return { allowed: true };
    }
    if (!this.interactive) {
      return {
        allowed: false,
        reason: `Permission denied for ${name}: ${this.mode} mode requires an interactive terminal to approve it. Set permissionMode to full to allow unattended tools.`,
      };
    }
    const answer = (await this.prompt(name, input, signal)).trim().toLowerCase();
    if (signal?.aborted) return { allowed: false, reason: 'Operation cancelled.' };
    if (answer === 'always' || answer === 'a') {
      this.rules.add(sessionRule(name, input));
      return { allowed: true };
    }
    if (answer === 'y' || answer === 'yes') return { allowed: true };
    return { allowed: false, reason: `Permission denied for ${name}.` };
  };
}
