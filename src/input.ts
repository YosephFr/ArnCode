import { createInterface, emitKeypressEvents, type Interface, type Key } from 'node:readline';
import { terminalText } from './ui.js';
import { redact } from './redact.js';

/**
 * Read piped input. With `waitMs`, stdin that stays open without sending anything (as under some
 * editors, CI runners and agent harnesses) is skipped after that long instead of blocking forever.
 */
export async function readStdin(
  options: { maxBytes?: number; waitMs?: number; stream?: NodeJS.ReadableStream } = {},
): Promise<{ text: string; skipped: boolean }> {
  const { maxBytes = 2 * 1024 * 1024, waitMs, stream = process.stdin } = options;
  stream.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let input = '';
    let bytes = 0;
    const timer =
      waitMs === undefined
        ? undefined
        : setTimeout(() => {
            cleanup();
            stream.pause();
            resolve({ text: '', skipped: true });
          }, waitMs);
    const onData = (chunk: string | Buffer) => {
      clearTimeout(timer);
      bytes += Buffer.byteLength(String(chunk));
      if (bytes > maxBytes) {
        cleanup();
        reject(new Error(`Input exceeds ${maxBytes} bytes.`));
        return;
      }
      input += String(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve({ text: input.trim(), skipped: false });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
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
    if (!this.interactive) return (await readStdin({ maxBytes: 16384 })).text;
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
