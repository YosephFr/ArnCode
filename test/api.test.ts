import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { describe, expect, it } from 'vitest';
import { cacheConversation } from '../src/engines/api.js';

describe('incremental API prompt caching', () => {
  it('marks a plain user prompt without changing the saved conversation', () => {
    const messages: MessageParam[] = [{ role: 'user', content: 'Inspect the project.' }];
    expect(cacheConversation(messages)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect the project.', cache_control: { type: 'ephemeral' } },
        ],
      },
    ]);
    expect(messages).toEqual([{ role: 'user', content: 'Inspect the project.' }]);
  });

  it('moves the breakpoint to the final tool result without accumulating old marks', () => {
    const messages: MessageParam[] = [
      ...cacheConversation([{ role: 'user', content: 'Inspect both files.' }]),
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Preserved thinking.', signature: 'signature' },
          { type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'a.txt' } },
          { type: 'tool_use', id: 'b', name: 'read_file', input: { path: 'b.txt' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'alpha' },
          { type: 'tool_result', tool_use_id: 'b', content: 'beta', is_error: true },
        ],
      },
    ];
    const before = JSON.stringify(messages);
    const cached = cacheConversation(messages);
    expect(cached.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'alpha' },
        {
          type: 'tool_result',
          tool_use_id: 'b',
          content: 'beta',
          is_error: true,
          cache_control: { type: 'ephemeral' },
        },
      ],
    });
    expect(cached[1]).toEqual(messages[1]);
    expect(JSON.stringify(cached).match(/"cache_control":/g)).toHaveLength(1);
    expect(JSON.stringify(messages)).toBe(before);
    expect(cacheConversation(cached)).toEqual(cached);
    const next = cacheConversation([
      ...cached,
      { role: 'assistant', content: 'Found it.' },
      { role: 'user', content: 'Fix it.' },
    ]);
    expect(JSON.stringify(next).match(/"cache_control":/g)).toHaveLength(1);
    expect(next.at(-1)).toMatchObject({
      content: [{ text: 'Fix it.', cache_control: { type: 'ephemeral' } }],
    });
  });
});
