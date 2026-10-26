# ArnCode

A Claude coding agent built for multiple accounts. Mix API keys and OAuth tokens in a metered credential bank, rotate automatically when an account reaches a limit, and continue the same task with another available credential.

Full access is the default: ArnCode writes files and runs commands without permission prompts. Use `--safe` to ask before changes. Run ArnCode in a VM, container, or sandbox; a [Docker example](#run-in-a-container) is included below.

Skills load their full instructions only when needed. Stable prompt prefixes are cached, large tool results are bounded, and saved conversations let you resume work from the terminal or a shell pipeline.

## Features

- A mixed credential bank with multiple API keys and OAuth accounts, priorities, usage metering, reset times, and automatic failover.
- Full access by default, with optional approval prompts through `--safe` or `--ask`.
- Global and project skills discovered by name and description, with full content loaded on demand.
- Streaming responses, tool summaries, edit diffs, interactive commands, and piped input.
- File reading, writing, exact replacement, directory listing, glob search, text search, and managed shell execution.
- Saved sessions, per-account token counts and estimated costs, adaptive thinking, effort selection, and fast mode.

## Install

Requires Node.js 20.19 or newer and Bash. Linux and macOS support shell process-group cleanup. For Windows, use WSL.

Clone this repository, then run these commands from its directory:

```sh
npm ci
npm run build
npm link
arncode --help
```

Run `arncode` inside the project you want to work on. On first launch in a terminal, it offers credential setup if no enabled credentials are available.

```sh
cd /path/to/project
arncode
```

## Credentials

Add an API key or an OAuth token to the local bank. The token prompt is hidden. Obtain a long-lived OAuth token with `claude setup-token` in the official Claude CLI.

```sh
arncode creds add personal --type oauth --priority 0
arncode creds add work --type api-key --priority 10
arncode creds list
```

`--type` defaults to `oauth`. Lower priority numbers are tried first; equal priorities retain insertion order. Tokens can also arrive on stdin:

```sh
arncode creds add work --type api-key < /path/to/private-token-file
```

| Command                                                           | Action                                         |
| ----------------------------------------------------------------- | ---------------------------------------------- |
| `arncode creds list`                                              | Show names, types, masked suffixes, and status |
| `arncode creds add <name> [--type oauth\|api-key] [--priority n]` | Store a credential                             |
| `arncode creds remove <name>`                                     | Remove a stored credential                     |
| `arncode creds enable <name>`                                     | Include a credential in selection              |
| `arncode creds disable <name>`                                    | Exclude a credential from selection            |
| `arncode creds test <name>`                                       | Run a tiny Haiku request using that credential |
| `arncode creds usage`                                             | Show persisted usage by credential             |
| `arncode creds stats`                                             | Show credential usage statistics               |
| `arncode auth use <name>`                                         | Prefer this credential for future sessions     |

`creds test` contacts Anthropic and can incur a small charge. The automated test suite uses mocks and makes no paid requests.

The profile commands `arncode auth add`, `auth list`, and `auth remove` are also supported. `auth list` shows names and types only.

### Selection and failover

By default, ArnCode can use both credential types. It tries the preference saved by `auth use`, then enabled credentials in priority order. `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` provide environment fallbacks; they are not copied into the bank.

```sh
arncode --auth api-key                 # Restrict selection to API keys
arncode --auth oauth                   # Restrict selection to OAuth tokens
arncode --credential work              # Pin one account; never rotate
arncode --profile work                 # Alias for --credential
```

`auth use` sets a preference and still permits failover. `--credential`, `--profile`, and `ARNCODE_PROFILE` pin one credential. Environment credentials can be pinned as `env:api-key` or `env:oauth`.

A rate limit, subscription window limit, billing failure, or invalid credential marks that account exhausted. ArnCode records the provider's reset time when available, otherwise applies a cooldown, and tries the next healthy credential. Exhausted credentials become eligible again after their reset time. When none are available, it stops with a concrete reason instead of waiting indefinitely.

API-key rotation keeps the message history. Switching between API-key and OAuth engines carries the task transcript and completed tool results as context. Long transcripts are bounded; hidden thinking and provider-specific session state do not transfer between engines.

### Auth backends

API-key mode uses `@anthropic-ai/sdk`. Set `ANTHROPIC_API_KEY`, add a stored API key, or use `--base-url` / `ANTHROPIC_BASE_URL` for a compatible Messages API endpoint.

OAuth mode uses `query()` from `@anthropic-ai/claude-agent-sdk`. ArnCode removes `ANTHROPIC_API_KEY`, competing Anthropic settings, and provider-selection variables from the SDK child environment, then supplies the selected `CLAUDE_CODE_OAUTH_TOKEN`. It never sends an OAuth token directly to the Messages API. Custom API base URLs apply only to API-key mode.

## Usage

```sh
arncode --cwd /path/to/project
arncode -p "Explain the authentication flow"
arncode -p "Add a regression test for empty input"
arncode --safe
printf 'Find unused exports\n' | arncode --auth api-key
arncode -p < task.txt
arncode --model claude-haiku-5-5 --effort low -p "List the entry points"
arncode --continue
arncode --resume <session-id>
```

Assistant text goes to stdout. Progress, tools, diffs, and usage summaries go to stderr, so responses can be redirected:

```sh
arncode -p "Describe this project in one paragraph" > description.txt
```

| Option                                     | Default / behavior                                           |
| ------------------------------------------ | ------------------------------------------------------------ |
| `-p, --print [prompt]`                     | Run once; read stdin when the prompt is omitted              |
| `--cwd <directory>`                        | Current directory                                            |
| `--auth api-key\|oauth`                    | Restrict the credential bank to one type                     |
| `--credential <name>`, `--profile <name>`  | Pin one credential without failover                          |
| `--model <id>`                             | `claude-opus-5-5`                                            |
| `--base-url <url>`                         | Anthropic's API endpoint; API-key mode only                  |
| `--effort low\|medium\|high\|xhigh\|max`   | `medium`                                                     |
| `--fast`                                   | Request fast mode; availability depends on the model/account |
| `--max-tokens <n>`                         | `64000` per API response                                     |
| `--max-turns <n>`                          | `80` per task                                                |
| `--continue`                               | Resume the newest session for this directory                 |
| `--resume <id>`                            | Resume a saved session                                       |
| `--safe`, `--ask`                          | Ask before writes, edits, and shell commands                 |
| `--yolo`, `--dangerously-skip-permissions` | Compatibility aliases for the default full-access mode       |

The API backend always streams and uses adaptive thinking. If a response reaches its output limit, ArnCode handles the incomplete response explicitly and bounds continuation attempts. API rate-limit and overload retries are capped at four; `retry-after` and rate-limit reset headers inform the delay. Account-specific failures can trigger bank failover; a transient overload does not exhaust an account.

## Interactive commands

| Command                                   | Action                                         |
| ----------------------------------------- | ---------------------------------------------- |
| `/help`                                   | Show available commands                        |
| `/model [id\|list]`                       | Show, change, or list models                   |
| `/auth [api-key\|oauth\|auto]`            | Show or change the credential type restriction |
| `/mode [full\|ask]`                       | Show or change permissions                     |
| `/fast [on\|off]`                         | Show or change fast mode                       |
| `/effort [low\|medium\|high\|xhigh\|max]` | Show or change effort                          |
| `/clear`                                  | Start a fresh conversation                     |
| `/cost`                                   | Show session token usage and estimated cost    |
| `/creds`                                  | Show the credential bank                       |
| `/usage`                                  | Show usage by credential                       |
| `/exit`                                   | Leave the session                              |

## Permissions and tools

In `full` mode, the default, tools run without approval prompts. Choose `arncode --safe`, `arncode --ask`, or `/mode ask` for approval before each file write, edit, and shell command. In that mode, `y` permits one call, `n` denies it, and `always` permits that tool for the current process. Reads and searches run immediately. Changing permission mode clears remembered approvals.

In ask mode without an interactive terminal, actions requiring approval are denied immediately with an explanation. Full mode also works in pipes and unattended jobs. `--yolo` and `--dangerously-skip-permissions` remain accepted aliases for full mode. The interactive aliases `/mode yolo`, `/mode safe`, and `/mode default` map to full, ask, and full respectively.

The API backend's file tools resolve paths inside the project and reject symlinks that escape it. Shell commands run with your account's filesystem and network access; permission prompts are not a sandbox. Shell output is bounded, and the managed process group is stopped on timeout, cancellation, or shell exit. Persistent background servers are not supported. Shell timeouts default to two minutes and can be requested up to thirty minutes.

OAuth uses the Agent SDK's native tools and filesystem rules, with the same selected permission mode. In ask mode, ArnCode's approvals apply through SDK hooks and callbacks.

## Run in a container

Build the image from the included [Dockerfile](Dockerfile), then mount the project you want to edit:

```sh
docker build -t arncode .
cd /path/to/project
docker run --rm -it \
  --mount type=bind,src="$PWD",dst=/work \
  --mount type=volume,src=arncode-state,dst=/home/node/.arncode \
  arncode
```

The image runs as the non-root `node` user and includes Bash, Git, and FFmpeg. The project must be writable by that user (UID 1000). First-run credential setup stores the bank in the named volume, so it survives container removal. Only mount the project you intend to edit; use a VM when you need stronger isolation.

## Skills and project instructions

Place reusable skills in `~/.arncode/skills/<skill-name>/SKILL.md` or a project's `.arncode/skills/<skill-name>/SKILL.md`. ArnCode also discovers `~/.claude/skills` and project `.claude/skills`. Project skills take precedence over global ones; `.arncode` takes precedence over `.claude` within each scope.

Each skill has frontmatter with a name and description:

```md
---
name: review-change
description: Review a change for behavior regressions and missing validation.
---

Read the diff and its surrounding code. Check the affected user journey and run
relevant existing tests. Report concrete defects with file locations.
```

Only the name and description enter the initial system prompt. When a task needs the skill, the agent loads its body through the `skill` tool. For example, ask: `Use review-change to review the staged diff.` Both API-key and OAuth engines receive the same skill catalog and can load the same instructions on demand.

ArnCode also loads global `~/.arncode/AGENTS.md` and the project's root `AGENTS.md` and `CLAUDE.md`. Keep always-applicable rules there and task-specific procedures in skills. Stable system and tool definitions use prompt caching; full skill bodies stay out of the initial context.

## Configuration and storage

Settings resolve in this order: command-line flags, environment variables, `~/.arncode/config.json`, then defaults. Setting `auth` in configuration also restricts the credential type; `auth use` clears that restriction and saves a preferred account. Store configuration without credentials:

```json
{
  "model": "claude-opus-5-5",
  "effort": "medium",
  "fast": false,
  "maxTokens": 64000,
  "maxTurns": 80,
  "permissionMode": "full"
}
```

Set `"permissionMode": "ask"` to make approval prompts your persistent preference.

Supported environment settings are `ARNCODE_AUTH`, `ARNCODE_PROFILE`, `ARNCODE_MODEL` (or `ANTHROPIC_MODEL`), `ANTHROPIC_BASE_URL`, `ARNCODE_EFFORT`, `ARNCODE_FAST`, `ARNCODE_MAX_TOKENS`, and `ARNCODE_MAX_TURNS`. Boolean values accept `true`, `false`, `1`, or `0`. See [.env.example](.env.example) for names; ArnCode does not automatically load `.env` files.

Set `ARNCODE_CONFIG_DIR` to keep configuration, credentials, usage, sessions, and global ArnCode instructions and skills in a different directory. Relative paths resolve from the current working directory. Credential storage must stay outside Git repositories.

| Location                      | Contents                                                               |
| ----------------------------- | ---------------------------------------------------------------------- |
| `~/.arncode/config.json`      | Preferences and credential preference                                  |
| `~/.arncode/credentials.json` | Credential bank                                                        |
| `~/.arncode/usage.json`       | Requests, tokens, costs, errors, limit hits, last use, and reset times |
| `~/.arncode/sessions/`        | Conversations and resume metadata                                      |

The directory uses mode `700`; private JSON files use mode `600` and atomic writes. Credentials stay outside the project. Registered secrets and Anthropic token patterns are redacted from ArnCode output and saved conversations. Native SDK session logging is disabled; OAuth resumes from ArnCode's redacted transcript. This preserves task context without carrying native thinking blocks between turns.

Usage records distinguish input, output, cache reads, and cache writes. Cost figures are estimates, not invoices. Unknown models, custom endpoints, or unsupported pricing combinations report unpriced usage. OAuth reports the SDK's usage estimate; it does not represent your subscription bill or remaining quota.

## Architecture

| Module                                                                   | Responsibility                                                              |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| [`src/cli.ts`](src/cli.ts), [`src/runner.ts`](src/runner.ts)             | Commands, task coordination, and credential failover                        |
| [`src/engines/api.ts`](src/engines/api.ts)                               | Streaming Messages API loop, tool calls, caching, and output-limit handling |
| [`src/engines/oauth.ts`](src/engines/oauth.ts)                           | Official SDK integration, context transfer, and tool hooks                  |
| [`src/tools/`](src/tools/)                                               | File operations, searches, and managed shell processes                      |
| [`src/auth.ts`](src/auth.ts), [`src/config.ts`](src/config.ts)           | Credential bank, environment isolation, and configuration                   |
| [`src/metering.ts`](src/metering.ts), [`src/usage.ts`](src/usage.ts)     | Persistent counters and cost estimates                                      |
| [`src/failures.ts`](src/failures.ts), [`src/backoff.ts`](src/backoff.ts) | Failure classification, reset times, and bounded retries                    |
| [`src/skills.ts`](src/skills.ts), [`src/prompt.ts`](src/prompt.ts)       | Skill discovery, on-demand content, and project instructions                |
| [`src/session.ts`](src/session.ts)                                       | Saved history and context transfer between backends                         |
| [`src/ui.ts`](src/ui.ts), [`src/permissions.ts`](src/permissions.ts)     | Terminal rendering and approval decisions                                   |
| [`src/redact.ts`](src/redact.ts), [`src/storage.ts`](src/storage.ts)     | Stream-safe redaction and private storage                                   |

The implementation uses the current [Messages API](https://platform.claude.com/docs/en/api/messages), [tool-use protocol](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview), and [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). Pricing assumptions are recorded alongside the code and based on [Anthropic's published pricing](https://platform.claude.com/docs/en/about-claude/pricing).

## Development

```sh
npm ci
npm run typecheck
npm test
npm run lint
npm run build
npm run dev -- --help
```

Tests cover tool effects, full-access and ask modes, skill discovery, configuration, credential rotation, redaction, retries, sessions, and metering without calling a paid API. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

## Roadmap

- Token-aware conversation compaction with explicit summaries.
- Additional tool integrations and optional web retrieval.
- More usage and session inspection commands.
- Broader platform coverage for subprocess lifecycle handling.

## License

ArnCode is [MIT licensed](LICENSE). Dependencies retain their own licenses; the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) is distributed under Anthropic's separate terms.
