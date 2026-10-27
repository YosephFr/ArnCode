import { spawn, type ChildProcess } from 'node:child_process';
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  MessageCreateParamsStreaming,
  RawMessageStreamEvent,
  StopReason,
} from '@anthropic-ai/sdk/resources/messages';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type MockBlock =
  | { type: 'text'; text: string[] }
  | { type: 'thinking'; text?: string }
  | { type: 'tool'; name: string; id: string; input: Record<string, unknown> }
  | { type: 'fallback'; from: string; to: string }
  | { type: 'compaction'; content: string };

interface Reply {
  text?: string[];
  tool?: { name: string; id: string; input: Record<string, unknown> };
  blocks?: MockBlock[];
  stop?: StopReason | 'compaction';
  stopDetails?: { category: 'cyber' | 'bio' | null; explanation: string | null };
  inputTokens?: number;
}
interface CapturedRequest {
  url?: string;
  headers: IncomingHttpHeaders;
  body: MessageCreateParamsStreaming;
}

const repository = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(repository, 'src/cli.ts');
let temporary: string;
let project: string;
let config: string;
const servers = new Set<Server>();
const children = new Set<ChildProcess>();

beforeEach(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), 'arncode-cli-'));
  project = path.join(temporary, 'project');
  config = path.join(temporary, 'state');
  await mkdir(project);
});

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  servers.clear();
  await rm(temporary, { recursive: true, force: true });
});

function streamReply(
  response: ServerResponse,
  reply: Reply,
  index: number,
  body: MessageCreateParamsStreaming,
): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const emit = (event: RawMessageStreamEvent) =>
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  emit({
    type: 'message_start',
    message: {
      id: `message_${index}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [],
      container: null,
      diagnostics: null,
      stop_details: null,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 40,
        output_tokens: 0,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 },
        inference_geo: null,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: 'standard',
        speed: body.speed ?? 'standard',
      },
    },
  });
  const blocks: MockBlock[] =
    reply.blocks ??
    (reply.tool ? [{ type: 'tool', ...reply.tool }] : [{ type: 'text', text: reply.text ?? [] }]);
  const raw = (event: Record<string, unknown>) =>
    response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
  blocks.forEach((block, index) => {
    if (block.type === 'tool') {
      emit({
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {},
          caller: { type: 'direct' },
        },
      });
      emit({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
    } else if (block.type === 'thinking') {
      raw({
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      });
      if (block.text)
        raw({
          type: 'content_block_delta',
          index,
          delta: { type: 'thinking_delta', thinking: block.text },
        });
      raw({
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: `signature-${index}` },
      });
    } else if (block.type === 'fallback') {
      raw({
        type: 'content_block_start',
        index,
        content_block: {
          type: 'fallback',
          from: { model: block.from },
          to: { model: block.to },
          trigger: { type: 'refusal' },
        },
      });
    } else if (block.type === 'compaction') {
      raw({
        type: 'content_block_start',
        index,
        content_block: {
          type: 'compaction',
          content: block.content,
          encrypted_content: null,
          signature: 'compaction-signature',
        },
      });
    } else {
      emit({
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '', citations: null },
      });
      for (const text of block.text) {
        emit({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
      }
    }
    emit({ type: 'content_block_stop', index });
  });
  emit({
    type: 'message_delta',
    delta: {
      stop_reason: (reply.stop ??
        (blocks.some((block) => block.type === 'tool') ? 'tool_use' : 'end_turn')) as StopReason,
      stop_sequence: null,
      stop_details: reply.stopDetails ? { type: 'refusal', ...reply.stopDetails } : null,
      container: null,
    },
    usage: {
      input_tokens: reply.inputTokens ?? 40,
      output_tokens: 12,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 20,
      output_tokens_details: null,
      server_tool_use: null,
    },
  });
  emit({ type: 'message_stop' });
  response.end();
}

async function mockAPI(replies: Reply[]): Promise<{ url: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request)
        raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const body = JSON.parse(raw) as MessageCreateParamsStreaming;
      const index = requests.length;
      requests.push({ url: request.url, headers: request.headers, body });
      const reply = replies[index];
      if (!reply) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'Unexpected extra request in CLI test.',
            },
          }),
        );
        return;
      }
      streamReply(response, reply, index, body);
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    }
  });
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock API did not bind a TCP port.');
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

async function runCLI(
  url: string,
  args: string[],
  stdin = '',
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(?:ANTHROPIC_|CLAUDE_|ARNCODE_)/.test(name)) delete env[name];
  }
  env.ANTHROPIC_API_KEY = 'arncode-offline-test-key';
  env.ARNCODE_CONFIG_DIR = config;
  env.NO_COLOR = '1';
  Object.assign(env, extraEnv);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', cli, '--cwd', project, '--base-url', url, ...args],
      {
        cwd: repository,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    children.add(child);
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI did not finish within 15 seconds.\n${stderr}`));
    }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      children.delete(child);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      children.delete(child);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

describe('offline CLI journeys', () => {
  it('runs default full-access tools and on-demand skills, redacts output, and resumes', async () => {
    const skillDirectory = path.join(project, '.arncode/skills/cli-review');
    await mkdir(skillDirectory, { recursive: true });
    const skillBody = 'Inspect the greeting before editing. Remember the walnut workflow marker.';
    await writeFile(
      path.join(skillDirectory, 'SKILL.md'),
      `---\nname: cli-review\ndescription: Review the greeting workflow.\n---\n\n${skillBody}\n`,
    );
    const api = await mockAPI([
      { tool: { name: 'skill', id: 'load_review', input: { name: 'cli-review' } } },
      {
        tool: {
          name: 'write_file',
          id: 'write_greeting',
          input: { path: 'greeting.txt', content: 'hello\n' },
        },
      },
      {
        tool: {
          name: 'edit_file',
          id: 'edit_greeting',
          input: { path: 'greeting.txt', old_string: 'hello', new_string: 'hi' },
        },
      },
      {
        tool: {
          name: 'bash',
          id: 'record_cwd',
          input: {
            command:
              "pwd > cwd.txt; printf 'shell\\n' >> greeting.txt; printf 'render complete\\n'",
          },
        },
      },
      { text: ['Finished: ', 'sk-', 'ant-', 'cli-secret', ' verified.\n'] },
      { text: ['The greeting is still hi, followed by shell.\n'] },
    ]);
    const run = await runCLI(
      api.url,
      ['--fast'],
      'Create and edit a greeting, then record the working directory.',
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe('Finished: [redacted] verified.\n');
    expect(run.stderr).toContain('write_file greeting.txt');
    expect(run.stderr).toContain('-hello');
    expect(run.stderr).toContain('+hi');
    expect(run.stderr).toContain('bash completed');
    expect(run.stderr).toContain('Exit code: 0');
    expect(run.stderr).toContain('render complete');
    expect(run.stderr).toContain('Turn:');
    expect(run.stderr).toContain('cost unavailable');
    expect(run.stdout + run.stderr).not.toContain('cli-secret');
    expect(await readFile(path.join(project, 'greeting.txt'), 'utf8')).toBe('hi\nshell\n');
    expect((await readFile(path.join(project, 'cwd.txt'), 'utf8')).trim()).toBe(project);
    expect(api.requests).toHaveLength(5);
    expect(JSON.stringify(api.requests[0]?.body.system)).toContain(
      'cli-review: Review the greeting workflow.',
    );
    expect(JSON.stringify(api.requests[0]?.body.system)).not.toContain(skillBody);
    expect(api.requests[1]?.body.messages.at(-1)).toMatchObject({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'load_review',
          content: expect.stringContaining(skillBody),
        },
      ],
    });
    expect(api.requests[0]?.url).toBe('/v1/messages');
    expect(api.requests[0]?.headers['anthropic-beta']).toBe('fast-mode-2026-02-01');
    expect(api.requests[0]?.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 64000,
      stream: true,
      speed: 'fast',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: [{ type: 'text', cache_control: { type: 'ephemeral' } }],
    });
    expect(api.requests[0]?.body.tools?.at(-1)).toMatchObject({
      cache_control: { type: 'ephemeral' },
    });
    for (const request of api.requests) {
      expect(JSON.stringify(request.body).match(/"cache_control":/g)).toHaveLength(3);
      const latest = request.body.messages.at(-1);
      expect(latest?.role).toBe('user');
      expect(Array.isArray(latest?.content) && latest.content.at(-1)).toMatchObject({
        cache_control: { type: 'ephemeral' },
      });
    }
    const sessions = await readdir(path.join(config, 'sessions'));
    expect(sessions).toHaveLength(1);
    const sessionFile = path.join(config, 'sessions', sessions[0]!);
    const before = await readFile(sessionFile, 'utf8');
    expect(JSON.parse(before)).toMatchObject({ peakContextTokens: 70 });
    expect(before).not.toContain('cli-secret');
    expect(before).not.toContain('arncode-offline-test-key');
    expect(before).not.toContain('cache_control');
    expect((await stat(sessionFile)).mode & 0o777).toBe(0o600);

    const resumed = await runCLI(api.url, ['--continue', '-p', 'Confirm the last change.']);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(resumed.stdout).toBe('The greeting is still hi, followed by shell.\n');
    expect(api.requests).toHaveLength(6);
    const messages = api.requests[5]?.body.messages;
    expect(messages).toEqual(
      expect.arrayContaining([
        { role: 'user', content: 'Create and edit a greeting, then record the working directory.' },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Confirm the last change.',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ]),
    );
    expect(JSON.stringify(messages)).toContain('record_cwd');
    expect(JSON.stringify(messages)).toContain('Exit code: 0');
    expect(JSON.stringify(messages)).not.toContain('cli-secret');
    expect(await readFile(path.join(project, 'greeting.txt'), 'utf8')).toBe('hi\nshell\n');
    expect(await readdir(path.join(config, 'sessions'))).toEqual(sessions);
  }, 30_000);

  it('shows shell failures in stderr even when the model does not mention them', async () => {
    const api = await mockAPI([
      {
        tool: {
          name: 'bash',
          id: 'failed_render',
          input: { command: "printf 'render failed\\n' >&2; exit 7" },
        },
      },
      { text: ['Task stopped.\n'] },
    ]);
    const run = await runCLI(api.url, ['-p', 'Render the project.']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe('Task stopped.\n');
    expect(run.stderr).toContain('bash failed');
    expect(run.stderr).toContain('Exit code: 7');
    expect(run.stderr).toContain('render failed');
    expect(api.requests[1]?.body.messages.at(-1)).toMatchObject({
      content: [{ tool_use_id: 'failed_render', is_error: true }],
    });
  }, 30_000);

  it('denies non-TTY writes in ask mode and explains the denial independently of model text', async () => {
    const api = await mockAPI([
      {
        tool: {
          name: 'write_file',
          id: 'denied_write',
          input: { path: 'denied.txt', content: 'must not exist' },
        },
      },
      { text: ['No changes made.\n'] },
    ]);
    const run = await runCLI(api.url, ['--safe', '-p', 'Create denied.txt']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe('No changes made.\n');
    expect(run.stderr).toContain('Permission denied for write_file');
    expect(run.stderr).toContain('requires an interactive terminal');
    expect(run.stderr).toMatch(/--yolo|full/);
    await expect(readFile(path.join(project, 'denied.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(api.requests).toHaveLength(2);
    expect(api.requests[1]?.body.messages.at(-1)).toMatchObject({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'denied_write',
          is_error: true,
          content: expect.stringContaining('Permission denied'),
        },
      ],
    });
  }, 30_000);

  it('never executes tools in output-limited responses and bounds continuation attempts', async () => {
    const api = await mockAPI(
      Array.from({ length: 3 }, (_, index): Reply => ({
        tool: {
          name: 'write_file',
          id: `incomplete_${index}`,
          input: { path: 'incomplete.txt', content: 'must not execute' },
        },
        stop: 'max_tokens',
      })),
    );
    const run = await runCLI(api.url, ['--yolo', '-p', 'Create incomplete.txt']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('Output limit reached repeatedly');
    expect(run.stderr).toContain('--effort');
    expect(run.stdout).toBe('');
    expect(api.requests).toHaveLength(3);
    expect(JSON.stringify(api.requests[1]?.body.messages)).toContain(
      'previous response reached its output limit',
    );
    expect(JSON.stringify(api.requests[1]?.body.messages)).not.toContain('incomplete_0');
    await expect(readFile(path.join(project, 'incomplete.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const sessions = await readdir(path.join(config, 'sessions'));
    expect(sessions).toHaveLength(1);
    expect(await readFile(path.join(config, 'sessions', sessions[0]!), 'utf8')).not.toContain(
      '"type": "tool_use"',
    );
  }, 30_000);
});

describe('hooks', () => {
  it('runs configured hooks around prompts, tools and the end of a turn', async () => {
    const hooks = path.join(temporary, 'hooks');
    await mkdir(hooks);
    await writeFile(
      path.join(hooks, 'guard.sh'),
      'input=$(cat); if printf %s "$input" | grep -q "rm -rf"; then echo "deletes are not allowed" >&2; exit 2; fi\n',
    );
    await writeFile(
      path.join(hooks, 'format.sh'),
      'cat >/dev/null; echo "run the formatter" >&2; exit 2\n',
    );
    await writeFile(
      path.join(hooks, 'stop.sh'),
      `cat >/dev/null; if [ ! -f ${hooks}/stopped ]; then touch ${hooks}/stopped; echo "also add a test" >&2; exit 2; fi\n`,
    );
    await mkdir(config, { recursive: true });
    await writeFile(
      path.join(config, 'config.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo "Context from hook"' }] }],
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: `bash ${hooks}/guard.sh` }] },
          ],
          PostToolUse: [
            { matcher: 'Write', hooks: [{ type: 'command', command: `bash ${hooks}/format.sh` }] },
          ],
          Stop: [{ hooks: [{ type: 'command', command: `bash ${hooks}/stop.sh` }] }],
        },
      }),
    );
    const api = await mockAPI([
      { tool: { name: 'bash', id: 'delete', input: { command: 'rm -rf build' } } },
      { tool: { name: 'write_file', id: 'note', input: { path: 'note.txt', content: 'x' } } },
      { text: ['Done.\n'] },
      { text: ['Added the test.\n'] },
    ]);
    const run = await runCLI(api.url, ['-p', 'Clean up.']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe('Done.\nAdded the test.\n');
    expect(JSON.stringify(api.requests[0]!.body.messages)).toContain('Context from hook');
    expect(api.requests[1]!.body.messages.at(-1)).toMatchObject({
      content: [
        {
          tool_use_id: 'delete',
          is_error: true,
          content: expect.stringContaining('deletes are not allowed'),
        },
      ],
    });
    expect(JSON.stringify(api.requests[2]!.body.messages.at(-1))).toContain(
      'Hook feedback: run the formatter',
    );
    expect(JSON.stringify(api.requests[3]!.body.messages)).toContain(
      'A hook asked to continue: also add a test',
    );
    expect(api.requests).toHaveLength(4);
  }, 30_000);
});

describe('MCP servers', () => {
  it('offers configured MCP tools to the model and runs them', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
    await mkdir(config, { recursive: true });
    await writeFile(
      path.join(config, 'config.json'),
      JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture] } } }),
    );
    const api = await mockAPI([
      { tool: { name: 'mcp__fixture__echo', id: 'echo_call', input: { message: 'hi' } } },
      { text: ['The server said hi.\n'] },
    ]);
    const run = await runCLI(api.url, ['-p', 'Ask the server to echo hi.']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe('The server said hi.\n');
    expect(api.requests[0]!.body.tools?.map((tool) => (tool as { name: string }).name)).toEqual(
      expect.arrayContaining(['mcp__fixture__echo', 'mcp__fixture__fail']),
    );
    expect(api.requests[1]!.body.messages.at(-1)).toMatchObject({
      content: [{ type: 'tool_result', tool_use_id: 'echo_call', content: 'echo: hi' }],
    });
  }, 30_000);
});

describe('official-endpoint API features', () => {
  const full = { ARNCODE_API_FEATURES: 'full' };

  it('streams progress notes to stderr, runs reads in parallel and keeps the prefix frozen', async () => {
    await writeFile(path.join(project, 'a.txt'), 'alpha\n');
    await writeFile(path.join(project, 'b.txt'), 'beta\n');
    const api = await mockAPI([
      {
        blocks: [
          { type: 'thinking', text: 'Checking both files first.' },
          { type: 'tool', name: 'read_file', id: 'read_a', input: { path: 'a.txt' } },
          { type: 'tool', name: 'read_file', id: 'read_b', input: { path: 'b.txt' } },
        ],
      },
      { blocks: [{ type: 'thinking' }, { type: 'text', text: ['Both files are present.\n'] }] },
      { text: ['Summarized.\n'] },
    ]);
    const run = await runCLI(api.url, ['-p', 'Check a.txt and b.txt.'], '', full);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe('Both files are present.\n');
    expect(run.stderr).toContain('Checking both files first.');
    const first = api.requests[0]!;
    expect(first.url).toBe('/v1/messages');
    expect(String(first.headers['anthropic-beta']).split(',')).toEqual(
      expect.arrayContaining([
        'thinking-binding-controls-2026-08-01',
        'thinking-display-updates-2026-08-18',
        'server-side-fallback-2026-07-01',
      ]),
    );
    expect(first.body).toMatchObject({
      thinking: { type: 'adaptive', display: 'updates' },
      fallbacks: 'default',
    });
    const second = api.requests[1]!.body.messages;
    expect(second.at(-2)).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'thinking', signature: 'signature-0' },
        { type: 'tool_use', id: 'read_a' },
        { type: 'tool_use', id: 'read_b' },
      ],
    });
    expect(second.at(-1)).toMatchObject({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'read_a', content: expect.stringContaining('alpha') },
        { type: 'tool_result', tool_use_id: 'read_b', content: expect.stringContaining('beta') },
      ],
    });

    const resumed = await runCLI(
      api.url,
      ['--continue', '--effort', 'high', '-p', 'Summarize.'],
      '',
      full,
    );
    expect(resumed.code, resumed.stderr).toBe(0);
    const third = api.requests[2]!;
    expect(third.body.system).toEqual(first.body.system);
    expect(third.body.output_config).toEqual({ effort: 'medium' });
    expect(third.body.messages.at(-2)).toEqual({
      role: 'system',
      content: [],
      output_config: { effort: 'high' },
    });
    expect(String(third.headers['anthropic-beta'])).toContain(
      'mid-conversation-output-config-2026-07-01',
    );
  }, 30_000);

  it('summarizes a large conversation on the server and continues from the summary', async () => {
    await writeFile(path.join(project, 'notes.txt'), 'remember the walnut\n');
    const api = await mockAPI([
      {
        tool: { name: 'read_file', id: 'read_notes', input: { path: 'notes.txt' } },
        inputTokens: 30_000,
      },
      {
        blocks: [{ type: 'compaction', content: 'Summary: notes.txt mentions a walnut.' }],
        stop: 'compaction',
      },
      { text: ['Done after the summary.\n'] },
    ]);
    const run = await runCLI(api.url, ['-p', 'Read the notes.'], '', {
      ...full,
      ARNCODE_COMPACT_AT: '20000',
    });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe('Done after the summary.\n');
    expect(run.stderr).toContain('Conversation summarized');
    expect(api.requests).toHaveLength(3);
    expect(api.requests[1]!.body).toMatchObject({ compaction: { type: 'summarize' } });
    expect(api.requests[1]!.body).not.toHaveProperty('fallbacks');
    expect(api.requests[1]!.body.messages.at(-1)).toMatchObject({
      content: [{ type: 'tool_result', tool_use_id: 'read_notes' }],
    });
    const after = api.requests[2]!.body.messages;
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'compaction', content: 'Summary: notes.txt mentions a walnut.' }],
    });
    expect(JSON.stringify(after[1])).toContain('Continue the task from the summary');
    expect(String(api.requests[2]!.headers['anthropic-beta'])).toContain('compact-2026-09-04');
    const [file] = await readdir(path.join(config, 'sessions'));
    expect(JSON.parse(await readFile(path.join(config, 'sessions', file!), 'utf8'))).toMatchObject({
      compactions: 1,
    });
  }, 30_000);

  it('lets the model look at rendered frames and attached images', async () => {
    const frame = new PNG({ width: 64, height: 36 });
    for (let index = 0; index < frame.data.length; index += 4) {
      frame.data.fill(index % 255, index, index + 3);
      frame.data[index + 3] = 255;
    }
    const bytes = PNG.sync.write(frame);
    await writeFile(path.join(project, 'frame.png'), bytes);
    await writeFile(path.join(project, 'mock.png'), bytes);
    const api = await mockAPI([
      { tool: { name: 'read_file', id: 'look', input: { path: 'frame.png' } } },
      { text: ['The frame is a gradient.\n'] },
    ]);
    const run = await runCLI(api.url, ['-p', 'Compare the render with @mock.png'], '', full);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain('Attached mock.png');
    expect(run.stderr).toContain('Image frame.png (64×36 PNG');
    const data = bytes.toString('base64');
    expect(api.requests[0]!.body.messages[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: expect.stringContaining('Image mock.png') },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
        { type: 'text', text: 'Compare the render with @mock.png' },
      ],
    });
    expect(api.requests[1]!.body.messages.at(-1)).toMatchObject({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'look',
          content: [
            { type: 'text', text: expect.stringContaining('Image frame.png') },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
          ],
        },
      ],
    });
    const files = await readdir(path.join(config, 'sessions'));
    const session = await readFile(
      path.join(
        config,
        'sessions',
        files.find((name) => name.endsWith('.json'))!,
      ),
      'utf8',
    );
    expect(session).not.toContain(data);
    expect(session).toContain('arncode-blob:');
    expect(session).toContain('[Image 64×36]');
    expect(files.some((name) => name.endsWith('.blobs'))).toBe(true);
  }, 30_000);

  it('delegates to a read-only subagent and keeps a checklist', async () => {
    await writeFile(path.join(project, 'auth.ts'), 'export const login = () => true;\n');
    const api = await mockAPI([
      {
        tool: {
          name: 'todo_write',
          id: 'plan_steps',
          input: {
            todos: [
              {
                content: 'Find the login code',
                status: 'in_progress',
                activeForm: 'Finding the login code',
              },
              { content: 'Summarize it', status: 'pending', activeForm: 'Summarizing it' },
            ],
          },
        },
      },
      {
        tool: {
          name: 'task',
          id: 'explore_auth',
          input: { description: 'find login', prompt: 'Find where login is defined.' },
        },
      },
      { tool: { name: 'grep', id: 'sub_grep', input: { pattern: 'login' } } },
      { text: ['login is defined in auth.ts:1.'] },
      { text: ['Login lives in auth.ts.\n'] },
    ]);
    const run = await runCLI(api.url, ['-p', 'Where is login?'], '', full);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe('Login lives in auth.ts.\n');
    expect(run.stderr).toContain('[>] Find the login code');
    expect(run.stderr).toContain('find login · Search login');
    const sub = api.requests[2]!.body;
    expect(sub.model).toBe('claude-haiku-5-5');
    expect(sub.output_config).toEqual({ effort: 'low' });
    expect(JSON.stringify(sub.system)).toContain('read-only subagent');
    expect(sub.tools?.map((tool) => (tool as { name: string }).name)).toEqual([
      'read_file',
      'list_dir',
      'glob',
      'grep',
      'skill',
    ]);
    expect(sub.messages[0]).toMatchObject({ role: 'user' });
    expect(JSON.stringify(sub.messages[0])).toContain('Find where login is defined.');
    expect(api.requests[4]!.body.messages.at(-1)).toMatchObject({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'explore_auth',
          content: 'login is defined in auth.ts:1.\n\n[1 tool call]',
        },
      ],
    });
    const [file] = (await readdir(path.join(config, 'sessions'))).filter((name) =>
      name.endsWith('.json'),
    );
    const saved = JSON.parse(await readFile(path.join(config, 'sessions', file!), 'utf8'));
    expect(saved.todos).toHaveLength(2);
    expect(saved.usage.requests).toBe(5);
  }, 30_000);

  it('reports refusal fallbacks and explains final refusals', async () => {
    const api = await mockAPI([
      {
        blocks: [
          { type: 'fallback', from: 'claude-opus-5-5', to: 'claude-opus-5' },
          { type: 'text', text: ['Answer from the fallback.\n'] },
        ],
      },
      {
        blocks: [],
        stop: 'refusal',
        stopDetails: { category: 'cyber', explanation: 'This request was declined.' },
      },
    ]);
    const first = await runCLI(api.url, ['-p', 'Explain the parser.'], '', full);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toBe('Answer from the fallback.\n');
    expect(first.stderr).toContain('claude-opus-5-5 declined; claude-opus-5 continues.');
    const second = await runCLI(api.url, ['--continue', '-p', 'Go on.'], '', full);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain('Claude declined this request (cyber)');
    expect(second.stderr).toContain('This request was declined.');
  }, 30_000);
});

describe('machine-readable output', () => {
  it('prints one JSON result, or a stream of JSON events, on stdout', async () => {
    const api = await mockAPI([
      {
        tool: {
          name: 'write_file',
          id: 'write_note',
          input: { path: 'note.txt', content: 'saved\n' },
        },
      },
      { text: ['Saved the note.\n'] },
      { text: ['Second answer.\n'] },
    ]);
    const streamed = await runCLI(api.url, [
      '-p',
      'Save a note.',
      '--output-format',
      'stream-json',
    ]);
    expect(streamed.code, streamed.stderr).toBe(0);
    const events = streamed.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'tool_use',
      'file_change',
      'tool_result',
      'text',
      'result',
    ]);
    expect(events[2]).toMatchObject({ path: 'note.txt', created: true, added: 1 });
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Saved the note.\n',
      num_turns: 2,
      usage: { input_tokens: 80, output_tokens: 24 },
    });
    const single = await runCLI(api.url, [
      '--continue',
      '-p',
      'Answer again.',
      '--output-format',
      'json',
    ]);
    expect(single.code, single.stderr).toBe(0);
    const result = JSON.parse(single.stdout) as Record<string, unknown>;
    expect(result).toMatchObject({ result: 'Second answer.\n', num_turns: 1 });
    expect(result.session_id).toMatch(/^[0-9a-f-]{36}$/);
  }, 30_000);
});
