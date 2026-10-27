import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { closeMcp, connectMcp, mcpToolName } from '../src/mcp.js';

const fixture = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));

afterAll(() => closeMcp());

describe('MCP servers', () => {
  it('lists tools under prefixed names and calls them', async () => {
    const mcp = await connectMcp(
      { fixture: { command: process.execPath, args: [fixture] }, broken: { command: 'false' } },
      root,
    );
    expect(mcp.definitions.map((tool) => tool.name).sort()).toEqual([
      'mcp__fixture__echo',
      'mcp__fixture__fail',
    ]);
    expect(mcp.definitions[0]!.input_schema).toMatchObject({ type: 'object' });
    expect(mcp.status.find((status) => status.server === 'fixture')).toEqual({
      server: 'fixture',
      tools: 2,
    });
    expect(mcp.status.find((status) => status.server === 'broken')?.error).toBeTruthy();
    expect(await mcp.call('mcp__fixture__echo', { message: 'hi' })).toEqual({
      content: 'echo: hi',
    });
    expect(await mcp.call('mcp__fixture__fail', {})).toEqual({
      content: 'it broke',
      is_error: true,
    });
    expect(mcp.has('mcp__fixture__echo')).toBe(true);
    expect(mcpToolName('my.server', 'do thing')).toBe('mcp__my_server__do_thing');
  }, 30_000);
});
