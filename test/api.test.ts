import type {
  BetaContentBlock,
  BetaMessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULTS } from '../src/config.js';
import {
  apiMode,
  apiRequest,
  cacheConversation,
  historyContent,
  keepCacheWarm,
  toolGroups,
} from '../src/engines/api.js';
import type { EngineContext } from '../src/engines/types.js';
import { newSession } from '../src/session.js';
import type { Settings } from '../src/types.js';
import { modelEffort } from '../src/models.js';

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

describe('model switches', () => {
  it('turns system messages into reminders for a model that does not take them', () => {
    const history: BetaMessageParam[] = [
      { role: 'user', content: 'Plan it.' },
      { role: 'system', content: 'Plan mode is on.' },
      { role: 'assistant', content: [{ type: 'text', text: 'Planned.' }] },
      { role: 'system', content: [], output_config: { effort: 'high' } },
      { role: 'user', content: 'Go.' },
    ];
    const { settings, session } = setup({}, history);
    // Opus 5.5 takes both kinds as they are.
    expect(apiRequest(settings, session, 'full').messages.map((m) => m.role)).toEqual([
      'user',
      'system',
      'assistant',
      'system',
      'user',
    ]);
    const older = apiRequest({ ...settings, model: 'claude-sonnet-4-6' }, session, 'full');
    expect(older.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(older.messages[0])).toContain(
      '<system-reminder>Plan mode is on.</system-reminder>',
    );
    expect(older.betas ?? []).not.toContain('mid-conversation-output-config-2026-07-01');
    // The saved history keeps its original shape for when the model changes back.
    expect(session.messages).toHaveLength(5);
    // The effort set by that dropped message still applies, at the top level.
    session.api = { ...session.api!, effort: 'max', messageEffort: 'high' };
    expect(
      apiRequest({ ...settings, model: 'claude-sonnet-4-6' }, session, 'full').output_config,
    ).toEqual({
      effort: modelEffort('claude-sonnet-4-6', 'high'),
    });
    expect(apiRequest(settings, session, 'full').output_config).toEqual({ effort: 'max' });
  });
});

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
    const [search, fetch, ...client] = request.tools ?? [];
    expect(search).toMatchObject({ type: 'web_search_20260209', name: 'web_search', max_uses: 5 });
    expect(fetch).toMatchObject({ type: 'web_fetch_20260209', name: 'web_fetch' });
    expect(client.every((tool) => 'eager_input_streaming' in tool)).toBe(true);
    expect(client.at(-1)).toMatchObject({ cache_control: { type: 'ephemeral' } });
    expect(markers(request)).toBe(3);
    expect(request).not.toHaveProperty('speed');
    expect(request).not.toHaveProperty('compaction');
  });

  it('leaves out web tools when disabled, for subagents and on unsupported models', () => {
    const off = setup({ webTools: false });
    expect(JSON.stringify(apiRequest(off.settings, off.session, 'full').tools)).not.toContain(
      'web_search',
    );
    const haiku = setup({ model: 'claude-haiku-5-5' });
    expect(JSON.stringify(apiRequest(haiku.settings, haiku.session, 'full').tools)).not.toContain(
      'web_search',
    );
    const explorer = setup();
    explorer.session.api = { system: 'x', effort: 'low', tools: ['read_file', 'grep'] };
    expect(
      apiRequest(explorer.settings, explorer.session, 'full').tools?.map(
        (tool) => (tool as { name: string }).name,
      ),
    ).toEqual(['read_file', 'grep']);
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
    expect(request.compaction).toMatchObject({ type: 'summarize' });
    expect(request.compaction?.instructions).toContain('## Next move');
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

describe('cache keep-alive', () => {
  it('refreshes the cached prefix while tools run and stops afterwards', async () => {
    vi.useFakeTimers();
    try {
      const create = vi.fn(async (_params: Record<string, unknown>) => ({
        model: 'claude-opus-5-5',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 90_000 },
      }));
      const onUsage = vi.fn(async () => {});
      const ctx = {
        onRequest: vi.fn(async () => {}),
        onUsage,
        signal: new AbortController().signal,
        settings: { ...DEFAULTS, cwd: '/project' },
      } as unknown as EngineContext;
      const client = { beta: { messages: { create } } } as unknown as Anthropic;
      const { settings, session } = setup();
      const params = apiRequest(settings, session, 'full');
      const stop = keepCacheWarm(ctx, client, 'full', params);
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(create).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0]![0]).toMatchObject({ max_tokens: 0, stream: false });
      expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ cacheReadTokens: 90_000 }));
      stop();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(create).toHaveBeenCalledTimes(1);
      expect(keepCacheWarm(ctx, client, 'basic', params)).toBeTypeOf('function');
    } finally {
      vi.useRealTimers();
    }
  });
});
