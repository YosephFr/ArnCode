import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { createTwoFilesPatch, structuredPatch } from 'diff';
import pc from 'picocolors';
import { redact, StreamingRedactor } from './redact.js';
import type { InteractiveApp } from './tui/app.js';
import { duration, fitWidth, padVisible, wrapText } from './tui/text.js';
import { themeFor, type Theme } from './tui/theme.js';
import { MarkdownStream, themeStyle } from './tui/markdown.js';
import type { AgentUI, TodoItem } from './types.js';

export function terminalText(value: string): string {
  return [...stripVTControlCharacters(value)]
    .filter((c) => c === '\n' || c === '\t' || (c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127))
    .join('');
}

let displayRoot: string | undefined;

/** Show paths under this directory relative to it, as the agent's own tools do. */
export function setDisplayRoot(directory: string): void {
  displayRoot = directory;
}

function shownPath(value: unknown): unknown {
  if (typeof value !== 'string' || !displayRoot || !path.isAbsolute(value)) return value;
  const relative = path.relative(displayRoot, value);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : value;
}

export function toolSummary(name: string, input: Record<string, unknown>): string {
  const where =
    typeof input.path === 'string' && input.path !== '.' && input.pattern !== undefined
      ? ` in ${String(shownPath(input.path))}`
      : '';
  const detail =
    input.command ??
    (input.pattern === undefined ? undefined : `${String(input.pattern)}${where}`) ??
    shownPath(input.file_path) ??
    shownPath(input.path) ??
    input.url ??
    input.query ??
    input.description ??
    input.name ??
    '';
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

const DISPLAY_NAMES: Record<string, string> = {
  todo_write: 'Todos',
  TodoWrite: 'Todos',
  task: 'Task',
  web_search: 'Web search',
  web_fetch: 'Fetch',
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  list_dir: 'List',
  glob: 'Glob',
  grep: 'Search',
  bash: 'Bash',
  skill: 'Skill',
};

export function displayName(name: string): string {
  const bare = name.replace(/^mcp__arncode__/, '');
  const server = /^mcp__(.+?)__(.+)$/.exec(bare);
  if (server) return `${server[1]}:${server[2]}`;
  return DISPLAY_NAMES[bare] ?? bare;
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
}

/** A short summary of a successful tool result for the interactive transcript. */
export function resultLines(name: string, output: string): string[] {
  const bare = name.replace(/^mcp__arncode__/, '');
  const rows = output.split('\n').filter((line) => line && !/^\[.*\]$/.test(line));
  switch (bare) {
    case 'read_file':
      if (output.startsWith('Image ')) return [output.split('\n')[0]!];
      return [
        output === '[Empty file]'
          ? 'Empty file'
          : plural(rows.filter((line) => /^\d+: /.test(line)).length, 'line'),
      ];
    case 'glob':
    case 'Glob':
      return [rows.length ? plural(rows.length, 'file') : 'No matching files'];
    case 'grep':
    case 'Grep':
      return [rows.length ? plural(rows.length, 'match') : 'No matches'];
    case 'list_dir':
      return [plural(rows.length, 'entry').replace('entrys', 'entries')];
    case 'skill':
      return ['Loaded'];
    case 'bash':
    case 'Bash': {
      const sections = /^([^\n]*)\nstdout:\n([\s\S]*?)\nstderr:\n([\s\S]*)$/.exec(output);
      const status = sections?.[1] ?? '';
      const text = sections
        ? [sections[2], sections[3]].filter((part) => part && part !== '(empty)').join('\n')
        : output;
      const lines = text
        .trimEnd()
        .split('\n')
        .filter((line) => line.trim());
      const tail = lines.slice(-5);
      return [
        ...(lines.length > tail.length
          ? [`… ${plural(lines.length - tail.length, 'more line')}`]
          : []),
        ...tail,
        ...(status && status !== 'Exit code: 0' ? [status] : []),
        ...(!lines.length && (!status || status === 'Exit code: 0') ? ['Done'] : []),
      ];
    }
    default:
      return [];
  }
}

type TerminalOutput = NodeJS.WritableStream & { isTTY?: boolean; columns?: number };

/**
 * Terminal output for the agent. With an interactive app attached, output scrolls above a live
 * footer and gets a structured look; otherwise it is plain text suited to logs and pipes.
 */
export class TerminalUI implements AgentUI {
  private spinner?: ReturnType<typeof setInterval>;
  private spinnerVisible = false;
  private redactor = new StreamingRedactor();
  private hasText = false;
  private endsWithNewline = true;
  private progressOpen = false;
  private colors: ReturnType<typeof pc.createColors>;
  private app?: InteractiveApp;
  private theme: Theme;
  private line = '';
  private progressLine = '';
  private activeTodo?: string;
  private markdown?: MarkdownStream;
  /** The last change shown for approval, so applying it does not print the same diff again. */
  private proposed?: { file: string; after: string };

  constructor(
    private readonly out: TerminalOutput = process.stdout,
    private readonly err: TerminalOutput = process.stderr,
  ) {
    this.theme = themeFor(err);
    this.colors = pc.createColors(this.theme.color);
  }

  attach(app: InteractiveApp, theme: Theme): void {
    this.app = app;
    this.setTheme(theme);
  }

  /** Use another theme from the next line on. */
  setTheme(theme: Theme): void {
    if (this.markdown) this.endText();
    this.theme = theme;
    this.colors = pc.createColors(theme.color);
    if (this.app) this.markdown = new MarkdownStream(themeStyle(theme), () => this.width);
  }

  detach(): void {
    this.endText();
    this.app = undefined;
  }

  private get width(): number {
    return this.app?.screen.width ?? Math.max(20, this.err.columns || 80);
  }

  /** Print lines above the footer, wrapped to the terminal. */
  private emit(text: string, stream: 'ui' | 'content' = 'ui'): void {
    if (!this.app) return;
    const lines = text.split('\n').flatMap((line) => (line ? wrapText(line, this.width) : ['']));
    this.app.print(`${lines.join('\n')}\n`, stream);
  }

  todos(items: TodoItem[]): void {
    this.endText();
    this.endProgress();
    this.activeTodo = items.find((item) => item.status === 'in_progress')?.activeForm;
    if (!items.length) return;
    const rows = items.map((item) => {
      const text = terminalText(redact(item.content));
      if (!this.app)
        return `${item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[>]' : '[ ]'} ${text}`;
      if (item.status === 'completed') return this.theme.muted(`✓ ${text}`);
      if (item.status === 'in_progress')
        return `${this.theme.accent('◐')} ${this.theme.strong(text)}`;
      return `○ ${text}`;
    });
    if (!this.app) {
      this.err.write(`${rows.join('\n')}\n`);
      return;
    }
    this.emit(
      rows
        .map((row, index) => `${index ? '     ' : `  ${this.theme.muted('⎿')}  `}${row}`)
        .join('\n'),
    );
  }

  /** A proposed plan, shown in full before the user approves it. */
  plan(text: string): void {
    this.endText();
    this.endProgress();
    const clean = terminalText(redact(text)).trimEnd();
    if (this.app)
      this.app.print(`\n${this.theme.strong('Plan')}\n${this.markdownRows(clean).join('\n')}\n`);
    else this.err.write(`Plan\n${clean}\n`);
  }

  /** Show part of an earlier exchange when a conversation is resumed. */
  history(role: 'user' | 'assistant', text: string): void {
    if (!this.app) return;
    if (role === 'user') this.user(text);
    else this.app.print(`${this.markdownRows(terminalText(redact(text))).join('\n')}\n`);
  }

  /** Render a complete Markdown text, wrapped to the terminal. */
  private markdownRows(text: string): string[] {
    const markdown = new MarkdownStream(themeStyle(this.theme), () => this.width);
    return [...text.split('\n').flatMap((line) => markdown.line(line)), ...markdown.end()];
  }

  /** Close a turn with its duration and cost, so the result of each request stays visible. */
  turnEnd(milliseconds: number, cost: string, failed: boolean, changedFiles = 0): void {
    if (!this.app) return;
    const mark = failed ? this.theme.error('✗') : this.theme.success('✓');
    const files = changedFiles
      ? ` · ${changedFiles} file${changedFiles === 1 ? '' : 's'} changed`
      : '';
    this.emit(
      `${mark} ${this.theme.muted(`${duration(milliseconds)}${files}${cost ? ` · ${cost}` : ''}`)}`,
    );
  }

  /** Echo the submitted prompt into the transcript on a tinted band. */
  user(text: string): void {
    if (!this.app) return;
    const clean = terminalText(redact(text));
    const rows = clean.split('\n').flatMap((line) => wrapText(line, this.width - 2));
    this.emit(
      [
        '',
        ...rows.map((row, index) =>
          this.theme.surface(
            padVisible(fitWidth(`${index ? '  ' : '› '}${row}`, this.width), this.width),
          ),
        ),
        '',
      ].join('\n'),
    );
  }

  text(value: string): void {
    this.idle();
    this.endProgress();
    const clean = terminalText(this.redactor.write(value));
    if (!clean) return;
    if (!this.app) {
      this.out.write(clean);
      this.hasText = true;
      this.endsWithNewline = clean.endsWith('\n');
      return;
    }
    this.app.countTokens(Math.ceil(clean.length / 4));
    const lines = (this.line + clean).split('\n');
    this.line = lines.pop() ?? '';
    // Finished lines render once as Markdown; the unfinished one stays in the live preview.
    const rows = lines.flatMap((line) => this.markdown!.line(line));
    if (rows.length) this.app.print(`${rows.join('\n')}\n`, 'content');
    const preview = this.markdown!.preview(this.line);
    this.app.setPreview(preview ? preview.split('\n') : []);
    this.hasText = true;
  }

  endText(): void {
    const clean = terminalText(this.redactor.flush());
    this.redactor = new StreamingRedactor();
    if (this.app) {
      const rest = this.line + clean;
      this.line = '';
      const rows = [...(rest ? this.markdown!.line(rest) : []), ...this.markdown!.end()];
      if (rows.length) this.app.print(`${rows.join('\n')}\n`, 'content');
      if (rest || this.hasText) this.app.setPreview([]);
      this.hasText = false;
      return;
    }
    if (clean) {
      this.out.write(clean);
      this.hasText = true;
      this.endsWithNewline = clean.endsWith('\n');
    }
    if (this.hasText && !this.endsWithNewline) this.out.write('\n');
    this.hasText = false;
    this.endsWithNewline = true;
  }

  progress(value: string): void {
    this.idle();
    this.endText();
    const clean = terminalText(redact(value));
    if (!clean) return;
    if (this.app) {
      this.app.countTokens(Math.ceil(clean.length / 4));
      const lines = (this.progressLine + clean).split('\n');
      this.progressLine = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) this.emit(this.theme.muted(line));
      this.app.setPreview(this.progressLine ? [this.theme.muted(this.progressLine)] : []);
      return;
    }
    const lines = clean.split('\n');
    lines.forEach((line, index) => {
      if (index > 0) {
        if (this.progressOpen) this.err.write('\n');
        this.progressOpen = false;
      }
      if (!line) return;
      this.err.write(this.colors.dim(line));
      this.progressOpen = true;
    });
  }

  private endProgress(): void {
    if (this.app) {
      if (this.progressLine.trim()) this.emit(this.theme.muted(this.progressLine));
      if (this.progressLine) this.app.setPreview([]);
      this.progressLine = '';
      return;
    }
    if (!this.progressOpen) return;
    this.err.write('\n');
    this.progressOpen = false;
  }

  status(value: string): void {
    const label = terminalText(redact(value))
      .replace(/\s+/g, ' ')
      .replace(/\b(?:read_file|write_file|edit_file|list_dir|glob|grep|bash|skill)\b/g, displayName)
      .slice(0, 160);
    if (this.app) {
      // While a checklist item is in progress, its wording says more than "Thinking".
      this.app.setBusy(label === 'Thinking' && this.activeTodo ? this.activeTodo : label);
      return;
    }
    this.idle();
    const started = Date.now();
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

  /** Stop the plain-mode spinner. In the interactive app, the turn owner ends the working line. */
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
    this.endProgress();
    const clean = terminalText(redact(value));
    if (this.app) this.emit(this.theme.muted(clean));
    else this.err.write(`${clean}\n`);
  }

  tool(name: string, input: Record<string, unknown>): void {
    this.idle();
    this.endText();
    this.endProgress();
    // The plan itself is shown next, so a line for the tool would only repeat it.
    if (name === 'exit_plan_mode' || name === 'ExitPlanMode') return;
    if (!this.app) {
      this.err.write(`${this.colors.cyan(toolSummary(name, input))}\n`);
      return;
    }
    const summary = toolSummary(displayName(name), input);
    const [label = '', ...rest] = summary.split(' ');
    this.emit(
      fitWidth(
        `${this.theme.accent('●')} ${this.theme.strong(label)}${rest.length ? ` ${this.theme.muted(rest.join(' '))}` : ''}`,
        this.width,
      ),
    );
  }

  toolResult(
    name: string,
    output: string,
    options: { isError?: boolean; durationMs?: number } = {},
  ): void {
    if (!this.app) {
      // Plain output shows shell runs, failures and image reads; other results stay quiet.
      if (name === 'bash' || name === 'Bash' || options.isError)
        this.notice(formatToolResult(name, output, options));
      else if (output.startsWith('Image ')) this.notice(output.split('\n')[0] ?? '');
      return;
    }
    this.endText();
    this.endProgress();
    const seconds =
      options.durationMs === undefined || options.durationMs < 1000
        ? ''
        : ` · ${(options.durationMs / 1000).toFixed(1)}s`;
    const lines = options.isError
      ? outputPreview(output, 12, 2000).split('\n')
      : resultLines(name, terminalText(redact(output)));
    if (!lines.length) return;
    const style = options.isError ? this.theme.error : this.theme.muted;
    this.emit(
      lines
        .map(
          (line, index) =>
            `${index ? '     ' : `  ${this.theme.muted('⎿')}  `}${style(line)}${index === lines.length - 1 ? this.theme.muted(seconds) : ''}`,
        )
        .join('\n'),
    );
  }

  /** Show a change to a file; `proposed` previews one that still awaits approval. */
  diff(file: string, before: string, after: string, options: { proposed?: boolean } = {}): void {
    this.idle();
    this.endText();
    this.endProgress();
    if (before === after) return;
    if (!this.app) {
      this.plainDiff(file, before, after);
      return;
    }
    const name = terminalText(redact(file));
    const verb = options.proposed ? (before ? 'Change to' : 'New file') : 'Updated';
    const seen = this.proposed?.file === file && this.proposed.after === redact(after);
    this.proposed = options.proposed ? { file, after: redact(after) } : undefined;
    if (!before && !options.proposed) {
      const lines = after.split('\n').length - (after.endsWith('\n') ? 1 : 0);
      this.emit(
        `  ${this.theme.muted('⎿')}  Created ${name} ${this.theme.muted(`· ${lines.toLocaleString()} lines`)}`,
      );
      return;
    }
    if (before.length + after.length > 400_000) {
      this.emit(
        `  ${this.theme.muted('⎿')}  ${verb} ${name} ${this.theme.muted('· large file, diff omitted')}`,
      );
      return;
    }
    const patch = structuredPatch(file, file, redact(before), redact(after), '', '', {
      context: 2,
    });
    let added = 0;
    let removed = 0;
    const rows: string[] = [];
    const width = this.width;
    for (const hunk of patch.hunks) {
      if (rows.length) rows.push(this.theme.muted('     …'));
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      for (const raw of hunk.lines) {
        if (raw.startsWith('\\')) continue;
        const sign = raw[0];
        const text = terminalText(raw.slice(1));
        const number = String(sign === '-' ? oldLine : newLine).padStart(5);
        if (sign === '+') {
          added++;
          newLine++;
          rows.push(this.theme.added(padVisible(fitWidth(`${number} + ${text}`, width), width)));
        } else if (sign === '-') {
          removed++;
          oldLine++;
          rows.push(this.theme.removed(padVisible(fitWidth(`${number} - ${text}`, width), width)));
        } else {
          oldLine++;
          newLine++;
          rows.push(this.theme.muted(fitWidth(`${number}   ${text}`, width)));
        }
      }
    }
    const shown = seen
      ? []
      : rows.length > 40
        ? [...rows.slice(0, 40), this.theme.muted(`     … ${rows.length - 40} more lines`)]
        : rows;
    this.app.print(
      `  ${this.theme.muted('⎿')}  ${verb} ${name} ${this.theme.success(`+${added}`)} ${this.theme.error(`-${removed}`)}\n${shown.map((row) => `${row}\n`).join('')}`,
    );
  }

  private plainDiff(file: string, before: string, after: string): void {
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
