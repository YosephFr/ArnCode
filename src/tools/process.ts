import { spawn } from 'node:child_process';
import { StreamingRedactor } from '../redact.js';

const OUTPUT_LIMIT = 24_000;

export interface ProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  input?: string;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
}

class OutputBuffer {
  private head = '';
  private tail = '';
  private total = 0;

  append(chunk: string): void {
    this.total += chunk.length;
    const remaining = Math.max(0, OUTPUT_LIMIT / 2 - this.head.length);
    this.head += chunk.slice(0, remaining);
    this.tail = (this.tail + chunk.slice(remaining)).slice(-OUTPUT_LIMIT / 2);
  }

  toString(): string {
    const omitted = this.total - this.head.length - this.tail.length;
    return this.head + (omitted ? `\n[Truncated ${omitted} output characters]\n` : '') + this.tail;
  }
}

export function runProcess(options: ProcessOptions): Promise<ProcessResult> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      detached: grouped,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = new OutputBuffer();
    const stderr = new OutputBuffer();
    const stdoutRedactor = new StreamingRedactor();
    const stderrRedactor = new StreamingRedactor();
    let timedOut = false;
    let aborted = false;
    let exited = false;
    let killing = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;

    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, signal);
        else if (!exited) child.kill(signal);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
          stderr.append(
            `\nCould not stop process: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      kill('SIGKILL');
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      stdout.append(stdoutRedactor.flush());
      stderr.append(stderrRedactor.flush());
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode,
        signal: exitSignal,
        timedOut,
        aborted,
      });
    };
    const stop = () => {
      if (killing) return;
      killing = true;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 250);
      drainTimer = setTimeout(finish, 1500);
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => stdout.append(stdoutRedactor.write(chunk)));
    child.stderr?.on('data', (chunk: string) => stderr.append(stderrRedactor.write(chunk)));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      // A shell may exit while background descendants still hold its pipes.
      stop();
    });
    child.on('close', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      finish();
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    if (options.input !== undefined && child.stdin) {
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') stderr.append(error.message);
      });
      child.stdin.end(options.input);
    }
  });
}
