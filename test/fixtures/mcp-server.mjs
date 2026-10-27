// A minimal stdio MCP server for tests: one text tool and one that fails.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fixture', version: '1.0.0' });
server.registerTool(
  'echo',
  { description: 'Repeat a message.', inputSchema: { message: z.string() } },
  async ({ message }) => ({ content: [{ type: 'text', text: `echo: ${message}` }] }),
);
server.registerTool('fail', { description: 'Always fails.', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: 'it broke' }],
  isError: true,
}));
await server.connect(new StdioServerTransport());
