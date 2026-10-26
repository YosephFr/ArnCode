import type { Approval, PermissionMode } from './types.js';

export type PermissionPrompt = (
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<string>;

const readOnlyTools = new Set([
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'skill',
  'mcp__arncode__skill',
  'Read',
  'Glob',
  'Grep',
  'LS',
]);

export class PermissionManager {
  private readonly always = new Set<string>();

  constructor(
    public mode: PermissionMode,
    private readonly interactive: boolean,
    private readonly prompt: PermissionPrompt,
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
    if (this.mode === 'full' || readOnlyTools.has(name) || this.always.has(name)) {
      return { allowed: true };
    }
    if (!this.interactive) {
      return {
        allowed: false,
        reason: `Permission denied for ${name}: ask mode requires an interactive terminal. Set permissionMode to full to allow unattended tools.`,
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
