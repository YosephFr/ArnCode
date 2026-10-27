import { LineEditor, listenForKeys, type Key } from './editor.js';
import { Screen, type TerminalStream } from './screen.js';
import { SelectMenu, type Choice } from './select.js';
import { compactNumber, duration, fitWidth } from './text.js';
import type { Theme } from './theme.js';

export interface Suggestion {
  /** Text that replaces the token being completed. */
  value: string;
  label: string;
  hint?: string;
}

export interface AppOptions {
  stdin: NodeJS.ReadStream;
  ui: TerminalStream;
  content: TerminalStream;
  theme: Theme;
  history?: string[];
  placeholder?: string;
  /** Status bar text, already styled; read on every render. */
  status: () => string;
  /** Suggestions for the token before the cursor, or undefined when there is nothing to offer. */
  suggest?: (text: string, cursor: number) => { start: number; items: Suggestion[] } | undefined;
  onInterrupt: () => void;
  onCycleMode: () => void;
  onExit: () => void;
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** The interactive terminal: scrollback above, and a live footer with input and status. */
export class InteractiveApp {
  readonly screen: Screen;
  readonly editor: LineEditor;
  private busy?: { label: string; since: number; tokens: number };
  private frame = 0;
  private timer?: NodeJS.Timeout;
  private preview: string[] = [];
  private queue: string[] = [];
  private waiting?: (value: string | undefined) => void;
  /** Questions waiting for an answer; the first is on screen and the rest wait their turn. */
  private menus: { select: SelectMenu<unknown>; resolve: (value: unknown) => void }[] = [];
  private hint?: { text: string; until: number };
  private exitArmed = 0;
  private suggestions?: { start: number; items: Suggestion[]; index: number };
  private started = false;
  private readonly keyListener = (input: string | undefined, key: Key) => this.onKey(input, key);
  private readonly resizeListener = () => this.render();

  constructor(private readonly options: AppOptions) {
    this.screen = new Screen(options.ui, options.content);
    this.editor = new LineEditor(options.history);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const { stdin } = this.options;
    listenForKeys(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', this.keyListener);
    process.stdout.on('resize', this.resizeListener);
    this.options.ui.write('\u001b[?2004h');
    this.render();
  }

  /** Restyle the footer; scrollback keeps the colors it was printed with. */
  setTheme(theme: Theme): void {
    this.options.theme = theme;
    this.render();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    clearInterval(this.timer);
    this.timer = undefined;
    const { stdin } = this.options;
    stdin.off('keypress', this.keyListener);
    process.stdout.off('resize', this.resizeListener);
    this.screen.clear();
    this.options.ui.write('\u001b[?2004l');
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    this.waiting?.(undefined);
    this.waiting = undefined;
    for (const menu of this.menus.splice(0)) menu.resolve(undefined);
  }

  /** The next prompt: one typed ahead while busy, or the next one the user submits. */
  nextPrompt(): Promise<string | undefined> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      this.render();
      return Promise.resolve(queued);
    }
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  get queued(): number {
    return this.queue.length;
  }

  /** Show the working line; changing the label keeps the elapsed time. */
  setBusy(label: string | undefined): void {
    if (label === undefined) {
      this.busy = undefined;
      clearInterval(this.timer);
      this.timer = undefined;
    } else {
      this.busy = this.busy ? { ...this.busy, label } : { label, since: Date.now(), tokens: 0 };
      this.timer ??= setInterval(() => {
        this.frame++;
        this.render();
      }, 100);
      this.timer.unref();
    }
    this.render();
  }

  isBusy(): boolean {
    return this.busy !== undefined;
  }

  /** Add streamed output tokens to the working line's estimate. */
  countTokens(count: number): void {
    if (this.busy) this.busy.tokens += count;
  }

  setPreview(lines: string[]): void {
    this.preview = lines;
    this.render();
  }

  print(text: string, stream: 'ui' | 'content' = 'ui'): void {
    this.screen.print(text, stream);
  }

  flash(text: string, milliseconds = 2500): void {
    this.hint = { text, until: Date.now() + milliseconds };
    this.render();
    setTimeout(() => this.render(), milliseconds + 10).unref();
  }

  select<T>(
    question: string,
    choices: Choice<T>[],
    initial = 0,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const menu = {
        select: new SelectMenu(question, choices, initial) as SelectMenu<unknown>,
        resolve: (value: unknown) => {
          signal?.removeEventListener('abort', cancel);
          resolve(value as T | undefined);
        },
      };
      const cancel = () => {
        const index = this.menus.indexOf(menu);
        if (index < 0) return;
        this.menus.splice(index, 1);
        menu.resolve(undefined);
        this.render();
      };
      signal?.addEventListener('abort', cancel, { once: true });
      // Parallel tools can ask at once; questions queue so each one gets its own answer.
      this.menus.push(menu);
      this.render();
    });
  }

  private onKey(input: string | undefined, key: Key): void {
    const menu = this.menus[0];
    if (menu) {
      const result = menu.select.handle(input, key);
      if (result.done) {
        this.menus.shift();
        menu.resolve(result.value);
      }
      this.render();
      return;
    }
    const action = this.editor.handle(input, key);
    switch (action) {
      case 'submit': {
        const text = this.editor.value();
        if (!text.trim()) break;
        this.editor.remember(this.editor.text);
        this.editor.clear();
        this.suggestions = undefined;
        if (this.waiting) {
          const resolve = this.waiting;
          this.waiting = undefined;
          resolve(text);
        } else {
          this.queue.push(text);
          this.flash(`Queued; it runs after the current task.`);
        }
        break;
      }
      case 'interrupt':
        if (this.busy) this.options.onInterrupt();
        else if (this.editor.text) this.editor.clear();
        else if (Date.now() < this.exitArmed) this.options.onExit();
        else {
          this.exitArmed = Date.now() + 2000;
          this.flash('Press Ctrl+C again to exit.', 2000);
        }
        break;
      case 'escape':
        if (this.suggestions) this.suggestions = undefined;
        else if (this.busy) this.options.onInterrupt();
        break;
      case 'exit':
        if (!this.busy) this.options.onExit();
        break;
      case 'cycle-mode':
        this.options.onCycleMode();
        break;
      case 'complete':
        this.complete();
        break;
      case 'clear-screen':
        this.options.ui.write('\u001b[2J\u001b[3J\u001b[H');
        break;
    }
    if (action !== 'complete') this.updateSuggestions();
    this.render();
  }

  private updateSuggestions(): void {
    const found = this.options.suggest?.(this.editor.text, this.editor.cursor);
    this.suggestions = found?.items.length ? { ...found, index: 0 } : undefined;
  }

  private complete(): void {
    if (!this.suggestions) this.updateSuggestions();
    const current = this.suggestions;
    if (!current) return;
    const item = current.items[current.index % current.items.length]!;
    const { text, cursor } = this.editor;
    this.editor.text = text.slice(0, current.start) + item.value + text.slice(cursor);
    this.editor.cursor = current.start + item.value.length;
    current.index = (current.index + 1) % current.items.length;
  }

  render(): void {
    if (!this.started) return;
    const { theme } = this.options;
    const width = this.screen.width;
    const lines: string[] = [...this.preview];
    // While a menu waits for an answer, the menu is the only thing that needs attention.
    if (this.busy && !this.menus.length) {
      const elapsed = duration(Date.now() - this.busy.since);
      const tokens = this.busy.tokens ? ` · ↓ ${compactNumber(this.busy.tokens)} tokens` : '';
      lines.push(
        fitWidth(
          `${theme.accent(FRAMES[this.frame % FRAMES.length]!)} ${this.busy.label} ${theme.muted(`· ${elapsed}${tokens} · esc to interrupt`)}`,
          width,
        ),
      );
    }
    lines.push('');
    let cursor: { row: number; column: number } | undefined;
    if (this.menus.length) {
      lines.push(...this.menus[0]!.select.render(width, theme));
    } else {
      const input = this.editor.render(width, theme, {
        placeholder: this.busy ? 'Queue a follow-up' : (this.options.placeholder ?? ''),
      });
      cursor = { row: lines.length + input.cursorRow, column: input.cursorColumn };
      lines.push(...input.lines);
      if (this.suggestions) {
        const { items, index } = this.suggestions;
        const shown = items.slice(0, 6);
        const column = Math.max(...shown.map((item) => item.label.length)) + 2;
        for (const [position, item] of shown.entries()) {
          const active = position === index % items.length;
          const label = item.label.padEnd(column);
          lines.push(
            fitWidth(
              `  ${active ? theme.accent(label) : label}${item.hint ? theme.muted(item.hint) : ''}`,
              width,
            ),
          );
        }
      }
    }
    const hint = this.hint && Date.now() < this.hint.until ? this.hint.text : undefined;
    const queued = this.queue.length ? `${this.queue.length} queued · ` : '';
    lines.push(fitWidth(theme.muted(`  ${hint ?? `${queued}${this.options.status()}`}`), width));
    this.screen.set(lines, cursor);
  }
}
