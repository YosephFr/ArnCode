import { createInterface, emitKeypressEvents, type Interface, type Key } from 'node:readline';
import { terminalText } from './ui.js';
import { redact } from './redact.js';

export async function readStdin(maxBytes = 2 * 1024 * 1024): Promise<string> {
  let input = '';
  let bytes = 0;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(String(chunk));
    if (bytes > maxBytes) throw new Error(`Input exceeds ${maxBytes} bytes.`);
    input += String(chunk);
  }
  return input.trim();
}

export class TerminalInput {
  private rl?: Interface;
  private ended = false;
  onInterrupt: () => void = () => this.close();
  readonly interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);

  async question(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
    if (!this.interactive || this.ended || signal?.aborted) return undefined;
    if (!this.rl) {
      this.rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
      this.rl.on('SIGINT', () => this.onInterrupt());
    }
    const rl = this.rl;
    return new Promise((resolve) => {
      const cleanup = () => {
        rl.off('close', closed);
        signal?.removeEventListener('abort', aborted);
      };
      const closed = () => {
        cleanup();
        this.ended = true;
        resolve(undefined);
      };
      const aborted = () => {
        cleanup();
        rl.close();
        this.rl = undefined;
        resolve(undefined);
      };
      rl.once('close', closed);
      signal?.addEventListener('abort', aborted, { once: true });
      rl.question(terminalText(redact(prompt)), (answer) => {
        cleanup();
        resolve(answer);
      });
    });
  }

  async secret(prompt = 'Token: '): Promise<string> {
    if (!this.interactive) return readStdin(16384);
    this.close();
    this.ended = false;
    process.stderr.write(prompt);
    emitKeypressEvents(process.stdin);
    const previousRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    return new Promise((resolve, reject) => {
      let value = '';
      const finish = (error?: Error) => {
        process.stdin.off('keypress', keypress);
        process.stdin.setRawMode(previousRaw);
        process.stdin.pause();
        process.stderr.write('\n');
        if (error) reject(error);
        else resolve(value.trim());
      };
      const keypress = (text: string | undefined, key: Key) => {
        if (key.ctrl && (key.name === 'c' || key.name === 'd'))
          return finish(new Error('Credential input cancelled.'));
        if (key.name === 'return' || key.name === 'enter') return finish();
        if (key.name === 'backspace') {
          value = value.slice(0, -1);
          return;
        }
        if (!key.ctrl && !key.meta && text && [...text].every((c) => c.charCodeAt(0) >= 32)) {
          if (value.length + text.length > 16384)
            return finish(new Error('Credential is too long.'));
          value += text;
        }
      };
      process.stdin.on('keypress', keypress);
    });
  }

  close(): void {
    this.rl?.close();
    this.rl = undefined;
  }
}
