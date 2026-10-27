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
| 2.3  | `/model` picker with aliases; `/effort` that keeps the prompt cache (per-message effort)                                                                           | doing  |
| 2.4  | Status bar: model, effort, mode, context use, 5-hour and weekly plan use, active credential, session cost                                                          | done   |
| 2.5  | Subagents: `Task` tool in API mode (parallel, read-only explorer by default); SDK agents in OAuth mode                                                             | done   |
| 2.6  | Todo list: `TodoWrite` in both modes, rendered as a checklist                                                                                                      | done   |
| 2.7  | Hooks compatible with Claude Code's command hooks (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`)                                        | todo   |
| 2.8  | Slash commands: `/compact`, `/context`, `/status`, `/resume`, `/todos`, `/plan`, `/export`, `/init`, `/theme`; custom Markdown commands                            | doing  |
| 2.9  | MCP servers (stdio and HTTP) in both modes                                                                                                                         | todo   |
| 2.10 | Automatic compaction (server-side in API mode) and `/compact`                                                                                                      | doing  |
| 2.11 | Session picker for `--resume` and `/resume`, with the conversation tail replayed                                                                                   | todo   |
| 2.12 | Web search and fetch: server tools in API mode, native tools in OAuth mode                                                                                         | done   |

## P3. Terminal interface

| ID  | Item                                                                                                      | Status |
| --- | --------------------------------------------------------------------------------------------------------- | ------ |
| 3.1 | Renderer with a sticky footer (spinner, status bar) above which output streams                            | done   |
| 3.2 | Streaming Markdown with code highlighting                                                                 | doing  |
| 3.3 | Line editor: history, multiline, bracketed paste, completion for commands and `@` paths, Esc to interrupt | done   |
| 3.4 | Tool calls and results rendered compactly; diffs with line numbers and word highlights                    | done   |
| 3.5 | Themes: dark, light, plain                                                                                | doing  |

## P4. Speed and token efficiency

| ID  | Item                                                                                                  | Status |
| --- | ----------------------------------------------------------------------------------------------------- | ------ |
| 4.1 | Read-only tools and subagents in one turn run in parallel; mutating tools keep their order            | done   |
| 4.2 | Append-only history (no client-side truncation); stable cached prefix; cache keep-alive on long tools | doing  |
| 4.3 | OAuth: one live SDK session per interactive conversation instead of a new process per prompt          | todo   |
| 4.4 | `Edit` tolerates whitespace and indentation drift before failing                                      | done   |
| 4.5 | Faster startup through lazy imports                                                                   | todo   |
| 4.6 | Tool results within about 10k tokens; tail-weighted command output saved to a file when cut           | done   |
| 4.7 | `-p --output-format json` and `stream-json` for scripts and the benchmark harness                     | done   |

Notes: `/effort` already keeps the cache; `/model` picker pending. Automatic compaction is live; `/compact` pending. Append-only history is live; cache keep-alive pending. Themes follow the terminal (dark, light, plain); `/theme` pending. Markdown rendering is in progress.

## P5. Credential bank

| ID  | Item                                                                           | Status |
| --- | ------------------------------------------------------------------------------ | ------ |
| 5.1 | `creds add` detects the credential type from the token                         | todo   |
| 5.2 | Interactive `creds` manager: status, usage, order, enable and disable          | todo   |
| 5.3 | Relative reset times; plan use per OAuth credential from SDK rate-limit events | todo   |
| 5.4 | `creds priority` and `creds rename`                                            | todo   |

## P6. Benchmark harness

| ID  | Item                                                                                                                             | Status |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 6.1 | `bench/` with fixture tasks and automatic checks; several runs per contestant; JSON and Markdown reports; mock contestant for CI | done   |

## Decisions

- **D1. Beta Messages API for the API loop.** The SDK types preserved-thinking controls, progress updates, compaction and fallbacks only in the beta namespace.
- **D2. Thinking blocks degrade instead of failing.** Requests set `prefix_mismatch_behavior: "drop_block"`, so a resumed session after an upgrade, or a switch to an account in another organization, keeps working.
- **D3. No client-side history truncation.** Editing earlier turns invalidates later thinking blocks and the prompt cache. Context is bounded by server-side compaction.
- **D4. Image processing in pure JavaScript** (`pngjs`, `jpeg-js`): no native builds or external binaries.
- **D5. Live checks in OAuth mode only**, with the credential pinned and the API-key variable removed from the environment.
- **D6. Edits match in three tiers only**: exact, typographic variants, trailing whitespace, with line endings kept per line (adapted from OpenCode, MIT). Looser fuzzy matching deleted content in OpenCode and was removed there.
- **D7. Re-encoded images stay under 700 KB**: JPEG quality 85, 75, then 60, then smaller dimensions, because every image is resent with each request until a summary drops it.
- **D8. Plan mode is enforced by the tools**, not only the prompt: read-only tools run, writes are limited to plan files, and shell commands need approval.
