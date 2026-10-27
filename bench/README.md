# Benchmarks

Runs several coding agents on the same small tasks, several times each, checks their work automatically, and reports pass rate, wall time, tokens and cost. Everything a run needs lives in this directory: tasks, fixtures, checks, contestant commands and a mock agent.

## Run

```sh
# Smoke test with the deterministic mock agent: no model calls
npx tsx bench/run.ts --contestants mock --runs 1

# Real agents, three runs of every task each
BENCH_ARNCODE_CREDENTIAL=personal npx tsx bench/run.ts --contestants arncode,claude-code,opencode,codex

# Two tasks, holding a lock shared with other heavy jobs on the machine
npx tsx bench/run.ts --contestants arncode,codex --tasks fix-bug,read-chart --lock /tmp/heavy-jobs.lock
```

| Option                | Default         | Meaning                                                      |
| --------------------- | --------------- | ------------------------------------------------------------ |
| `--contestants <a,b>` | required        | Entries from `contestants.json`                              |
| `--tasks <a,b>`       | all             | Directories under `tasks/`                                   |
| `--runs <n>`          | 3               | Runs per task and contestant                                 |
| `--out <dir>`         | `bench/results` | Where the timestamped results directory goes                 |
| `--lock <file>`       | off             | Holds `flock <file>` for the duration of each contestant run |
| `--parallel <n>`      | 1               | Runs at the same time                                        |

Runs are interleaved (run 1 of every task and contestant, then run 2, and so on) so slow periods and rate limits spread across contestants. Each invocation writes `bench/results/<timestamp>/`:

- `results.jsonl`: one line per run.
- `meta.json`: Node version, platform, harness commit (`-dirty` with local changes), contestant versions from `--version`, and the options.
- `logs/<task>.<contestant>.<run>.*`: full stdout and stderr, the agent's changes as a Git diff, and the check output.
- `report.md` and `report.json`: the aggregate.

Rebuild or merge reports with `npx tsx bench/report.ts <results dir>... [--out <dir>]`.

## What a run does

1. Copies the task's `fixture/` into a new temporary directory and commits it to a fresh Git repository, with a fixed author and date so every run starts from the same commit.
2. Runs the contestant there with the task prompt and nothing on stdin, in its own process group. At the task's `timeoutSec` the group gets SIGTERM, then SIGKILL 5 seconds later. Background processes left behind are killed when the contestant exits.
3. Runs the task check in the same directory. A run passes when the check exits 0 and the contestant finished in time.
4. Parses the contestant's usage report, appends the result, saves the logs and deletes the directory.

Each `results.jsonl` line holds `task`, `contestant`, `version`, `run`, `startedAt`, `pass`, `wallMs`, `lockWaitMs`, `exitCode`, `signal`, `timedOut`, `error` (the contestant could not start), `check` (`exitCode`, `detail`, `wallMs`, `timedOut`), `usage` and the last 2,000 characters of stdout and stderr.

`usage` has `inputTokens` (uncached input), `outputTokens` (including reasoning), `cacheReadTokens`, `cacheWriteTokens`, `costUsd` (the tool's estimate) and `turns` (model requests). Figures a tool does not report stay `null`:

| Parser        | Reads                                     | Tokens                                                                | Cost                                                                    | Turns       |
| ------------- | ----------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------- |
| `arncode`     | the `Session:` line on stderr             | as printed                                                            | `$X estimated`; null when unavailable, partly unpriced or under $0.0001 | null        |
| `claude-code` | the `--output-format json` result         | `modelUsage` summed over models; `usage` (main loop only) when absent | `total_cost_usd`                                                        | `num_turns` |
| `opencode`    | `step_finish` events from `--format json` | output plus reasoning; cache reads and writes as reported             | sum of step costs                                                       | step count  |
| `codex`       | `turn.completed` events from `--json`     | uncached is input minus cached reads and cache writes                 | null                                                                    | null        |
| `none`        | nothing                                   | null                                                                  | null                                                                    | null        |

The report shows, per task and contestant, the pass rate, median and nearest-rank p90 time, and mean tokens and cost. Means skip runs that reported nothing and show how many runs they cover, such as `0.1234 (2/3)`.

## Tasks

| Task             | The agent must                                                     | The check                                                                                        |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `fix-bug`        | Fix the library bug behind a failing `node --test` suite           | The suite is unchanged and passes, and hidden tests confirm the fix is general                   |
| `implement-spec` | Implement `expandRanges` from `SPEC.md`                            | Hidden tests, one per rule                                                                       |
| `cli-flag`       | Add `--lines`/`-l` to a tiny CLI, with tests                       | The flag works on unseen files, the suite passes, and it fails once the original CLI is restored |
| `read-chart`     | Read `chart.png` and write the tallest bar's label to `answer.txt` | Exact label, so it shows whether the agent can see images                                        |

`tasks/read-chart/make-chart.mjs` draws the chart with `pngjs`; it holds the answer, so it stays outside the fixture. Run it to rewrite `chart.png`, or with `--check` to confirm the committed image matches.

### Add a task

1. Create `tasks/<id>/fixture/` with the starting files. Keep it tiny; it becomes the agent's whole project.
2. Add `tasks/<id>/task.json`:

   ```json
   {
     "prompt": "What the agent should do",
     "timeoutSec": 600,
     "check": ["node", "{task}/check.mjs"]
   }
   ```

3. Write the check. It runs in the work directory after the contestant exits, prints one line, and exits 0 only when the task is solved. `{task}` is the task directory and `{dir}` the work directory. `lib/checks.mjs` has `finish()` and `nodeTests()`. Keep hidden tests and answers outside `fixture/`.
4. `npx vitest run test/bench.test.ts` confirms every check rejects its untouched fixture. Teach `contestants/mock.mjs` the solution and extend the test if the end-to-end run should cover the new task.

## Contestants

| Name          | Command                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `arncode`     | `arncode -p {prompt} --cwd {dir} --credential {env:BENCH_ARNCODE_CREDENTIAL}`, without `ANTHROPIC_API_KEY`                     |
| `claude-code` | `claude -p {prompt} --output-format json --dangerously-skip-permissions --no-session-persistence`, without `ANTHROPIC_API_KEY` |
| `opencode`    | `opencode run --format json --dir {dir} --auto {prompt}`                                                                       |
| `codex`       | `codex exec --json --cd {dir} --dangerously-bypass-approvals-and-sandbox --ephemeral --color never {prompt}`                   |
| `mock`        | `node {bench}/contestants/mock.mjs -p {prompt} --cwd {dir}`                                                                    |

Every contestant runs with full access in its throwaway directory and with the work directory as its current directory. Claude Code and OpenCode run with auto-update off so the version stays fixed during a benchmark. Set `BENCH_ARNCODE_CREDENTIAL` to a name from `arncode creds list`; pinning one credential keeps failover from switching accounts mid-run.

### Add a contestant

Add an entry to `contestants.json`:

```json
{
  "name": "my-agent",
  "command": ["my-agent", "run", "--cwd", "{dir}", "{prompt}"],
  "version": ["my-agent", "--version"],
  "env": { "MY_AGENT_NO_UPDATE": "1" },
  "unsetEnv": ["OPENAI_API_KEY"],
  "usage": "none"
}
```

`command` is an argv array, never a shell string: `{prompt}` becomes one argument exactly as written. Placeholders are `{prompt}`, `{dir}`, `{bench}` (this directory) and `{env:NAME}`, which must be set when the run starts. The top-level `unsetEnv` removes, for every contestant, the variables that a calling agent session or Git hook sets, so a benchmark started from inside an agent behaves like one started from a plain shell. For a new output format, add a parser to `usage.ts`.

## Caveats

- Shared-lock waits: with `--lock`, wall time and the timeout start once the lock is held, and the wait is stored as `lockWaitMs`, so elapsed time is wall time plus that wait. Jobs that do not take the lock still compete for the machine and inflate times.
- Costs are estimates from each tool's own prices, not bills. Subscription runs report an equivalent cost only when the tool provides one: ArnCode and Claude Code estimate it, OpenCode prices from its model table and may report $0 for subscription providers, and Codex reports no cost, so its column stays n/a.
- Tools count tokens differently. Claude Code's `modelUsage` includes subagents and helper models; OpenCode's events leave out its subagents' usage.
- Contestants use your own configuration: global instructions, plugins, MCP servers and default models all change behavior and tokens. Add a model flag to each command to compare agents on the same model.
- `arncode` comes from your `PATH`; run `npm run build && npm link` to benchmark this checkout.
- A handful of runs gives a rough signal. With fewer than 10 runs, p90 is close to the slowest run.
- `--parallel` runs compete for CPU and rate limits; keep it at 1 for timing comparisons.
- Cleanup stops the contestant's whole process group. A daemon that starts its own session with `setsid` outlives the run; the harness stops reading its output 2 seconds after the contestant exits.
