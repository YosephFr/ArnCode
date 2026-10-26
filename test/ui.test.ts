import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalUI, formatToolResult } from '../src/ui.js';
import { registerSecret } from '../src/redact.js';

function capture() {
  const out = new PassThrough();
  const err = new PassThrough();
  let stdout = '';
  let stderr = '';
  out.setEncoding('utf8').on('data', (text: string) => {
    stdout += text;
  });
  err.setEncoding('utf8').on('data', (text: string) => {
    stderr += text;
  });
  return { ui: new TerminalUI(out, err), stdout: () => stdout, stderr: () => stderr };
}

afterEach(() => vi.useRealTimers());

describe('terminal output', () => {
  it('reports elapsed time in pipes, stops after completion, and keeps stdout clean', () => {
    vi.useFakeTimers();
    const output = capture();
    output.ui.status('Running bash');
    vi.advanceTimersByTime(30_000);
    expect(output.stderr()).toBe('Running bash · 15s elapsed\nRunning bash · 30s elapsed\n');
    output.ui.notice(formatToolResult('bash', 'Exit code: 0\nrender complete'));
    output.ui.text('Video ready.');
    output.ui.endText();
    const finished = output.stderr();
    vi.advanceTimersByTime(30_000);
    expect(output.stderr()).toBe(finished);
    expect(output.stderr()).not.toContain('\u001b');
    expect(output.stdout()).toBe('Video ready.\n');
  });

  it('keeps failure details and the output tail while bounding and redacting previews', () => {
    registerSecret('ui-fixture-private-value');
    const result = formatToolResult(
      'bash',
      [
        'Exit code: 7',
        '\u001b[31mui-fixture-private-value\u001b[0m',
        ...Array.from({ length: 100 }, (_, index) => `frame ${index}: ${'x'.repeat(400)}`),
        'stderr: render failed',
      ].join('\n'),
      { isError: true, durationMs: 2250 },
    );
    expect(result).toContain('bash failed · 2.3s');
    expect(result).toContain('Exit code: 7');
    expect(result).toContain('[redacted]');
    expect(result).toContain('stderr: render failed');
    expect(result).toContain('omitted');
    expect(result).not.toContain('private-value');
    expect(result).not.toContain('\u001b');
    expect(result.length).toBeLessThan(3200);
    expect(result.split('\n').length).toBeLessThan(18);
  });

  it('summarizes new files and keeps useful edit diffs within a terminal-sized preview', () => {
    const output = capture();
    output.ui.diff('render.js', '', 'const particle = 1;\n'.repeat(500));
    expect(output.stderr()).toContain('render.js: wrote 500 lines');
    expect(output.stderr()).not.toContain('const particle');
    output.ui.diff('greeting.txt', 'hello\n', 'hi\n');
    expect(output.stderr()).toContain('-hello');
    expect(output.stderr()).toContain('+hi');
    output.ui.diff('large.txt', 'x'.repeat(100_000), 'y'.repeat(100_000));
    expect(output.stderr().length).toBeLessThan(8500);
    expect(output.stderr()).toContain('omitted');
    expect(output.stdout()).toBe('');
  });
});
