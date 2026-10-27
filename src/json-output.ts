import { structuredPatch } from 'diff';
import { redact } from './redact.js';
import type { Session } from './session.js';
import type { AgentUI } from './types.js';
import type { UsageTotals } from './usage.js';

export type OutputFormat = 'text' | 'json' | 'stream-json';

type Emit = (event: Record<string, unknown>) => void;

/**
 * Machine-readable output for scripts: `json` prints one result object at the end; `stream-json`
 * prints one event per line as the run happens and the same result object last.
 */
export class JsonUI implements AgentUI {
  private buffer = '';
  private reply = '';
  private progressText = '';

  constructor(
    private readonly format: Exclude<OutputFormat, 'text'>,
    private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {}

  private emit: Emit = (event) => {
    if (this.format === 'stream-json') this.write(JSON.stringify(event));
  };

  text(value: string): void {
    this.buffer += value;
  }

  endText(): void {
    if (!this.buffer) return;
    const text = redact(this.buffer);
    this.buffer = '';
    this.reply = text;
    this.emit({ type: 'text', text });
  }

  progress(value: string): void {
    this.progressText += value;
    if (!value.includes('\n')) return;
    const note = this.progressText.trim();
    this.progressText = '';
    if (note) this.emit({ type: 'progress', text: redact(note) });
  }

  status(): void {}

  idle(): void {}

  notice(value: string): void {
    this.emit({ type: 'notice', text: redact(value) });
  }

  tool(name: string, input: Record<string, unknown>): void {
    this.endText();
    this.emit({ type: 'tool_use', name, input: JSON.parse(redact(JSON.stringify(input))) });
  }

  toolResult(
    name: string,
    output: string,
    options: { isError?: boolean; durationMs?: number } = {},
  ): void {
    this.emit({
      type: 'tool_result',
      name,
      is_error: Boolean(options.isError),
      duration_ms: options.durationMs ?? null,
      output: redact(output).slice(0, 4000),
    });
  }

  diff(path: string, before: string, after: string): void {
    let added = 0;
    let removed = 0;
    for (const hunk of structuredPatch(path, path, before, after).hunks)
      for (const line of hunk.lines) {
        if (line.startsWith('+')) added++;
        else if (line.startsWith('-')) removed++;
      }
    this.emit({ type: 'file_change', path, created: !before, added, removed });
  }

  init(session: Session, settings: { cwd: string; permissionMode: string }): void {
    this.emit({
      type: 'init',
      session_id: session.id,
      model: session.model,
      cwd: settings.cwd,
      permission_mode: settings.permissionMode,
    });
  }

  /** The closing object, in both formats: the final reply, usage and outcome. */
  result(
    session: Session,
    turn: UsageTotals,
    outcome: { durationMs: number; error?: string; interrupted?: boolean },
  ): void {
    this.endText();
    const event = {
      type: 'result',
      subtype: outcome.interrupted ? 'interrupted' : outcome.error ? 'error' : 'success',
      is_error: Boolean(outcome.error || outcome.interrupted),
      result: outcome.error ? redact(outcome.error) : this.reply,
      session_id: session.id,
      model: session.model,
      credential: session.credential ?? null,
      duration_ms: Math.round(outcome.durationMs),
      num_turns: turn.requests,
      total_cost_usd: turn.unpricedRequests >= turn.requests ? null : turn.costUsd,
      usage: {
        input_tokens: turn.inputTokens,
        output_tokens: turn.outputTokens,
        cache_read_input_tokens: turn.cacheReadTokens,
        cache_creation_input_tokens: turn.cacheWriteTokens,
      },
    };
    this.write(JSON.stringify(event));
  }
}
