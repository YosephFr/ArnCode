import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { StreamingRedactor } from '../redact.js';

/** Output a job keeps for reading; older text is dropped first. */
const MAX_BUFFER = 1_000_000;
/** About 10k tokens per read, keeping the newest output. */
const MAX_READ = 40_000;

interface Job {
  id: string;
  command: string;
  child: ChildProcess;
  output: string;
  /** Characters of `output` already returned to the model. */
  read: number;
  /** Characters dropped from the front of `output` to bound memory. */
  dropped: number;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
}

const jobs = new Map<string, Job>();
let counter = 0;

// The group is signalled even after its shell exits: a server it started may still be running.
function stopGroup(job: Job, signal: NodeJS.Signals): void {
  if (!job.child.pid) return;
  try {
    if (process.platform === 'win32') job.child.kill(signal);
    else process.kill(-job.child.pid, signal);
  } catch {
    // Already gone.
  }
}

function status(job: Job): string {
  if (!job.exit) return `${job.id} is running.`;
  return job.exit.signal
    ? `${job.id} was stopped by ${job.exit.signal}.`
    : `${job.id} exited with code ${job.exit.code}.`;
}

/** Output written since the last read, newest kept when there is more than one read holds. */
function unread(job: Job): string {
  const start = Math.max(0, job.read - job.dropped);
  let text = job.output.slice(start);
  job.read = job.dropped + job.output.length;
  if (text.length > MAX_READ)
    text = `[${text.length - MAX_READ} earlier characters omitted]\n${text.slice(-MAX_READ)}`;
  return text;
}

/**
 * Start a command in its own process group and return after a moment, with what it printed so
 * far, so an immediate failure such as a port in use shows up at once.
 */
export async function startJob(command: string, cwd: string, waitMs = 1000): Promise<string> {
  const id = `bash_${++counter}`;
  const child = spawn('bash', ['-c', command], {
    cwd,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const job: Job = { id, command, child, output: '', read: 0, dropped: 0 };
  jobs.set(id, job);
  const redactor = new StreamingRedactor();
  const append = (text: string) => {
    job.output += text;
    if (job.output.length > MAX_BUFFER) {
      const cut = job.output.length - MAX_BUFFER;
      job.output = job.output.slice(cut);
      job.dropped += cut;
    }
  };
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => append(redactor.write(chunk)));
  }
  const exited = new Promise<void>((resolve) => {
    child.on('error', (error) => {
      append(`\n${error.message}\n`);
      job.exit ??= { code: null, signal: null };
      resolve();
    });
    child.on('exit', (code, signal) => {
      append(redactor.flush());
      job.exit = { code, signal };
      resolve();
    });
  });
  await Promise.race([exited, delay(waitMs, undefined, { ref: false })]);
  const output = unread(job);
  return `${job.exit ? status(job) : `Started ${id} in the background.`}${output ? `\n${output}` : ''}`;
}

/** New output from a job and whether it is still running. */
export function readJob(id: string): string {
  const job = jobs.get(id);
  if (!job) throw new Error(`No background command ${id}. ${listJobs()}`);
  const output = unread(job);
  return `${status(job)}\n${output || '[No new output]'}`;
}

/** Stop a job's whole process group: TERM first, KILL if it lingers. */
export async function stopJob(id: string): Promise<string> {
  const job = jobs.get(id);
  if (!job) throw new Error(`No background command ${id}. ${listJobs()}`);
  await stopGracefully(job);
  jobs.delete(id);
  return `Stopped ${id}.`;
}

async function stopGracefully(job: Job): Promise<void> {
  stopGroup(job, 'SIGTERM');
  if (!job.exit)
    await Promise.race([
      new Promise((resolve) => job.child.once('exit', resolve)),
      delay(1000, undefined, { ref: false }),
    ]);
  stopGroup(job, 'SIGKILL');
}

function listJobs(): string {
  const running = [...jobs.values()].filter((job) => !job.exit).map((job) => job.id);
  return running.length ? `Running: ${running.join(', ')}.` : 'None are running.';
}

/** Stop every job when a session ends. */
export async function stopAllJobs(): Promise<void> {
  await Promise.all([...jobs.values()].map(stopGracefully));
  jobs.clear();
}

/** Last resort from an exit handler, where nothing can wait. */
export function killAllJobs(): void {
  for (const job of jobs.values()) stopGroup(job, 'SIGKILL');
  jobs.clear();
}
