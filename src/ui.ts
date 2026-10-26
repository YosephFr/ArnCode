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
  return terminalText(redact(`${name} ${String(detail)}`))
    .replace(/\s+/g, ' ')
    .slice(0, 180)
    .trim();
}

export class TerminalUI implements AgentUI {
  private spinner?: ReturnType<typeof setInterval>;
  private redactor = new StreamingRedactor();
  private hasText = false;
  private endsWithNewline = true;
  private readonly colors;

  constructor(
    private readonly out: NodeJS.WriteStream = process.stdout,
    private readonly err: NodeJS.WriteStream = process.stderr,
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
    if (!this.err.isTTY || process.env.TERM === 'dumb') return;
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const label = terminalText(redact(value))
      .replace(/\s+/g, ' ')
      .slice(0, Math.max(20, (this.err.columns || 80) - 5));
    let index = 0;
    const draw = () =>
      this.err.write(
        `\r\u001b[2K${this.colors.cyan(frames[index++ % frames.length] ?? '·')} ${label}`,
      );
    draw();
    this.spinner = setInterval(draw, 100);
    this.spinner.unref();
  }

  idle(): void {
    if (!this.spinner) return;
    clearInterval(this.spinner);
    this.spinner = undefined;
    this.err.write('\r\u001b[2K');
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
    if (before.length + after.length > 400_000) {
      this.notice(
        `${file}: changed (${before.length.toLocaleString()} → ${after.length.toLocaleString()} characters). Diff omitted for this large file.`,
      );
      return;
    }
    const patch = createTwoFilesPatch(file, file, redact(before), redact(after), '', '', {
      context: 2,
    });
    const lines = terminalText(patch).split('\n');
    for (const line of lines.slice(0, 160)) {
      const color = line.startsWith('+')
        ? this.colors.green
        : line.startsWith('-')
          ? this.colors.red
          : (s: string) => s;
      this.err.write(`${color(line)}\n`);
    }
    if (lines.length > 160) this.err.write(`… ${lines.length - 160} more diff lines\n`);
  }
}
