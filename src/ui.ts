import { stripVTControlCharacters } from 'node:util';
import { createTwoFilesPatch } from 'diff';
import pc from 'picocolors';
import { redact, StreamingRedactor } from './redact.js';
import type { AgentUI } from './types.js';

export function terminalText(value: string): string {
  return [...stripVTControlCharacters(value)]
    .filter((c) => c === '\n' || c === '\t' || (c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127))
    .join('');
}

export function toolSummary(name: string, input: Record<string, unknown>): string {
  const detail =
    input.command ?? input.path ?? input.file_path ?? input.pattern ?? input.name ?? '';
  const summary = terminalText(redact(`${name} ${String(detail)}`))
    .replace(/\s+/g, ' ')
    .trim();
  return summary.length > 180 ? `${summary.slice(0, 179)}…` : summary;
}

function outputPreview(value: string, maxLines: number, maxChars: number): string {
  const clean = terminalText(redact(value)).trimEnd();
  const lines = clean.split('\n');
  const half = Math.floor(maxLines / 2);
  const selected =
    lines.length > maxLines
      ? [
          ...lines.slice(0, half),
          `… ${lines.length - 2 * half} lines omitted …`,
          ...lines.slice(-half),
        ]
      : lines;
  const preview = selected.join('\n');
  if (preview.length <= maxChars) return preview;
  const room = Math.floor((maxChars - 40) / 2);
  return `${preview.slice(0, room)}\n… output omitted …\n${preview.slice(-room)}`;
}

export function formatToolResult(
  name: string,
  output: string,
  options: { isError?: boolean; durationMs?: number } = {},
): string {
  const duration =
    options.durationMs === undefined ? '' : ` · ${(options.durationMs / 1000).toFixed(1)}s`;
  const header = `${terminalText(redact(name))} ${options.isError ? 'failed' : 'completed'}${duration}`;
  const preview = outputPreview(output, 12, 3000);
  return preview
    ? `${header}\n${preview
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n')}`
    : header;
}

type TerminalOutput = NodeJS.WritableStream & { isTTY?: boolean; columns?: number };

export class TerminalUI implements AgentUI {
  private spinner?: ReturnType<typeof setInterval>;
  private spinnerVisible = false;
  private redactor = new StreamingRedactor();
  private hasText = false;
  private endsWithNewline = true;
  private readonly colors;

  constructor(
    private readonly out: TerminalOutput = process.stdout,
    private readonly err: TerminalOutput = process.stderr,
  ) {
    this.colors = pc.createColors(
      Boolean(err.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb',
    );
  }

  text(value: string): void {
    this.idle();
    const clean = terminalText(this.redactor.write(value));
    if (clean) {
      this.out.write(clean);
      this.hasText = true;
      this.endsWithNewline = clean.endsWith('\n');
    }
  }

  endText(): void {
    const clean = terminalText(this.redactor.flush());
    if (clean) {
      this.out.write(clean);
      this.hasText = true;
      this.endsWithNewline = clean.endsWith('\n');
    }
    if (this.hasText && !this.endsWithNewline) this.out.write('\n');
    this.redactor = new StreamingRedactor();
    this.hasText = false;
    this.endsWithNewline = true;
  }

  status(value: string): void {
    this.idle();
    const started = Date.now();
    const label = terminalText(redact(value)).replace(/\s+/g, ' ').slice(0, 160);
    if (!this.err.isTTY || process.env.TERM === 'dumb') {
      this.spinner = setInterval(() => {
        this.err.write(`${label} · ${Math.floor((Date.now() - started) / 1000)}s elapsed\n`);
      }, 15_000);
      this.spinner.unref();
      return;
    }
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let index = 0;
    const draw = () => {
      const elapsed = ` · ${Math.floor((Date.now() - started) / 1000)}s`;
      const visible = label.slice(0, Math.max(10, (this.err.columns || 80) - elapsed.length - 3));
      this.err.write(
        `\r\u001b[2K${this.colors.cyan(frames[index++ % frames.length] ?? '·')} ${visible}${elapsed}`,
      );
    };
    this.spinnerVisible = true;
    draw();
    this.spinner = setInterval(draw, 100);
    this.spinner.unref();
  }

  idle(): void {
    if (!this.spinner) return;
    clearInterval(this.spinner);
    this.spinner = undefined;
    if (this.spinnerVisible) this.err.write('\r\u001b[2K');
    this.spinnerVisible = false;
  }

  notice(value: string): void {
    this.idle();
    this.endText();
    this.err.write(`${terminalText(redact(value))}\n`);
  }

  tool(name: string, input: Record<string, unknown>): void {
    this.idle();
    this.endText();
    this.err.write(`${this.colors.cyan(toolSummary(name, input))}\n`);
  }

  diff(file: string, before: string, after: string): void {
    this.idle();
    this.endText();
    if (before === after) return;
    if (!before) {
      const lines = after.split('\n').length - (after.endsWith('\n') ? 1 : 0);
      this.notice(
        `${file}: wrote ${lines.toLocaleString()} lines (${Buffer.byteLength(after).toLocaleString()} bytes).`,
      );
      return;
    }
    if (before.length + after.length > 400_000) {
      this.notice(
        `${file}: changed (${before.length.toLocaleString()} → ${after.length.toLocaleString()} characters). Diff omitted for this large file.`,
      );
      return;
    }
    const patch = createTwoFilesPatch(file, file, redact(before), redact(after), '', '', {
      context: 2,
    });
    const preview = outputPreview(patch, 60, 8000);
    for (const line of preview.split('\n')) {
      const color = line.startsWith('+')
        ? this.colors.green
        : line.startsWith('-')
          ? this.colors.red
          : (s: string) => s;
      this.err.write(`${color(line)}\n`);
    }
  }
}
