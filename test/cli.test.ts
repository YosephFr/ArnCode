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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface Reply {
  text?: string[];
  tool?: { name: string; id: string; input: Record<string, unknown> };
  stop?: StopReason;
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
  if (reply.tool) {
    emit({
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: reply.tool.id,
        name: reply.tool.name,
        input: {},
        caller: { type: 'direct' },
      },
    });
    emit({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.tool.input) },
    });
  } else {
    emit({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '', citations: null },
    });
    for (const text of reply.text ?? []) {
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    }
  }
  emit({ type: 'content_block_stop', index: 0 });
  emit({
    type: 'message_delta',
    delta: {
      stop_reason: reply.stop ?? (reply.tool ? 'tool_use' : 'end_turn'),
      stop_sequence: null,
      stop_details: null,
      container: null,
    },
    usage: {
      input_tokens: 40,
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
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(?:ANTHROPIC_|CLAUDE_|ARNCODE_)/.test(name)) delete env[name];
  }
  env.ANTHROPIC_API_KEY = 'arncode-offline-test-key';
  env.ARNCODE_CONFIG_DIR = config;
  env.NO_COLOR = '1';
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
          input: { command: "pwd > cwd.txt; printf 'shell\\n' >> greeting.txt" },
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
    const sessions = await readdir(path.join(config, 'sessions'));
    expect(sessions).toHaveLength(1);
    const sessionFile = path.join(config, 'sessions', sessions[0]!);
    const before = await readFile(sessionFile, 'utf8');
    expect(before).not.toContain('cli-secret');
    expect(before).not.toContain('arncode-offline-test-key');
    expect((await stat(sessionFile)).mode & 0o777).toBe(0o600);

    const resumed = await runCLI(api.url, ['--continue', '-p', 'Confirm the last change.']);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(resumed.stdout).toBe('The greeting is still hi, followed by shell.\n');
    expect(api.requests).toHaveLength(6);
    const messages = api.requests[5]?.body.messages;
    expect(messages).toEqual(
      expect.arrayContaining([
        { role: 'user', content: 'Create and edit a greeting, then record the working directory.' },
        { role: 'user', content: 'Confirm the last change.' },
      ]),
    );
    expect(JSON.stringify(messages)).toContain('record_cwd');
    expect(JSON.stringify(messages)).toContain('Exit code: 0');
    expect(JSON.stringify(messages)).not.toContain('cli-secret');
    expect(await readFile(path.join(project, 'greeting.txt'), 'utf8')).toBe('hi\nshell\n');
    expect(await readdir(path.join(config, 'sessions'))).toEqual(sessions);
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
