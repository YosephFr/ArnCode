import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { writeReport, type ResultRow, type RunMeta } from './report.js';
import { parseUsage, unknownUsage, usageParsers } from './usage.js';

const usage = `Usage: npx tsx bench/run.ts --contestants <names> [options]

  --contestants <a,b>  Contestants from bench/contestants.json (required)
  --tasks <a,b>        Tasks from bench/tasks (default: all)
  --runs <n>           Runs per task and contestant (default: 3)
  --out <dir>          Results directory (default: bench/results)
  --lock <file>        Hold flock on this file during each contestant run
  --parallel <n>       Runs at the same time (default: 1)`;

const bench = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(bench);
const execFileAsync = promisify(execFile);
const outputLimit = 64 * 1024 * 1024;
const tailLength = 2000;
const checkTimeoutMs = 120_000;
const killGraceMs = 5000;
const placeholder = /\{(prompt|dir|task|bench|env:[A-Za-z_]\w*)\}/g;
// The initial commit is the same everywhere: fixed identity and date, no user Git config.
const gitEnv = {
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'bench',
  GIT_AUTHOR_EMAIL: 'bench',
  GIT_COMMITTER_NAME: 'bench',
  GIT_COMMITTER_EMAIL: 'bench',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

interface Task {
  id: string;
  dir: string;
  prompt: string;
  timeoutSec: number;
  check: string[];
}

interface Contestant {
  name: string;
  command: string[];
  version: string[] | null;
  env: Record<string, string>;
  unsetEnv: string[];
  usage: string;
}

interface Config {
  unsetEnv: string[];
  contestants: Contestant[];
}

interface Outcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  error: string | null;
  stdout: string;
  stderr: string;
  wallMs: number;
  lockWaitMs: number | null;
}

interface Job {
  task: Task;
  contestant: Contestant;
  run: number;
}

const groups = new Set<number>();
const workDirs = new Set<string>();

function fail(message: string): never {
  throw new Error(message);
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

function checkPlaceholders(template: string[], allowed: string[], where: string): void {
  for (const [, key] of template.join(' ').matchAll(/\{([^{}\s]+)\}/g)) {
    if (!key || !(allowed.includes(key) || /^env:[A-Za-z_]\w*$/.test(key)))
      fail(
        `${where}: unknown placeholder {${key}}. Use ${allowed.map((k) => `{${k}}`).join(', ')}.`,
      );
  }
}

/** Substitutes placeholders in one pass, so a prompt containing "{dir}" stays as written. */
function fill(template: string[], values: Record<string, string>): string[] {
  return template.map((part) =>
    part.replace(placeholder, (_match, key: string) => {
      if (key.startsWith('env:')) {
        const value = process.env[key.slice(4)];
        if (!value) fail(`Set ${key.slice(4)} to run ${template[0]}.`);
        return value;
      }
      return values[key] ?? fail(`{${key}} is not available in ${template.join(' ')}.`);
    }),
  );
}

async function loadTasks(): Promise<Task[]> {
  const tasks: Task[] = [];
  const entries = await readdir(path.join(bench, 'tasks'), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(bench, 'tasks', entry.name);
    const file = path.join(dir, 'task.json');
    if (!entry.isDirectory() || !existsSync(file)) continue;
    const { prompt, timeoutSec, check } = JSON.parse(await readFile(file, 'utf8')) as Record<
      string,
      unknown
    >;
    if (typeof prompt !== 'string' || !prompt.trim()) fail(`${file}: prompt must be text.`);
    if (typeof timeoutSec !== 'number' || !(timeoutSec > 0))
      fail(`${file}: timeoutSec must be a positive number.`);
    if (!isStrings(check) || !check.length) fail(`${file}: check must be an argv array.`);
    if (!existsSync(path.join(dir, 'fixture'))) fail(`${dir} has no fixture directory.`);
    checkPlaceholders(check, ['task', 'dir', 'bench'], file);
    tasks.push({ id: entry.name, dir, prompt, timeoutSec, check });
  }
  return tasks;
}

async function loadConfig(): Promise<Config> {
  const file = path.join(bench, 'contestants.json');
  const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  const unsetEnv = raw.unsetEnv ?? [];
  if (!isStrings(unsetEnv)) fail(`${file}: unsetEnv must be a list of names.`);
  if (!Array.isArray(raw.contestants)) fail(`${file}: contestants must be a list.`);
  const contestants = raw.contestants.map((value: Record<string, unknown>): Contestant => {
    const { name, command, usage } = value;
    const version = value.version ?? null;
    const env = value.env ?? {};
    const unset = value.unsetEnv ?? [];
    const where = `${file}: ${String(name)}`;
    if (typeof name !== 'string' || !/^[\w.-]+$/.test(name)) fail(`${where}: invalid name.`);
    if (!isStrings(command) || !command.join(' ').includes('{prompt}'))
      fail(`${where}: command must be an argv array containing {prompt}.`);
    if (version !== null && !isStrings(version)) fail(`${where}: version must be an argv array.`);
    if (typeof env !== 'object' || env === null || !isStrings(Object.values(env)))
      fail(`${where}: env must map names to text.`);
    if (!isStrings(unset)) fail(`${where}: unsetEnv must be a list of names.`);
    if (typeof usage !== 'string' || !usageParsers[usage])
      fail(`${where}: usage must be one of ${Object.keys(usageParsers).join(', ')}.`);
    checkPlaceholders(command, ['prompt', 'dir', 'bench'], where);
    checkPlaceholders(version ?? [], ['bench'], where);
    return { name, command, version, env: env as Record<string, string>, unsetEnv: unset, usage };
  });
  const names = contestants.map((contestant) => contestant.name);
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated) fail(`${file}: ${repeated} is listed twice.`);
  return { unsetEnv, contestants };
}

function environment(config: Config, contestant?: Contestant): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [...config.unsetEnv, ...(contestant?.unsetEnv ?? [])]) delete env[name];
  return { ...env, ...contestant?.env };
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The process group has already exited.
  }
}

// Runs inside flock once the lock is held: signals the harness with a byte on fd 3, closes that
// pipe, then replaces itself with the command. "$@" passes the argv through untouched.
const lockedRun = 'echo >&3; exec 3>&-; exec "$@"';

/**
 * Runs a command in its own process group. The timeout starts once any lock is held; it sends
 * SIGTERM to the group, then SIGKILL. Leftover background processes are killed on exit.
 */
function execute(
  argv: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; lock?: string },
): Promise<Outcome> {
  const command = options.lock
    ? ['flock', options.lock, 'sh', '-c', lockedRun, 'sh', ...argv]
    : argv;
  return new Promise((resolve) => {
    const spawned = performance.now();
    let started = spawned;
    let ended: number | undefined;
    let timedOut = false;
    let error: string | null = null;
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const sizes = { stdout: 0, stderr: 0 };
    const text = (stream: 'stdout' | 'stderr') => Buffer.concat(output[stream]).toString('utf8');
    const child = spawn(command[0]!, command.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe', options.lock ? 'pipe' : 'ignore'],
      detached: true,
    });
    const pid = child.pid;
    if (pid !== undefined) groups.add(pid);
    const arm = () => {
      started = performance.now();
      deadline = setTimeout(() => {
        timedOut = true;
        signalGroup(pid, 'SIGTERM');
        escalation = setTimeout(() => signalGroup(pid, 'SIGKILL'), killGraceMs);
      }, options.timeoutMs);
    };
    if (options.lock) child.stdio[3]?.once('data', arm);
    else arm();
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream]?.on('data', (chunk: Buffer) => {
        if (sizes[stream] < outputLimit)
          output[stream].push(chunk.subarray(0, outputLimit - sizes[stream]));
        sizes[stream] += chunk.length;
      });
    }
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(escalation);
      if (pid !== undefined) groups.delete(pid);
      resolve({
        exitCode,
        signal,
        timedOut,
        error,
        stdout: text('stdout'),
        stderr: text('stderr'),
        wallMs: (ended ?? performance.now()) - started,
        lockWaitMs: options.lock ? started - spawned : null,
      });
    };
    child.on('error', (cause) => {
      error = cause.message;
      if (pid === undefined) finish(null, null);
    });
    child.on('exit', (exitCode, signal) => {
      ended = performance.now();
      signalGroup(pid, 'SIGKILL');
      // A daemon that left the process group can hold the pipes open; stop reading after a moment.
      setTimeout(() => {
        for (const stream of child.stdio) stream?.destroy();
        finish(exitCode, signal);
      }, 2000).unref();
    });
    child.on('close', finish);
  });
}

async function git(cwd: string, args: string[], config: Config): Promise<string> {
  const env = { ...environment(config), ...gitEnv };
  const { stdout } = await execFileAsync('git', args, { cwd, env, maxBuffer: outputLimit });
  return stdout;
}

const firstLine = (text: string) =>
  text
    .split('\n')
    .find((line) => line.trim())
    ?.trim() ?? '';
const lastLine = (text: string) => text.trim().split('\n').at(-1)?.trim() ?? '';
const tail = (text: string) => text.slice(-tailLength);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function versionOf(contestant: Contestant, config: Config): Promise<string | null> {
  if (!contestant.version) return null;
  const outcome = await execute(fill(contestant.version, { bench }), {
    cwd: root,
    env: environment(config, contestant),
    timeoutMs: 30_000,
  });
  if (outcome.error) fail(`${contestant.name} cannot run: ${outcome.error}`);
  return firstLine(outcome.stdout) || firstLine(outcome.stderr) || null;
}

function harnessRevision(): string | null {
  const head = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (head.status !== 0) return null;
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  return `${head.stdout.trim()}${status.stdout.trim() ? '-dirty' : ''}`;
}

async function runJob(
  job: Job,
  context: { config: Config; versions: Record<string, string | null>; logs: string; lock?: string },
): Promise<ResultRow> {
  const { task, contestant } = job;
  const startedAt = new Date().toISOString();
  const row: ResultRow = {
    task: task.id,
    contestant: contestant.name,
    version: context.versions[contestant.name] ?? null,
    run: job.run,
    startedAt,
    pass: false,
    wallMs: 0,
    lockWaitMs: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    error: null,
    check: { exitCode: null, detail: 'not run', wallMs: 0, timedOut: false },
    usage: unknownUsage(),
    stdoutTail: '',
    stderrTail: '',
  };
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), `bench-${task.id}-`)));
  workDirs.add(dir);
  try {
    await cp(path.join(task.dir, 'fixture'), dir, { recursive: true });
    await git(dir, ['init', '--quiet', '--initial-branch=main'], context.config);
    await git(dir, ['add', '--all'], context.config);
    await git(
      dir,
      ['commit', '--quiet', '--no-verify', '--message', 'Task fixture'],
      context.config,
    );

    const outcome = await execute(fill(contestant.command, { prompt: task.prompt, dir, bench }), {
      cwd: dir,
      env: environment(context.config, contestant),
      timeoutMs: task.timeoutSec * 1000,
      lock: context.lock,
    });
    const diff = await git(dir, ['add', '--all'], context.config)
      .then(() => git(dir, ['diff', '--cached', '--stat', '--patch', '--no-color'], context.config))
      .catch((error: unknown) => `No diff: ${message(error)}\n`);
    const check = await execute(fill(task.check, { task: task.dir, dir, bench }), {
      cwd: dir,
      env: environment(context.config),
      timeoutMs: checkTimeoutMs,
    });

    const base = path.join(context.logs, `${task.id}.${contestant.name}.${job.run}`);
    await Promise.all([
      writeFile(`${base}.stdout`, outcome.stdout),
      writeFile(`${base}.stderr`, outcome.stderr),
      writeFile(`${base}.diff`, diff),
      writeFile(`${base}.check`, check.stdout + check.stderr),
    ]);
    Object.assign(row, {
      pass: outcome.error === null && !outcome.timedOut && check.exitCode === 0,
      wallMs: Math.round(outcome.wallMs),
      lockWaitMs: outcome.lockWaitMs === null ? null : Math.round(outcome.lockWaitMs),
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      error: outcome.error,
      check: {
        exitCode: check.exitCode,
        detail: (lastLine(check.stdout) || lastLine(check.stderr) || check.error || '').slice(
          0,
          300,
        ),
        wallMs: Math.round(check.wallMs),
        timedOut: check.timedOut,
      },
      usage: parseUsage(contestant.usage, outcome.stdout, outcome.stderr),
      stdoutTail: tail(outcome.stdout),
      stderrTail: tail(outcome.stderr),
    });
  } catch (error) {
    row.error = message(error);
  } finally {
    await rm(dir, { recursive: true, force: true });
    workDirs.delete(dir);
  }
  return row;
}

function pick<T>(items: T[], list: string, kind: string, name: (item: T) => string): T[] {
  const wanted = [...new Set(list.split(',').map((item) => item.trim()))].filter(Boolean);
  if (!wanted.length) fail(`Name at least one ${kind}.`);
  return wanted.map(
    (id) =>
      items.find((item) => name(item) === id) ??
      fail(`Unknown ${kind} ${id}. Available: ${items.map(name).join(', ')}.`),
  );
}

function count(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) fail(`${flag} must be a positive whole number.`);
  return number;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      contestants: { type: 'string' },
      tasks: { type: 'string' },
      runs: { type: 'string', default: '3' },
      out: { type: 'string', default: path.join(bench, 'results') },
      lock: { type: 'string' },
      parallel: { type: 'string', default: '1' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const config = await loadConfig();
  const available = await loadTasks();
  if (!values.contestants)
    fail(`${usage}\n\nContestants: ${config.contestants.map((c) => c.name).join(', ')}.`);
  const contestants = pick(config.contestants, values.contestants, 'contestant', (c) => c.name);
  const tasks = values.tasks ? pick(available, values.tasks, 'task', (t) => t.id) : available;
  if (!tasks.length) fail(`No tasks in ${path.join(bench, 'tasks')}.`);
  const runs = count(values.runs, '--runs');
  const parallel = count(values.parallel, '--parallel');
  const lock = values.lock ? path.resolve(values.lock) : undefined;
  if (lock && spawnSync('flock', ['--version']).error) fail('--lock needs flock (util-linux).');
  for (const contestant of contestants) fill(contestant.command, { prompt: '', dir: '', bench });

  const versions: Record<string, string | null> = {};
  for (const contestant of contestants)
    versions[contestant.name] = await versionOf(contestant, config);
  const startedAt = new Date().toISOString();
  const out = path.join(path.resolve(values.out), startedAt.replace(/[:.]/g, '-'));
  const logs = path.join(out, 'logs');
  await mkdir(logs, { recursive: true });
  const meta: RunMeta = {
    startedAt,
    finishedAt: null,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    harness: harnessRevision(),
    tasks: tasks.map((task) => task.id),
    versions,
    runs,
    parallel,
    lock: lock ?? null,
  };
  const writeMeta = () =>
    writeFile(path.join(out, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  await writeMeta();

  // Interleave contestants and tasks so slow periods and rate limits spread across all of them.
  const jobs: Job[] = [];
  for (let run = 1; run <= runs; run++)
    for (const task of tasks)
      for (const contestant of contestants) jobs.push({ task, contestant, run });
  const results = path.join(out, 'results.jsonl');
  let next = 0;
  let done = 0;
  let writing = Promise.resolve();
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      const row = await runJob(job, { config, versions, logs, lock });
      writing = writing.then(() => appendFile(results, `${JSON.stringify(row)}\n`));
      await writing;
      const status = row.error
        ? `error (${row.error})`
        : row.timedOut
          ? 'timeout'
          : row.pass
            ? 'pass'
            : 'fail';
      console.log(
        `[${++done}/${jobs.length}] ${row.task} · ${row.contestant} · run ${row.run}: ${status} in ${(row.wallMs / 1000).toFixed(1)} s · ${row.check.detail}`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, worker));
  meta.finishedAt = new Date().toISOString();
  await writeMeta();
  const markdown = await writeReport([out], out);
  const shown = path.relative(process.cwd(), out);
  console.log(`\n${markdown}\nResults: ${shown.startsWith('..') ? out : shown}`);
}

function interrupt(): void {
  for (const pid of groups) signalGroup(pid, 'SIGKILL');
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
  process.exit(130);
}
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);

try {
  await main();
} catch (error) {
  console.error(message(error));
  process.exitCode = 1;
}
