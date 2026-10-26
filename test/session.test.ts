import { describe, expect, it } from 'vitest';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { apiContext } from '../src/session.js';

describe('context trimming', () => {
  it('bounds a large tool batch while preserving every call/result pair', () => {
    const calls = Array.from({ length: 11 }, (_, i) => ({
      type: 'tool_use' as const,
      id: `call-${i}`,
      name: 'read_file',
      input: { path: `${i}.txt` },
    }));
    const messages: MessageParam[] = [
      { role: 'user', content: 'Inspect the files and fix the error.' },
      { role: 'assistant', content: calls },
      {
        role: 'user',
        content: calls.map((call) => ({
          type: 'tool_result',
          tool_use_id: call.id,
          content: 'x'.repeat(48_000),
        })),
      },
    ];
    const result = apiContext(messages);
    expect(JSON.stringify(result).length).toBeLessThan(500_000);
    expect(result.at(-2)).toEqual(messages[1]);
    const last = result.at(-1);
    expect(
      Array.isArray(last?.content) &&
        last.content.flatMap((b) => (b.type === 'tool_result' ? [b.tool_use_id] : [])),
    ).toEqual(calls.map((c) => c.id));
    expect(JSON.stringify(messages)).not.toContain('Content truncated');
  });

  it('keeps the newest ordinary prompt within the same context limit', () => {
    const result = apiContext([{ role: 'user', content: 'a'.repeat(600_000) }]);
    expect(JSON.stringify(result).length).toBeLessThan(500_000);
    expect(result.every((m) => m.role === 'user')).toBe(true);
    expect(JSON.stringify(result)).toContain('truncated');
  });
});
