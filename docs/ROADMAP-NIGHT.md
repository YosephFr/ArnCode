# Night roadmap (2026-10-27)

Working backlog for the `overnight-2026-10-27` branch. Items are ordered by priority. Status: `todo`, `doing`, `done`, `held`. Decisions record why a choice was made so later work does not reopen it.

## Rules for this run

- Automated tests use mocked providers. No paid API requests; live checks run only in OAuth mode with the API-key environment variable unset.
- Every step: lint, typecheck, tests, build, then one atomic commit. The suite must not shrink.
- Pushes use plain `git push`; no force pushes or history rewrites. `main` only fast-forwards to commits that pass every check.

## P1. Vision in API-key mode

| ID  | Item                                                                                                                  | Status |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------ |
| 1.1 | `Read` returns image blocks for PNG, JPEG, GIF and WebP, with dimensions in the text part                             | done   |
| 1.2 | Large images are downscaled and re-encoded client-side (pure JS) so requests stay small and under the per-image limit | done   |
| 1.3 | Image bytes are stored once per session outside the JSON transcript and replayed byte-identically                     | done   |
| 1.4 | Prompts can attach images by path (`@frame.png` or a pasted path)                                                     | done   |
| 1.5 | PDF files are returned as document blocks                                                                             | done   |
| 1.6 | Portable transcripts record an image placeholder, never base64                                                        | done   |

## P2. Agent features

| ID   | Item                                                                                                                                                               | Status |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 2.1  | API loop on the beta Messages API: frozen per-session system prompt, `drop_block` thinking binding, progress updates, refusal fallback, eager tool-input streaming | done   |
| 2.2  | Permission modes `full` (default), `edits`, `ask`, `plan`; `ExitPlanMode` approval; Shift+Tab cycling                                                              | done   |
| 2.3  | `/model` picker with aliases; `/effort` that keeps the prompt cache (per-message effort)                                                                           | done   |
| 2.4  | Status bar: model, effort, mode, context use, 5-hour and weekly plan use, active credential, session cost                                                          | done   |
| 2.5  | Subagents: `Task` tool in API mode (parallel, read-only explorer by default); SDK agents in OAuth mode                                                             | done   |
| 2.6  | Todo list: `TodoWrite` in both modes, rendered as a checklist                                                                                                      | done   |
| 2.7  | Hooks compatible with Claude Code's command hooks (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`)                                        | done   |
| 2.8  | Slash commands: `/compact`, `/context`, `/status`, `/resume`, `/todos`, `/plan`, `/export`, `/init`, `/theme`; custom Markdown commands                            | done   |
| 2.9  | MCP servers (stdio and HTTP) in both modes                                                                                                                         | done   |
| 2.10 | Automatic compaction (server-side in API mode) and `/compact`                                                                                                      | done   |
| 2.11 | Session picker for `--resume` and `/resume`, with the conversation tail replayed                                                                                   | done   |
| 2.12 | Web search and fetch: server tools in API mode, native tools in OAuth mode                                                                                         | done   |

## P3. Terminal interface

| ID  | Item                                                                                                      | Status |
| --- | --------------------------------------------------------------------------------------------------------- | ------ |
| 3.1 | Renderer with a sticky footer (spinner, status bar) above which output streams                            | done   |
| 3.2 | Streaming Markdown with code highlighting                                                                 | done   |
| 3.3 | Line editor: history, multiline, bracketed paste, completion for commands and `@` paths, Esc to interrupt | done   |
| 3.4 | Tool calls and results rendered compactly; diffs with line numbers and word highlights                    | done   |
| 3.5 | Themes: dark, light, plain                                                                                | done   |

## P4. Speed and token efficiency

| ID  | Item                                                                                                      | Status |
| --- | --------------------------------------------------------------------------------------------------------- | ------ |
| 4.1 | Read-only tools and subagents in one turn run in parallel; mutating tools keep their order                | done   |
| 4.2 | Append-only history (no client-side truncation); stable cached prefix; cache keep-alive on long tools     | done   |
| 4.3 | OAuth follow-ups resume the SDK session (full history, cached prefix) instead of resending the transcript | done   |
| 4.4 | `Edit` tolerates whitespace and indentation drift before failing                                          | done   |
| 4.5 | Faster startup through lazy imports                                                                       | done   |
| 4.6 | Tool results within about 10k tokens; tail-weighted command output saved to a file when cut               | done   |
| 4.7 | `-p --output-format json` and `stream-json` for scripts and the benchmark harness                         | done   |
| 4.8 | OAuth: start the SDK process before the next prompt (`prewarm`)                                           | held   |

Notes: 4.5 loads the Messages SDK, Agent SDK, MCP client and image codecs on first use. `arncode --version` takes about 0.3 s against 0.08 s for bare Node; most of the rest is zod and the terminal libraries that every run needs, so the entry point was not restructured. 4.8 is held; see D11.

## P5. Credential bank

| ID  | Item                                                                           | Status |
| --- | ------------------------------------------------------------------------------ | ------ |
| 5.1 | `creds add` detects the credential type from the token                         | done   |
| 5.2 | Interactive `creds` manager: status, usage, order, enable and disable          | done   |
| 5.3 | Relative reset times; plan use per OAuth credential from SDK rate-limit events | done   |
| 5.4 | `creds priority` and `creds rename`                                            | done   |

## P6. Benchmark harness

| ID  | Item                                                                                                                             | Status |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 6.1 | `bench/` with fixture tasks and automatic checks; several runs per contestant; JSON and Markdown reports; mock contestant for CI | done   |

## P7. Review round

An audit of the night's work found twelve defects, all fixed with regression tests (approval questions that could hang, attachments outside the project, a plan-mode symlink escape, JSON output that broke commands, model switches that invalidated history, OAuth subagent text in the reply, Esc closing the app, slow pipes, summary cache misses, session titles, `$` handling, history size). A design review proposed the next changes below.

| ID  | Item                                                                                       | Status |
| --- | ------------------------------------------------------------------------------------------ | ------ |
| 7.1 | `/undo` restores the files the latest request changed                                      | done   |
| 7.2 | Background commands in API-key sessions (`run_in_background`, `bash_output`, `kill_shell`) | done   |
| 7.3 | Reads of up to 2,000 lines; search and `@` completion respect `.gitignore`                 | done   |
| 7.4 | Environment block in API-key prompts; `CLAUDE.local.md` and `~/.claude/CLAUDE.md` fallback | done   |
| 7.5 | Approval previews for edits; plans rendered as Markdown                                    | done   |
| 7.6 | Permission rules for commands and paths, kept across sessions                              | done   |
| 7.7 | First run: offer `claude setup-token` when Claude Code is installed                        | done   |
| 7.8 | Project `.mcp.json` after a one-time trust prompt                                          | todo   |
| 7.9 | Larger benchmark tasks; a published comparison run                                         | todo   |

## Decisions

- **D1. Beta Messages API for the API loop.** The SDK types preserved-thinking controls, progress updates, compaction and fallbacks only in the beta namespace.
- **D2. Thinking blocks degrade instead of failing.** Requests set `prefix_mismatch_behavior: "drop_block"`, so a resumed session after an upgrade, or a switch to an account in another organization, keeps working.
- **D3. No client-side history truncation.** Editing earlier turns invalidates later thinking blocks and the prompt cache. Context is bounded by server-side compaction.
- **D4. Image processing in pure JavaScript** (`pngjs`, `jpeg-js`): no native builds or external binaries.
- **D5. Live checks in OAuth mode only**, with the credential pinned and the API-key variable removed from the environment.
- **D6. Edits match in three tiers only**: exact, typographic variants, trailing whitespace, with line endings kept per line (adapted from OpenCode, MIT). Looser fuzzy matching deleted content in OpenCode and was removed there.
- **D7. Re-encoded images stay under 700 KB**: JPEG quality 85, 75, then 60, then smaller dimensions, because every image is resent with each request until a summary drops it.
- **D8. Plan mode is enforced by the tools**, not only the prompt: read-only tools run, writes are limited to plan files, and shell commands need approval.
- **D9. Hooks and MCP servers load from the user's configuration only.** Project files never run commands, so opening a repository cannot execute anything.
- **D10. Read-only explorer subagents default to Claude Haiku 5.5 at low effort** on the official endpoint (`ARNCODE_EXPLORE_MODEL` overrides); general subagents use the session model.
- **D11. OAuth resumes the SDK session; the process still starts per prompt.** Measured on Claude Haiku 5.5: a resumed follow-up wrote 140 tokens to the cache and read 11.5k, where resending the transcript wrote about 2.7k and sent 2.3k uncached, and the gap grows with the conversation. The SDK reports totals across a resumed session, so each request is billed by difference, and a request without a final result drops the thread. SDK files live in `~/.arncode/claude`; `"oauthSessions": false` restores the transcript-only behavior. A trivial prompt takes about 2.8 s, of which about 1 s is the SDK process starting; `prewarm` is alpha and fixes hooks, MCP servers, the environment and the permission callback up front, all of which ArnCode binds to each request and credential, so it waits.
- **D12. Web tools are on by default** in both modes, with `"webTools": false` to turn them off; Haiku and Fable skip the server tools they do not support.
- **D13. Themes change at once and are saved.** `/theme` restyles the footer and new output; scrollback keeps the colors it was printed with.
- **D14. Attachments come only from what the user types.** Piped input and hook output are never searched for `@` mentions; text files attach only from inside the project, through links too, while images and PDFs may come from anywhere that is not protected.
- **D15. Background commands are API-key only.** Each OAuth prompt runs in its own SDK process, so shells started there would end with the prompt.
- **D16. stdin: shell pipes are read to the end; sockets get 3 seconds.** Harnesses that spawn ArnCode through Node leave stdin as a socket that may never close.
- **D17. `~/.claude/CLAUDE.md` applies when `~/.arncode/AGENTS.md` does not exist**, as in OpenCode.
- **D18. `/undo` covers write and edit tools for the last 20 requests**; changes made through shell commands are not tracked, as in Claude Code's rewind.
