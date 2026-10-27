import { spawn } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Report, ResultRow } from '../bench/report.js';
import { parseUsage } from '../bench/usage.js';
import { emptyUsage, formatUsage, type UsageTotals } from '../src/usage.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
let temporary: string;

beforeEach(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), 'arncode-bench-'));
});

afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});

function node(
  args: string[],
  cwd = repository,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`node ${args.join(' ')} did not finish within 20 seconds.\n${stderr}`));
    }, 20_000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('benchmark harness', () => {
  it('runs every task with the mock contestant, checks the work and reports it', async () => {
    const run = await node([
      '--import',
      'tsx',
      'bench/run.ts',
      '--contestants',
      'mock',
      '--runs',
      '1',
      '--out',
      temporary,
    ]);
    expect(run.code, run.stderr).toBe(0);
    const [stamp, ...others] = await readdir(temporary);
    expect(others).toEqual([]);
    const dir = path.join(temporary, stamp!);

    const rows = (await readFile(path.join(dir, 'results.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ResultRow);
    const byTask = Object.fromEntries(rows.map((row) => [row.task, row]));
    expect(Object.keys(byTask).sort()).toEqual([
      'cli-flag',
      'fix-bug',
      'implement-spec',
      'read-chart',
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        contestant: 'mock',
        version: 'mock 1.0.0',
        run: 1,
        pass: row.task !== 'read-chart',
        exitCode: 0,
        timedOut: false,
        error: null,
        lockWaitMs: null,
        check: { exitCode: row.task === 'read-chart' ? 1 : 0, timedOut: false },
        usage: {
          inputTokens: 1200,
          outputTokens: 345,
          cacheReadTokens: 6789,
          cacheWriteTokens: 1011,
          costUsd: 0.0123,
          turns: null,
        },
      });
      expect(row.stderrTail).toContain('Session: 1,200 uncached in');
    }
    expect(byTask['fix-bug']?.check.detail).toBe('6 visible and 4 hidden tests pass');
    expect(byTask['implement-spec']?.check.detail).toBe('8 hidden tests pass');
    expect(byTask['cli-flag']?.check.detail).toBe(
      '--lines works; the suite (6 tests) passes and fails without the change',
    );
    expect(byTask['read-chart']?.check.detail).toBe(
      'answer.txt says "KIWI"; the tallest bar is LIME',
    );
    expect(await readFile(path.join(dir, 'logs/fix-bug.mock.1.diff'), 'utf8')).toContain(
      '+  return [...values].sort((a, b) => a - b);',
    );
    expect(JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8'))).toMatchObject({
      node: process.version,
      versions: { mock: 'mock 1.0.0' },
      tasks: ['cli-flag', 'fix-bug', 'implement-spec', 'read-chart'],
    });

    const markdown = await readFile(path.join(dir, 'report.md'), 'utf8');
    expect(markdown).toMatch(
      /^\| cli-flag \| mock \| 1\/1 \(100%\) \| \d+\.\d \| \d+\.\d \| 1,200 \| 345 \| 6,789 \| 1,011 \| 0\.0123 \|$/m,
    );
    expect(markdown).toContain('| fix-bug | mock | 1/1 (100%) |');
    expect(markdown).toContain('| implement-spec | mock | 1/1 (100%) |');
    expect(markdown).toContain('| read-chart | mock | 0/1 (0%) |');
    expect(markdown).toMatch(
      /^\| mock \| mock 1\.0\.0 \| 3\/4 \(75%\) \| .+ \| 0\.0123 \| 0\.0492 \|$/m,
    );
    expect(run.stdout).toContain(markdown);

    const report = await node(['--import', 'tsx', 'bench/report.ts', dir]);
    expect(report.code, report.stderr).toBe(0);
    expect(report.stdout).toBe(markdown);
    const json = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8')) as Report;
    expect(json.contestants).toEqual([
      expect.objectContaining({ contestant: 'mock', runs: 4, passes: 3, passRate: 0.75 }),
    ]);
    expect(json.cells.find((cell) => cell.task === 'read-chart')?.usage.costUsd).toEqual({
      mean: 0.0123,
      reported: 1,
    });
  }, 30_000);

  it('rejects every untouched fixture and keeps the chart in step with its generator', async () => {
    const tasks = path.join(repository, 'bench/tasks');
    for (const task of await readdir(tasks)) {
      const dir = path.join(temporary, task);
      await cp(path.join(tasks, task, 'fixture'), dir, { recursive: true });
      const check = await node([path.join(tasks, task, 'check.mjs')], dir);
      expect(check.code, `${task}: ${check.stdout}${check.stderr}`).toBe(1);
      expect(check.stdout.trim().split('\n'), task).toHaveLength(1);
    }
    const chart = await node(['bench/tasks/read-chart/make-chart.mjs', '--check']);
    expect(chart.code, chart.stdout).toBe(0);
  }, 30_000);

  it('reads usage the way each contestant reports it, leaving unknown figures empty', () => {
    // ArnCode's lines come from its own formatter, so a format change shows up here.
    const session = {
      ...emptyUsage(),
      inputTokens: 2345,
      outputTokens: 1234,
      cacheReadTokens: 45_678,
      cacheWriteTokens: 3456,
      costUsd: 0.1234,
      requests: 3,
      fastRequests: 1,
    };
    const arncode = (usage: UsageTotals) =>
      parseUsage(
        'arncode',
        '',
        `ArnCode · full access\nSession: 6f1c2a1e\nTurn: ${formatUsage({ ...usage, inputTokens: 1 })}\nSession: ${formatUsage(usage)}\n`,
      );
    expect(arncode(session)).toEqual({
      inputTokens: 2345,
      outputTokens: 1234,
      cacheReadTokens: 45_678,
      cacheWriteTokens: 3456,
      costUsd: 0.1234,
      turns: null,
    });
    expect(arncode({ ...session, unpricedRequests: 3 })).toMatchObject({
      inputTokens: 2345,
      costUsd: null,
    });
    expect(arncode({ ...session, unpricedRequests: 1 }).costUsd).toBeNull();
    expect(arncode({ ...session, costUsd: 0.00004 }).costUsd).toBeNull();
    expect(arncode(emptyUsage())).toMatchObject({ inputTokens: 0, costUsd: 0 });

    const claude = {
      type: 'result',
      subtype: 'success',
      num_turns: 7,
      result: 'Done.',
      total_cost_usd: 0.2468,
      usage: {
        input_tokens: 30,
        output_tokens: 900,
        cache_read_input_tokens: 40_000,
        cache_creation_input_tokens: 5000,
      },
      modelUsage: {
        'claude-opus-5-5': {
          inputTokens: 30,
          outputTokens: 900,
          cacheReadInputTokens: 40_000,
          cacheCreationInputTokens: 5000,
          costUSD: 0.24,
        },
        'claude-haiku-5-5': {
          inputTokens: 500,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.0068,
        },
      },
    };
    expect(parseUsage('claude-code', JSON.stringify(claude), '')).toEqual({
      inputTokens: 530,
      outputTokens: 950,
      cacheReadTokens: 40_000,
      cacheWriteTokens: 5000,
      costUsd: 0.2468,
      turns: 7,
    });
    const mainLoopOnly = JSON.stringify({ ...claude, modelUsage: undefined });
    expect(parseUsage('claude-code', mainLoopOnly, '')).toMatchObject({
      inputTokens: 30,
      outputTokens: 900,
    });

    const step = (cost: number, input: number, output: number, reasoning: number, read: number) =>
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses_1',
        part: {
          type: 'step-finish',
          cost,
          tokens: { input, output, reasoning, cache: { read, write: 200 } },
        },
      });
    const opencode = [
      JSON.stringify({ type: 'step_start', sessionID: 'ses_1', part: { type: 'step-start' } }),
      step(0.01, 100, 20, 30, 1000),
      JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'Done' } }),
      step(0.02, 50, 10, 0, 1200),
    ].join('\n');
    const opencodeUsage = parseUsage('opencode', opencode, '');
    expect(opencodeUsage).toMatchObject({
      inputTokens: 150,
      outputTokens: 60,
      cacheReadTokens: 2200,
      cacheWriteTokens: 400,
      turns: 2,
    });
    expect(opencodeUsage.costUsd).toBeCloseTo(0.03);

    const codex = [
      { type: 'thread.started', thread_id: 'thread_1' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Done' } },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 24_763,
          cached_input_tokens: 24_448,
          cache_write_input_tokens: 0,
          output_tokens: 122,
          reasoning_output_tokens: 64,
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');
    expect(parseUsage('codex', codex, '')).toEqual({
      inputTokens: 315,
      outputTokens: 122,
      cacheReadTokens: 24_448,
      cacheWriteTokens: 0,
      costUsd: null,
      turns: null,
    });

    for (const parser of ['arncode', 'claude-code', 'opencode', 'codex']) {
      expect(parseUsage(parser, 'Error: not logged in\n', 'Error: not logged in\n')).toEqual({
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsd: null,
        turns: null,
      });
    }
  });
});
