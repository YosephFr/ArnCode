import type { Key } from './editor.js';
import type { Theme } from './theme.js';
import { fitWidth } from './text.js';

export interface Choice<T> {
  label: string;
  value: T;
  /** A letter that picks this choice directly. */
  key?: string;
  hint?: string;
}

export type SelectResult<T> = { done: false } | { done: true; value: T | undefined };

/** A short list of choices, picked with arrows, numbers, a letter, or Enter; Esc cancels. */
export class SelectMenu<T> {
  index: number;

  constructor(
    readonly question: string,
    readonly choices: Choice<T>[],
    initial = 0,
  ) {
    this.index = Math.min(Math.max(0, initial), choices.length - 1);
  }

  handle(input: string | undefined, key: Key = {}): SelectResult<T> {
    if (key.name === 'escape' || (key.ctrl && key.name === 'c'))
      return { done: true, value: undefined };
    if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
      this.index = (this.index - 1 + this.choices.length) % this.choices.length;
      return { done: false };
    }
    if (key.name === 'down' || key.name === 'tab' || (key.ctrl && key.name === 'n')) {
      this.index = (this.index + 1) % this.choices.length;
      return { done: false };
    }
    if (key.name === 'return' || key.name === 'enter')
      return { done: true, value: this.choices[this.index]!.value };
    const typed = input?.toLowerCase();
    if (typed && /^[1-9]$/.test(typed) && Number(typed) <= this.choices.length)
      return { done: true, value: this.choices[Number(typed) - 1]!.value };
    const shortcut = this.choices.find((choice) => choice.key && choice.key === typed);
    if (shortcut) return { done: true, value: shortcut.value };
    return { done: false };
  }

  render(width: number, theme: Theme): string[] {
    return [
      fitWidth(theme.strong(this.question), width),
      ...this.choices.map((choice, index) => {
        const selected = index === this.index;
        const label = `${selected ? theme.accent('›') : ' '} ${index + 1}. ${selected ? theme.strong(choice.label) : choice.label}`;
        return fitWidth(choice.hint ? `${label}  ${theme.muted(choice.hint)}` : label, width);
      }),
    ];
  }
}
