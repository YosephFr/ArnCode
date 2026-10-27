import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { z } from 'zod';
import { prepareImage } from './images.js';
import { redact, registerServerSecrets } from './redact.js';
import type { ToolContent, ToolResult } from './tools/index.js';

const stdioServer = z
  .object({
    type: z.literal('stdio').optional(),
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(4096)).max(100).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();
const remoteServer = z
  .object({
    type: z.enum(['http', 'sse']),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/** Servers in the `mcpServers` format Claude Code uses. */
export const mcpServersSchema = z.record(
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/),
  z.union([stdioServer, remoteServer]),
);
export type McpServers = z.infer<typeof mcpServersSchema>;
type McpServer = McpServers[string];

const START_TIMEOUT = 30_000;
const CALL_TIMEOUT = 10 * 60_000;
const MAX_TEXT = 40_000;

interface Connection {
  server: string;
  close(): Promise<void>;
  call(tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
  tools: { name: string; tool: string; description: string; schema: BetaTool.InputSchema }[];
}

export interface McpStatus {
  server: string;
  tools: number;
  error?: string;
}

/** Tools from connected MCP servers, exposed to the model as `mcp__server__tool`. */
export interface McpTools {
  definitions: BetaTool[];
  status: McpStatus[];
  has(name: string): boolean;
  call(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function connect(server: string, config: McpServer, cwd: string): Promise<Connection> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  registerServerSecrets(
    'env' in config ? config.env : undefined,
    'headers' in config ? config.headers : undefined,
  );
  let transport;
  if ('command' in config) {
    const { StdioClientTransport, getDefaultEnvironment } =
      await import('@modelcontextprotocol/sdk/client/stdio.js');
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
      cwd,
      stderr: 'ignore',
    });
  } else if (config.type === 'sse') {
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    transport = new SSEClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers ?? {} },
    });
  } else {
    const { StreamableHTTPClientTransport } =
      await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers ?? {} },
    });
  }
  const client = new Client({ name: 'arncode', version: '0.1.0' }, { capabilities: {} });
  await withTimeout(client.connect(transport), START_TIMEOUT, `${server} did not start in time.`);
  const { tools } = await withTimeout(
    client.listTools(),
    START_TIMEOUT,
    `${server} did not list its tools in time.`,
  );
  return {
    server,
    close: () => client.close(),
    tools: tools.map((tool) => ({
      name: mcpToolName(server, tool.name),
      tool: tool.name,
      description: (tool.description ?? `${tool.name} from the ${server} server.`).slice(0, 4000),
      schema: { ...tool.inputSchema, type: 'object' } as BetaTool.InputSchema,
    })),
    async call(tool, input, signal) {
      const result = await client.callTool({ name: tool, arguments: input }, undefined, {
        signal,
        timeout: CALL_TIMEOUT,
      });
      const content: ToolContent[] = [];
      for (const part of (result.content ?? []) as Record<string, unknown>[]) {
        if (part.type === 'text' && typeof part.text === 'string')
          content.push({ type: 'text', text: redact(part.text).slice(0, MAX_TEXT) });
        else if (part.type === 'image' && typeof part.data === 'string') {
          try {
            content.push({ type: 'image', image: prepareImage(Buffer.from(part.data, 'base64')) });
          } catch (error) {
            content.push({
              type: 'text',
              text: `[Image omitted: ${error instanceof Error ? error.message : String(error)}]`,
            });
          }
        } else if (part.type === 'resource') {
          const resource = (part.resource ?? {}) as Record<string, unknown>;
          if (typeof resource.text === 'string')
            content.push({ type: 'text', text: redact(resource.text).slice(0, MAX_TEXT) });
        }
      }
      if (!content.length) content.push({ type: 'text', text: '[No output]' });
      return {
        content: content.length === 1 && content[0]!.type === 'text' ? content[0]!.text : content,
        ...(result.isError ? { is_error: true } : {}),
      };
    },
  };
}

// One connection per server and configuration for the life of the process.
const connections = new Map<string, Promise<Connection>>();

/** Connect the configured servers, reusing open connections; failures are reported, not fatal. */
export async function connectMcp(servers: McpServers | undefined, cwd: string): Promise<McpTools> {
  const entries = Object.entries(servers ?? {});
  const results = await Promise.all(
    entries.map(async ([server, config]) => {
      const key = `${server}\0${JSON.stringify(config)}`;
      if (!connections.has(key)) {
        const pending = connect(server, config, cwd);
        // A server that failed to start stays failed for this process instead of delaying turns.
        pending.catch(() => undefined);
        connections.set(key, pending);
      }
      try {
        return { server, connection: await connections.get(key)! };
      } catch (error) {
        return {
          server,
          error: redact(error instanceof Error ? error.message : String(error)).slice(0, 300),
        };
      }
    }),
  );
  const byName = new Map<string, { connection: Connection; tool: string }>();
  const definitions: BetaTool[] = [];
  for (const result of results) {
    if (!result.connection) continue;
    for (const tool of result.connection.tools) {
      if (byName.has(tool.name)) continue;
      byName.set(tool.name, { connection: result.connection, tool: tool.tool });
      definitions.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.schema,
      });
    }
  }
  return {
    definitions,
    status: results.map((result) => ({
      server: result.server,
      tools: result.connection?.tools.length ?? 0,
      ...(result.error ? { error: result.error } : {}),
    })),
    has: (name) => byName.has(name),
    call: (name, input, signal) => {
      const target = byName.get(name)!;
      return target.connection.call(target.tool, input, signal);
    },
  };
}

/** Close every open server connection. */
export async function closeMcp(): Promise<void> {
  const pending = [...connections.values()];
  connections.clear();
  await Promise.allSettled(pending.map(async (connection) => (await connection).close()));
}
