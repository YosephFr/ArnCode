import type {
  BetaContentBlock,
  BetaMessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../src/config.js';
import {
  apiMode,
  apiRequest,
  cacheConversation,
  historyContent,
  toolGroups,
} from '../src/engines/api.js';
import { newSession } from '../src/session.js';
import type { Settings } from '../src/types.js';

function setup(overrides: Partial<Settings> = {}, messages: BetaMessageParam[] = []) {
  const settings: Settings = { ...DEFAULTS, cwd: '/project', ...overrides };
  const session = newSession(settings);
  session.api = { system: 'Frozen system prompt.', effort: 'medium' };
  session.messages = messages.length ? messages : [{ role: 'user', content: 'Inspect it.' }];
  return { settings, session };
}

function markers(value: unknown): number {
  return JSON.stringify(value).match(/"cache_control":/g)?.length ?? 0;
}

describe('API request shape', () => {
  it('selects full features only for the official endpoint unless overridden', () => {
    expect(apiMode({}, {})).toBe('full');
    expect(apiMode({ baseUrl: 'https://api.anthropic.com' }, {})).toBe('full');
    expect(apiMode({ baseUrl: 'http://127.0.0.1:9000' }, {})).toBe('basic');
    expect(apiMode({ baseUrl: 'http://127.0.0.1:9000' }, { ARNCODE_API_FEATURES: 'full' })).toBe(
      'full',
    );
    expect(apiMode({}, { ARNCODE_API_FEATURES: 'basic' })).toBe('basic');
  });

  it('keeps thinking valid, streams progress notes and opts into refusal fallback', () => {
    const { settings, session } = setup();
    const request = apiRequest(settings, session, 'full');
    expect(request).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 64000,
      thinking: {
        type: 'adaptive',
        display: 'updates',
        block_binding: { prefix_mismatch_behavior: 'drop_block' },
      },
      output_config: { effort: 'medium' },
      fallbacks: 'default',
      system: [
        { type: 'text', text: 'Frozen system prompt.', cache_control: { type: 'ephemeral' } },
      ],
    });
    expect(request.betas).toEqual([
      'thinking-display-updates-2026-08-18',
      'thinking-binding-controls-2026-08-01',
      'server-side-fallback-2026-07-01',
    ]);
    expect(request.tools?.every((tool) => 'eager_input_streaming' in tool)).toBe(true);
    expect(markers(request)).toBe(3);
    expect(request).not.toHaveProperty('speed');
    expect(request).not.toHaveProperty('compaction');
  });

  it('sends only compatible fields to other endpoints', () => {
    const { settings, session } = setup({ fast: true });
    const request = apiRequest(settings, session, 'basic');
    expect(request.thinking).toEqual({ type: 'adaptive' });
    expect(request.betas).toEqual(['fast-mode-2026-02-01']);
    expect(request.speed).toBe('fast');
    expect(request).not.toHaveProperty('fallbacks');
    expect(request.tools?.some((tool) => 'eager_input_streaming' in tool)).toBe(false);
  });

  it('adapts thinking, effort and fast mode to the model', () => {
    const haiku = setup({ model: 'claude-haiku-4-5', fast: true });
    const request = apiRequest(haiku.settings, haiku.session, 'full');
    expect(request).not.toHaveProperty('thinking');
    expect(request).not.toHaveProperty('output_config');
    expect(request).not.toHaveProperty('speed');
    expect(request).not.toHaveProperty('fallbacks');
    const sonnet = setup({ model: 'claude-sonnet-4-6' });
    sonnet.session.api = { system: 'x', effort: 'xhigh' };
    expect(apiRequest(sonnet.settings, sonnet.session, 'full').output_config).toEqual({
      effort: 'high',
    });
  });

  it('declares the betas carried by history: compaction blocks and effort messages', () => {
    const { settings, session } = setup({}, [
      {
        role: 'assistant',
        content: [{ type: 'compaction', content: 'Summary.', signature: 'sig' }],
      },
      { role: 'system', content: [], output_config: { effort: 'high' } },
      { role: 'user', content: 'Continue.' },
    ]);
    const request = apiRequest(settings, session, 'full');
    expect(request.betas).toContain('compact-2026-09-04');
    expect(request.betas).toContain('mid-conversation-output-config-2026-07-01');
    expect(request.messages[1]).toEqual({
      role: 'system',
      content: [],
      output_config: { effort: 'high' },
    });
  });

  it('requests a summary without fallbacks and within a bounded output', () => {
    const { settings, session } = setup();
    const request = apiRequest(settings, session, 'full', { compaction: true });
    expect(request.compaction).toEqual({ type: 'summarize' });
    expect(request.max_tokens).toBe(32000);
    expect(request.betas).toContain('compact-2026-09-04');
    expect(request).not.toHaveProperty('fallbacks');
  });

  it('never truncates full-mode history but bounds compatible endpoints', () => {
    const huge = 'x'.repeat(600_000);
    const messages: BetaMessageParam[] = [
      { role: 'user', content: huge },
      { role: 'assistant', content: 'Read.' },
      { role: 'user', content: 'Next.' },
    ];
    const full = setup({}, messages);
    expect(JSON.stringify(apiRequest(full.settings, full.session, 'full').messages)).toContain(
      huge,
    );
    const basic = setup({}, messages);
    expect(
      JSON.stringify(apiRequest(basic.settings, basic.session, 'basic').messages).length,
    ).toBeLessThan(500_000);
  });
});

describe('response history', () => {
  it('drops the declining model’s thinking and unanswered calls before a fallback', () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 'a' },
      { type: 'text', text: 'Partial answer.', citations: null },
      { type: 'tool_use', id: 'dropped', name: 'read_file', input: { path: 'x' } },
      {
        type: 'fallback',
        from: { model: 'claude-opus-5-5' },
        to: { model: 'claude-opus-5' },
        trigger: { type: 'refusal' },
      },
      { type: 'thinking', thinking: '', signature: 'b' },
      { type: 'tool_use', id: 'kept', name: 'read_file', input: { path: 'y' } },
    ] as unknown as BetaContentBlock[];
    expect(historyContent(content).map((block) => block.type)).toEqual([
      'text',
      'fallback',
      'thinking',
      'tool_use',
    ]);
    expect(JSON.stringify(historyContent(content))).not.toContain('dropped');
    const plain = [{ type: 'text', text: 'Done.', citations: null }] as BetaContentBlock[];
    expect(historyContent(plain)).toEqual(plain);
  });

  it('runs consecutive read-only calls together and keeps mutations in order', () => {
    const calls = ['read_file', 'grep', 'write_file', 'glob', 'read_file', 'bash'].map((name) => ({
      name,
    }));
    expect(toolGroups(calls).map((group) => group.map((call) => call.name))).toEqual([
      ['read_file', 'grep'],
      ['write_file'],
      ['glob', 'read_file'],
      ['bash'],
    ]);
  });
});

describe('incremental API prompt caching', () => {
  it('marks a plain user prompt without changing the saved conversation', () => {
    const messages: BetaMessageParam[] = [{ role: 'user', content: 'Inspect the project.' }];
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
    const messages: BetaMessageParam[] = [
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
    expect(markers(cached)).toBe(1);
    expect(JSON.stringify(messages)).toBe(before);
    expect(cacheConversation(cached)).toEqual(cached);
    const next = cacheConversation([
      ...cached,
      { role: 'assistant', content: 'Found it.' },
      { role: 'user', content: 'Fix it.' },
    ]);
    expect(markers(next)).toBe(1);
    expect(next.at(-1)).toMatchObject({
      content: [{ text: 'Fix it.', cache_control: { type: 'ephemeral' } }],
    });
  });
});
