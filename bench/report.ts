import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Usage } from './usage.js';

/** One line of results.jsonl. */
export interface ResultRow {
  task: string;
  contestant: string;
  version: string | null;
  run: number;
  startedAt: string;
  pass: boolean;
  wallMs: number;
  lockWaitMs: number | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  error: string | null;
  check: { exitCode: number | null; detail: string; wallMs: number; timedOut: boolean };
  usage: Usage;
  stdoutTail: string;
  stderrTail: string;
}

/** meta.json, written next to results.jsonl. */
export interface RunMeta {
  startedAt: string;
  finishedAt: string | null;
  node: string;
  platform: string;
  harness: string | null;
  tasks: string[];
  versions: Record<string, string | null>;
  runs: number;
  parallel: number;
  lock: string | null;
}

/** A mean over the runs that reported the figure. */
interface Mean {
  mean: number | null;
  reported: number;
}

/** Over runs where the contestant started; null when none did. */
interface Seconds {
  median: number | null;
  p90: number | null;
}

interface Outcomes {
  runs: number;
  passes: number;
  passRate: number;
  timeouts: number;
  errors: number;
  seconds: Seconds;
}

export interface Cell extends Outcomes {
  task: string;
  contestant: string;
  usage: Record<keyof Usage, Mean>;
}

export interface ContestantSummary extends Outcomes {
  contestant: string;
  versions: string[];
  costUsd: Mean & { total: number | null };
}

export interface Report {
  generatedAt: string;
  runs: number;
  environment: { node: string[]; platform: string[]; harness: string[] };
  cells: Cell[];
  contestants: ContestantSummary[];
}

const usageKeys: (keyof Usage)[] = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'costUsd',
  'turns',
];

const method = [
  '- Each run copies the task fixture into a fresh temporary Git repository with one initial commit, runs the contestant once on the task prompt, then runs the task check. Pass means the check exited 0 and the contestant finished within the task timeout.',
  '- Time is wall-clock seconds from the contestant start to its exit, after any `--lock` wait. Median and nearest-rank p90 cover every run that started, failures and timeouts included.',
  "- Token columns are means per run of what each tool reported: uncached input, output including reasoning, cache reads and cache writes. Cost is the mean of the tool's own USD estimate, not a bill; subscription runs show an equivalent cost only when the tool reports one.",
  '- A mean leaves out runs where the tool reported nothing; (2/3) marks how many runs it covers, and n/a that none did.',
];

function groupBy(rows: ResultRow[], key: (row: ResultRow) => string): Map<string, ResultRow[]> {
  const groups = new Map<string, ResultRow[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return groups;
}

function sorted(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function median(values: number[]): number {
  const ordered = sorted(values);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

/** Nearest rank: the smallest value with at least p% of the values at or below it. */
function percentile(values: number[], p: number): number {
  const ordered = sorted(values);
  return ordered[Math.max(0, Math.ceil((p / 100) * ordered.length) - 1)]!;
}

function mean(values: (number | null)[]): Mean {
  const known = values.filter((value): value is number => value !== null);
  return {
    mean: known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null,
    reported: known.length,
  };
}

function outcomes(rows: ResultRow[]): Outcomes {
  const passes = rows.filter((row) => row.pass).length;
  const seconds = rows.filter((row) => row.error === null).map((row) => row.wallMs / 1000);
  return {
    runs: rows.length,
    passes,
    passRate: passes / rows.length,
    timeouts: rows.filter((row) => row.timedOut).length,
    errors: rows.filter((row) => row.error !== null).length,
    seconds: seconds.length
      ? { median: median(seconds), p90: percentile(seconds, 90) }
      : { median: null, p90: null },
  };
}

export function buildReport(rows: ResultRow[], metas: RunMeta[] = []): Report {
  const cells = [...groupBy(rows, (row) => `${row.task}\n${row.contestant}`).values()]
    .map((group): Cell => {
      const usage = Object.fromEntries(
        usageKeys.map((key) => [key, mean(group.map((row) => row.usage[key]))]),
      ) as Record<keyof Usage, Mean>;
      return { task: group[0]!.task, contestant: group[0]!.contestant, ...outcomes(group), usage };
    })
    .sort((a, b) => a.task.localeCompare(b.task) || a.contestant.localeCompare(b.contestant));
  const contestants = [...groupBy(rows, (row) => row.contestant).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([contestant, group]): ContestantSummary => {
      const costs = group.map((row) => row.usage.costUsd);
      const known = costs.filter((cost): cost is number => cost !== null);
      return {
        contestant,
        versions: [...new Set(group.map((row) => row.version ?? 'unknown'))],
        ...outcomes(group),
        costUsd: {
          ...mean(costs),
          total: known.length ? known.reduce((sum, cost) => sum + cost, 0) : null,
        },
      };
    });
  const distinct = (values: (string | null)[]) =>
    [...new Set(values)].filter((value): value is string => value !== null);
  return {
    generatedAt: new Date().toISOString(),
    runs: rows.length,
    environment: {
      node: distinct(metas.map((meta) => meta.node)),
      platform: distinct(metas.map((meta) => meta.platform)),
      harness: distinct(metas.map((meta) => meta.harness)),
    },
    cells,
    contestants,
  };
}

const tableRow = (values: string[]) => `| ${values.join(' | ')} |`;
const tokens = (value: number) => Math.round(value).toLocaleString('en-US');
const dollars = (value: number) => value.toFixed(4);
const seconds = (value: number | null) => (value === null ? 'n/a' : value.toFixed(1));

function passText(outcome: Outcomes): string {
  const notes = [
    outcome.timeouts ? `${outcome.timeouts} timed out` : '',
    outcome.errors ? `${outcome.errors} did not start` : '',
  ].filter(Boolean);
  const rate = `${outcome.passes}/${outcome.runs} (${Math.round(outcome.passRate * 100)}%)`;
  return notes.length ? `${rate}, ${notes.join(', ')}` : rate;
}

function meanText(value: Mean, runs: number, format: (value: number) => string): string {
  if (value.mean === null) return 'n/a';
  return value.reported < runs
    ? `${format(value.mean)} (${value.reported}/${runs})`
    : format(value.mean);
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export function renderMarkdown(report: Report): string {
  const tasks = new Set(report.cells.map((cell) => cell.task)).size;
  const environment = [
    ...report.environment.node.map((version) => `node ${version}`),
    ...report.environment.platform,
    ...report.environment.harness.map((revision) => `harness ${revision}`),
  ];
  const lines = [
    '# Benchmark report',
    '',
    `${plural(report.runs, 'run')}: ${plural(tasks, 'task')}, ${plural(report.contestants.length, 'contestant')}.`,
    '',
    '| Task | Contestant | Pass | Median s | p90 s | Uncached in | Out | Cache read | Cache write | Cost $ |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.cells.map((cell) =>
      tableRow([
        cell.task,
        cell.contestant,
        passText(cell),
        seconds(cell.seconds.median),
        seconds(cell.seconds.p90),
        meanText(cell.usage.inputTokens, cell.runs, tokens),
        meanText(cell.usage.outputTokens, cell.runs, tokens),
        meanText(cell.usage.cacheReadTokens, cell.runs, tokens),
        meanText(cell.usage.cacheWriteTokens, cell.runs, tokens),
        meanText(cell.usage.costUsd, cell.runs, dollars),
      ]),
    ),
    '',
    '## By contestant',
    '',
    '| Contestant | Version | Pass | Median s | p90 s | Mean cost $ | Total cost $ |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: |',
    ...report.contestants.map((summary) =>
      tableRow([
        summary.contestant,
        summary.versions.join(', '),
        passText(summary),
        seconds(summary.seconds.median),
        seconds(summary.seconds.p90),
        meanText(summary.costUsd, summary.runs, dollars),
        meanText(
          { mean: summary.costUsd.total, reported: summary.costUsd.reported },
          summary.runs,
          dollars,
        ),
      ]),
    ),
    '',
    '## Method',
    '',
    ...method,
    ...(environment.length ? [`- Environment: ${environment.join(', ')}.`] : []),
  ];
  return `${lines.join('\n')}\n`;
}

/** Reads results.jsonl files, or directories holding one, with their meta.json. */
export async function loadResults(
  inputs: string[],
): Promise<{ rows: ResultRow[]; metas: RunMeta[] }> {
  const rows: ResultRow[] = [];
  const metas: RunMeta[] = [];
  for (const input of inputs) {
    const file = (await stat(input)).isDirectory() ? path.join(input, 'results.jsonl') : input;
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      if (line.trim()) rows.push(JSON.parse(line) as ResultRow);
    }
    const meta = await readFile(path.join(path.dirname(file), 'meta.json'), 'utf8').catch(
      () => undefined,
    );
    if (meta) metas.push(JSON.parse(meta) as RunMeta);
  }
  return { rows, metas };
}

/** Writes report.md and report.json into `out` and returns the Markdown. */
export async function writeReport(inputs: string[], out: string): Promise<string> {
  const { rows, metas } = await loadResults(inputs);
  const report = buildReport(rows, metas);
  const markdown = renderMarkdown(report);
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'report.md'), markdown);
  await writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return markdown;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: { out: { type: 'string' } },
    });
    const [first] = positionals;
    if (!first) throw new Error('Usage: npx tsx bench/report.ts <results dir>... [--out <dir>]');
    const out = values.out ?? ((await stat(first)).isDirectory() ? first : path.dirname(first));
    process.stdout.write(await writeReport(positionals, out));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
