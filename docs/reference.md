# ArnCode reference

[Back to README](../README.md)

## Command-line options

| Option                                     | Behavior                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `-p, --print [prompt]`                     | Run once; read stdin when the prompt is omitted                            |
| `--output-format <format>`                 | With `-p`: `text` (default), `json`, or `stream-json`                      |
| `--cwd <directory>`                        | Work in this directory; defaults to the current directory                  |
| `--auth <type>`                            | Restrict credentials to `api-key` or `oauth`                               |
| `--credential <name>`, `--profile <name>`  | Pin one credential without failover                                        |
| `--model <id>`                             | Default: `claude-opus-5-5`                                                 |
| `--base-url <url>`                         | Compatible Messages API endpoint; API-key mode only                        |
| `--effort <level>`                         | `low`, `medium`, `high`, `xhigh`, or `max`; default: `medium`              |
| `--fast`, `--no-fast`                      | Enable or disable fast mode; default: off                                  |
| `--max-tokens <n>`                         | Maximum output tokens per API response; default: `64000`                   |
| `--max-turns <n>`                          | Maximum agent turns per task; default: `80`                                |
| `-c, --continue`                           | Resume the newest session for the selected directory                       |
| `-r, --resume [id]`                        | Resume a saved session; without an ID, choose from this project's sessions |
| `--permission-mode <mode>`                 | `full` (default), `edits`, `ask`, or `plan`                                |
| `--plan`                                   | Start in plan mode                                                         |
| `--safe`, `--ask`                          | Ask before writes, edits, and shell commands                               |
| `--yolo`, `--dangerously-skip-permissions` | Select the default full-access mode                                        |
| `--help`, `--version`                      | Show usage or version                                                      |

If both a prompt argument and piped input are present, ArnCode combines them. Assistant text goes to stdout, while progress, tools, diffs, and usage go to stderr:

```sh
arncode -p "Describe this project in one paragraph" > description.txt
```

`--output-format json` prints one result object on stdout when the run ends: `result` (the final reply), `subtype` (`success`, `error`, or `interrupted`), `is_error`, `session_id`, `model`, `credential`, `duration_ms`, `num_turns`, `total_cost_usd` (`null` when unpriced), and `usage` with input, output, cache-read, and cache-write tokens. `stream-json` prints one JSON event per line as the run happens (`init`, `progress`, `text`, `tool_use`, `tool_result`, `file_change`, `notice`), followed by the same result object.

The Messages API backend always streams and uses adaptive thinking. Output-limit continuation attempts are bounded, and incomplete tool calls are not executed.

On the official endpoint, requests also opt into these features where the model supports them: progress notes between tool calls (shown on stderr), server-side refusal fallback to another model, streamed tool input, and thinking blocks that degrade instead of failing when a resumed history no longer matches them. The conversation history is append-only: each conversation keeps the system prompt it started with, `/effort` changes apply through a message that keeps the prompt cache, and read-only tool calls from one response run in parallel. When the context passes `compactAt` tokens (default 200,000), the API summarizes the conversation and the task continues from the summary. Other endpoints receive only widely compatible fields and a bounded history; set `ARNCODE_API_FEATURES=full` for an endpoint that supports the official feature set. A request has at most four retries for rate-limit or overload responses. `retry-after` and rate-limit reset headers inform delays; a delay beyond the wait limit ends the attempt. Credential-specific failures may trigger failover, while a transient overload does not exhaust an account.

### Prompt caching

API-key requests set three explicit cache breakpoints: the last tool definition, the stable system prompt, and the final block of the latest user message, including tool results. The conversation breakpoint moves forward with each request so eligible unchanged history can be reused. All use the default five-minute ephemeral TTL. While tools run for longer than four minutes, a zero-output request refreshes the cache for the price of a cache read, so the next request does not write the whole conversation again.

Cache reuse depends on an unchanged prefix, the model's minimum cacheable prompt length, and provider support. Short prompts can report zero cache tokens even when caching is requested. See Anthropic's [prompt-caching rules](https://platform.claude.com/docs/en/build-with-claude/prompt-caching). OAuth caching is managed by the Agent SDK.

## Interactive commands

| Command           | Action                                                       |
| ----------------- | ------------------------------------------------------------ |
| `/help`           | Show commands                                                |
| `/model [id]`     | Choose the model; aliases `opus`, `sonnet`, `haiku`, `fable` |
| `/auth [type]`    | Show or select `api-key`, `oauth`, or `auto`                 |
| `/mode [mode]`    | Show or select `full`, `edits`, `ask`, or `plan`             |
| `/plan`           | Switch to plan mode                                          |
| `/fast [on/off]`  | Toggle fast mode, or set `on` / `off`                        |
| `/theme [name]`   | Choose `auto`, `dark`, `light`, or `plain` colors; saved     |
| `/effort [level]` | Show or change effort                                        |
| `/compact`        | Summarize the conversation to free context                   |
| `/context`        | Show context use and when the conversation is summarized     |
| `/todos`          | Show the agent's current checklist                           |
| `/status`         | Show the model, permissions, credential, and plan limits     |
| `/resume`         | Continue an earlier conversation in this project             |
| `/init`           | Write or improve `AGENTS.md` for this project                |
| `/mcp`            | Show MCP servers and their tools                             |
| `/export [file]`  | Save the conversation as Markdown in the project             |
| `/clear`          | Start a fresh conversation                                   |
| `/cost`           | Show session usage and estimated cost                        |
| `/creds`          | Show the credential bank                                     |
| `/usage`          | Show usage by credential                                     |
| `/exit`           | Leave the session                                            |

`/mode yolo` and `/mode default` select full access; `/mode safe` selects ask mode. An approval for a write or edit first shows the change it would make. Changing mode clears remembered session approvals. Without an interactive terminal, actions requiring approval are denied immediately with an explanation.

In plan mode, read-only tools run, file writes are limited to `.arncode/plans/`, and shell commands need approval. The agent presents its plan with `exit_plan_mode`; approving it chooses the mode for the work. Without a terminal, the plan is printed and the run stops.

### Custom commands

Save a prompt as Markdown to run it as a command. Project commands live in `.arncode/commands/` or `.claude/commands/`; personal ones in `~/.arncode/commands/` or `~/.claude/commands/`. The file name is the command, and folders become namespaces: `git/commit.md` runs as `/git:commit`. Project commands win over personal ones, and built-in commands cannot be replaced.

```md
---
description: Review a change for regressions
argument-hint: <path>
---

Review $ARGUMENTS for behavior regressions and missing tests.
```

`$ARGUMENTS` receives everything after the command; `$1` to `$9` receive single arguments, and quotes group words. Without placeholders, the arguments follow the prompt. Commands appear in `/help` and Tab completion.

### Keys

| Key                            | Action                                                              |
| ------------------------------ | ------------------------------------------------------------------- |
| Enter                          | Send; while the agent works, queue the message for the next turn    |
| Alt+Enter, Ctrl+J, `\` + Enter | New line                                                            |
| Esc                            | Interrupt the running turn                                          |
| Ctrl+C                         | Interrupt, or clear the input; press twice on an empty line to exit |
| Shift+Tab                      | Cycle permission modes                                              |
| Tab                            | Complete a command or an `@` file mention                           |
| Up, Down                       | Browse prompt history for this project                              |
| Ctrl+L                         | Clear the screen                                                    |

Large pastes are collapsed to one line in the input and sent in full.

## Credential commands

| Command                             | Action                                                         |
| ----------------------------------- | -------------------------------------------------------------- |
| `arncode creds add <name>`          | Add a credential from hidden input or stdin                    |
| `arncode creds list`                | Show names, types, masked suffixes, priorities, and status     |
| `arncode creds use <name>`          | Prefer an account while retaining failover                     |
| `arncode creds priority <name> <n>` | Set the order; lower values are tried first                    |
| `arncode creds rename <name> <new>` | Rename a credential, keeping its usage history                 |
| `arncode creds remove <name>`       | Remove a stored credential                                     |
| `arncode creds enable <name>`       | Include an account in selection                                |
| `arncode creds disable <name>`      | Exclude an account from selection                              |
| `arncode creds test <name>`         | Make a tiny Haiku request with that credential                 |
| `arncode creds usage`               | Show usage for each credential                                 |
| `arncode creds stats`               | Show aggregate requests, tokens, costs, errors, and limit hits |

`creds add` detects the type from the token (API keys and `claude setup-token` tokens look different); `--type api-key` or `--type oauth` sets it explicitly, and `--priority <integer>` sets the order (default: `0`). `creds list` and `/creds` show each credential's status, when a limited one is back, and the 5-hour and weekly plan use last reported for OAuth accounts. In an interactive session, `/creds` lets you prefer, turn off, check, or remove a credential. Lower priorities go first; equal priorities retain insertion order. For token input from a private file or password manager:

```sh
arncode creds add work --type api-key < /path/to/private-token-file
```

`arncode auth` is an alias for the credential command group. `auth list` shows names and types only. `auth use <name>` saves a preferred account and clears a persisted auth-type restriction.

`creds test` contacts Anthropic and can incur a small charge. The automated test suite makes no paid requests.

## Authentication and failover

The bank accepts multiple credentials of both types. Selection tries the saved preference, then enabled credentials by priority, then environment fallbacks. `--auth api-key` or `--auth oauth` restricts eligible credentials to that type; `/auth auto` removes the restriction in an interactive session.

`auth use` sets a preference. In contrast, `--credential`, `--profile`, and `ARNCODE_PROFILE` pin a credential and disable rotation. Environment credentials can be pinned as `env:api-key` or `env:oauth`.

Recognized rate-limit, subscription-limit, authentication, and billing failures mark the active credential exhausted. Reset times come from provider headers or SDK error information, with fallback cooldowns when no reset is supplied. Exhausted accounts become eligible again after reset. If no healthy account remains, the task stops with its session saved.

API-key rotation keeps the message history. Crossing between API-key and OAuth engines transfers the conversation transcript and completed tool results as context. Long transcripts are bounded, and hidden thinking and provider-specific session internals do not transfer. Resume with `--continue` after a reset or after adding a usable credential.

### API key

API-key mode uses `@anthropic-ai/sdk`. Supply `ANTHROPIC_API_KEY` or store a key in the bank. `--base-url` / `ANTHROPIC_BASE_URL` selects a compatible Messages API endpoint; model features and error formats depend on that endpoint.

### OAuth

OAuth uses `query()` from `@anthropic-ai/claude-agent-sdk`. Obtain a long-lived token with `claude setup-token` in the official Claude CLI, then store it or supply `CLAUDE_CODE_OAUTH_TOKEN`.

ArnCode strips `ANTHROPIC_API_KEY`, competing Anthropic settings, and provider-selection variables from the SDK child environment before supplying the selected token. OAuth tokens are never sent directly to the Messages API. Custom API base URLs apply only to API-key mode.

The Agent SDK keeps each OAuth conversation in `~/.arncode/claude` (private files, apart from your Claude Code history), so a follow-up resumes it: the model keeps its full history, and the request reads that history from the cache instead of sending it again. After a credential switch, an interruption, or a summary, ArnCode continues from its own redacted transcript in a new SDK session. Set `"oauthSessions": false` to keep no SDK session files; follow-ups then resend the redacted transcript. SDK background tasks are disabled; shell work runs in the foreground.

## Configuration and storage

Settings resolve in this order: command-line flags, environment variables, `~/.arncode/config.json`, then defaults. Configuration contains preferences, not credentials:

```json
{
  "model": "claude-opus-5-5",
  "effort": "medium",
  "fast": false,
  "maxTokens": 64000,
  "maxTurns": 80,
  "compactAt": 200000,
  "webTools": true,
  "oauthSessions": true,
  "permissionMode": "full",
  "theme": "auto"
}
```

Use `"permissionMode": "ask"` for persistent approval prompts. The `auto` theme follows the terminal's background; `NO_COLOR` turns colors off whatever the theme. A configured `auth` value restricts the credential type, and `profile` selects a preferred account. `auth use` clears the auth restriction while setting the preference.

| Environment variable               | Purpose                                                                |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                | API-key fallback                                                       |
| `CLAUDE_CODE_OAUTH_TOKEN`          | OAuth fallback                                                         |
| `ARNCODE_AUTH`                     | Restrict credential type                                               |
| `ARNCODE_PROFILE`                  | Pin a credential                                                       |
| `ARNCODE_MODEL`, `ANTHROPIC_MODEL` | Model; `ARNCODE_MODEL` takes precedence                                |
| `ANTHROPIC_BASE_URL`               | API-key endpoint                                                       |
| `ARNCODE_EFFORT`                   | Effort level                                                           |
| `ARNCODE_FAST`                     | Fast mode: `true`, `false`, `1`, or `0`                                |
| `ARNCODE_MAX_TOKENS`               | Maximum output tokens per API response                                 |
| `ARNCODE_MAX_TURNS`                | Maximum turns per task                                                 |
| `ARNCODE_COMPACT_AT`               | Context size in tokens at which API conversations are summarized       |
| `ARNCODE_THEME`                    | Terminal colors: `auto`, `dark`, `light`, or `plain`                   |
| `ARNCODE_API_FEATURES`             | `full` or `basic`; overrides the endpoint-based feature selection      |
| `ARNCODE_EXPLORE_MODEL`            | Model for read-only `explore` subagents in API-key mode                |
| `ARNCODE_CONFIG_DIR`               | Alternate directory for state, global instructions, and ArnCode skills |

See [`.env.example`](../.env.example) for placeholders. ArnCode does not automatically load `.env` files. Relative `ARNCODE_CONFIG_DIR` paths resolve from the current working directory; credential storage must stay outside Git repositories.

| Default location              | Contents                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `~/.arncode/config.json`      | Preferences                                                                                     |
| `~/.arncode/credentials.json` | Credential bank                                                                                 |
| `~/.arncode/usage.json`       | Per-credential requests, tokens, estimated costs, errors, limit hits, last use, and reset times |
| `~/.arncode/sessions/`        | Conversations and resume metadata                                                               |
| `~/.arncode/AGENTS.md`        | Global instructions                                                                             |
| `~/.arncode/skills/`          | Global skills                                                                                   |

The state directory uses mode `700`; private JSON files use mode `600` and atomic writes. Redaction covers registered secrets and Anthropic token patterns in output and persisted conversations.

Costs are estimates based on known model pricing or the SDK's reported estimate. They do not represent invoices, subscription bills, or remaining quota. Unknown models, custom endpoints, and unsupported pricing combinations report unpriced usage. Usage displays uncached input, output, cache reads, and cache writes separately. Total input is uncached input plus cache-read and cache-write tokens; the uncached figure is not the full prompt size.

OAuth persists observed streamed tokens as unpriced usage while a run is active. The final SDK result reconciles token counts and cost without counting them twice. If the run is interrupted, observed tokens remain recorded with cost unavailable.

### MCP servers

Connect Model Context Protocol servers by adding them to `~/.arncode/config.json` in the `mcpServers` format Claude Code uses:

```json
{
  "mcpServers": {
    "issues": { "command": "npx", "args": ["-y", "some-mcp-server"], "env": { "TOKEN": "…" } },
    "docs": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    }
  }
}
```

Stdio servers start in the project directory; `http` and `sse` servers are reached over the network. Their tools appear to the model as `mcp__<server>__<tool>` in both auth modes and follow the permission mode, hooks, and redaction like built-in tools; registered secrets in `env` and `headers` are redacted. API-key sessions start the servers on the first request and keep them for the session; a server that fails to start is reported once and skipped. `/mcp` lists servers and their tools. Like hooks, servers load from your configuration only, never from a project's own files.

### Hooks

Hooks run your shell commands at points in a session, in the format Claude Code uses, so existing command hooks can be copied over. Add them to `~/.arncode/config.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "~/bin/guard-shell" }] }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "npx prettier --write ." }]
      }
    ]
  }
}
```

| Event              | Runs                              | Exit code 2 or `"decision": "block"`                  |
| ------------------ | --------------------------------- | ----------------------------------------------------- |
| `UserPromptSubmit` | Before a prompt is sent           | Stops the request; other output is added as context   |
| `PreToolUse`       | Before a tool runs                | Blocks the call; the reason goes to the model         |
| `PostToolUse`      | After a tool runs                 | Shows the reason to the model as feedback             |
| `Stop`             | When the agent finishes its reply | Sends the reason back as a request, up to three times |
| `SessionStart`     | When a session starts or resumes  | Nothing to block; output is added as context          |

Each hook receives JSON on stdin with `session_id`, `cwd`, `hook_event_name`, and, for tool events, `tool_name` and `tool_input` (`tool_response` after the call); `SessionStart` gets `source`, `startup` or `resume`. Matchers are regular expressions over tool names as Claude Code names them: `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `Task`, `TodoWrite`, `WebSearch`, and `WebFetch`, in both auth modes. A hook can also print `{"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": "…"}}` or `additionalContext`. Hooks time out after 60 seconds unless `timeout` (seconds) says otherwise. They load from your configuration only; hooks defined inside a project are not run, so opening a repository never executes its commands.

### Protected paths

`protectedPaths` adds exclusions for file reads, writes, edits, directory listings, and searches in both auth modes:

```json
{
  "protectedPaths": ["private", "**/*.pem", "~/private-config"]
}
```

The defaults are `~/.arncode`, `~/.secrets`, `~/.ssh`, `**/.env`, and `**/.env.*`. Custom entries are merged and deduplicated with these defaults; an empty array does not remove them. The actual `ARNCODE_CONFIG_DIR` is always protected too. `.env.example` matches the default exclusions.

Relative entries resolve from the selected project directory. Absolute paths and a leading `~/` are supported. `*` matches characters within one path segment, `?` matches one character, and a complete `**` segment matches any number of path segments. Other characters are literal: there are no negated patterns, character classes, braces, or escape syntax. A matching path also protects its descendants. Checks cover both the requested path and its resolved target; configured literal paths and the static prefix of a pattern also resolve symlinks.

OAuth uses the same guarded `glob` and `grep` searches as API-key mode through its MCP server, alongside native Read, Write, Edit, and Bash tools. Protection is enforced inside search tools as well as direct file hooks. Shell commands retain your account's filesystem and network access; protected paths and approval prompts are not a sandbox.

## Tools and limits

The API backend provides `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `bash`, `skill`, `todo_write`, `task`, and `exit_plan_mode`.

`todo_write` keeps a checklist for multi-step work; the terminal shows it and names the item in progress. `task` hands a self-contained job to a subagent with its own context, which returns only its final report; several can run in parallel. An `explore` subagent is read-only and uses Claude Haiku 5.5 at low effort on the official endpoint (`ARNCODE_EXPLORE_MODEL` overrides it); a `general` subagent uses the session's model and can edit files and run commands. Subagents use the session's credential, permissions, and protected paths, and their usage counts toward the session.

On the official endpoint, models that support them also get Anthropic's server-side `web_search` (up to 5 searches per request) and `web_fetch` tools. Web search is billed per search by Anthropic. Set `"webTools": false` in configuration to turn both off in either mode. Exact edits require a unique match unless `replace_all` is requested. File paths stay inside the project and reject escaping symlinks; shell commands have the account's filesystem and network access.

Read ranges, searches, and command output are bounded to about 10,000 tokens per result, and lines longer than 2,000 characters (500 in search results) are shortened. Command output keeps its first 4,000 and last 16,000 characters per stream; when output is cut, the complete output is saved to a private temporary file named in the result, so the model can search it instead of running the command again. Saved output is removed after a day. Shell timeouts default to two minutes and can be requested up to thirty minutes. The managed process group is stopped on timeout, cancellation, or shell exit, so API tools do not support persistent background servers. Linux and macOS support this process-group cleanup; use WSL on Windows.

`read_file` returns PNG, JPEG, GIF, and WebP files as images. Images that fit the model's limits (2,000 px on the longest side, its visual-token budget, and 1 MB) are sent unchanged; larger PNG and JPEG files are downscaled and re-encoded in process, as JPEG unless they have transparency. Each image is stored once beside its saved session and resent unchanged on later requests; the saved conversation keeps only a reference. When stored images approach the request size limit, the conversation is summarized. PDFs of up to 100 pages and 12 MiB are sent as documents, so the model reads both their text and their page images; they are stored the same way. OAuth sessions use the SDK's native Read tool for images and PDFs.

In API-key sessions, a prompt can attach files: `@path` or `@"path with spaces"` mentions attach images, PDFs, and inline text files (up to 200 kB), and image paths pasted or dropped into the terminal are attached too. Protected paths are never attached.

OAuth uses SDK-native Read, Write, Edit, Bash, TodoWrite, Agent, WebFetch, and WebSearch tools, plus ArnCode's guarded searches, skill loader, and plan approval. Its `explore` and `general` agents mirror the API subagents. Full mode bypasses ArnCode approvals; ask mode applies its prompts through SDK hooks and callbacks. SDK-enforced restrictions still apply.

Skills contain YAML frontmatter with `name` and `description`. Their metadata is placed in the initial prompt; the body is loaded only when requested. Discovery order is project `.arncode/skills`, project `.claude/skills`, global ArnCode `skills`, then `~/.claude/skills`; the first matching name wins. Skill bodies are limited to 120 kB.
