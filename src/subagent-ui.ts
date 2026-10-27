import { toolSummary, displayName } from './ui.js';
import type { AgentUI } from './types.js';

/**
 * What a subagent shows of its work: one labeled line per tool call, failures and file changes.
 * Its own text and progress notes stay private; only the final report returns to the parent.
 */
export class SubagentUI implements AgentUI {
  calls = 0;

  constructor(
    private readonly parent: AgentUI,
    private readonly label: string,
  ) {}

  text(): void {}
  endText(): void {}
  progress(): void {}
  status(): void {}
  idle(): void {}

  notice(value: string): void {
    this.parent.notice(`${this.label} · ${value}`);
  }

  tool(name: string, input: Record<string, unknown>): void {
    this.calls++;
    this.parent.notice(`${this.label} · ${toolSummary(displayName(name), input)}`);
  }

  toolResult(
    name: string,
    output: string,
    options: { isError?: boolean; durationMs?: number } = {},
  ): void {
    if (options.isError)
      this.parent.toolResult(`${this.label} · ${displayName(name)}`, output, options);
  }

  diff(path: string, before: string, after: string): void {
    this.parent.diff(path, before, after);
  }
}
