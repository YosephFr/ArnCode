import path from 'node:path';
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

function isPlanFile(cwd: string, input: Record<string, unknown>): boolean {
  const target = input.path ?? input.file_path;
  if (typeof target !== 'string') return false;
  const relative = path.relative(path.resolve(cwd, PLAN_DIRECTORY), path.resolve(cwd, target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export class PermissionManager {
  private readonly always = new Set<string>();

  constructor(
    public mode: PermissionMode,
    private readonly interactive: boolean,
    private readonly prompt: PermissionPrompt,
    private readonly cwd?: string,
  ) {}

  setMode(mode: PermissionMode): void {
    this.mode = mode;
    this.always.clear();
  }

  approve = async (
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Approval> => {
    if (signal?.aborted) return { allowed: false, reason: 'Operation cancelled.' };
    if (this.mode === 'full' || readOnlyTools.has(name)) return { allowed: true };
    if (this.mode === 'plan') {
      if (editTools.has(name) && this.cwd && isPlanFile(this.cwd, input)) return { allowed: true };
      if (!shellTools.has(name))
        return {
          allowed: false,
          reason: `Plan mode is read-only, so ${name} is unavailable. Write the plan under ${PLAN_DIRECTORY}/ or present it with exit_plan_mode.`,
        };
    } else if (this.mode === 'edits' && editTools.has(name)) {
      return { allowed: true };
    }
    if (this.mode !== 'plan' && this.always.has(name)) return { allowed: true };
    if (!this.interactive) {
      return {
        allowed: false,
        reason: `Permission denied for ${name}: ${this.mode} mode requires an interactive terminal to approve it. Set permissionMode to full to allow unattended tools.`,
      };
    }
    const answer = (await this.prompt(name, input, signal)).trim().toLowerCase();
    if (signal?.aborted) return { allowed: false, reason: 'Operation cancelled.' };
    if (answer === 'always' || answer === 'a') {
      this.always.add(name);
      return { allowed: true };
    }
    if (answer === 'y' || answer === 'yes') return { allowed: true };
    return { allowed: false, reason: `Permission denied for ${name}.` };
  };
}
