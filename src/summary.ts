// Summary template and rules adapted from OpenCode's session compaction
// (packages/core/src/session/compaction.ts, commit 6b1bc48), Copyright (c) 2025 opencode,
// MIT License. See THIRD_PARTY_NOTICES.md.

const TEMPLATE = `Use this format, leaving out sections that do not apply:

## Objective
- [one or two sentences on what the user is trying to accomplish]

## Requirements
- [constraints, preferences, and scope the user stated, or "(none)"]

## Decisions
- [decisions already made and why, or "(none)"]

## Work state
### Completed
- [finished goals, or "(none)"]
### Active
- [goals in progress, or "(none)"]
### Blocked
- [what blocks progress and why, or "(none)"]

## Next move
1. [ordered next actions, or "(none)"]

## Relevant files
- \`path\`: [why it matters; at most 15 files, most important first]

## Important context
- [facts the next agent needs and cannot easily find on its own, or "(none)"]`;

const RULES = `Rules:
- Keep each section short: terse one-line bullets, no paragraphs or nested lists.
- Prefer references over restating what the code or the listed files already show.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers.
- Carry forward only user requests that still need action, in their exact wording.
- Record whether changes are uncommitted, committed, pushed, under review, or merged.
- Leave out the assistant's own instructions, such as AGENTS.md and environment details; the next agent receives them separately.
- Do not mention summarizing, do not continue the task, and do not call tools.`;

/** Instructions for summarizing a coding session so another agent can resume the work. */
export const SUMMARY_INSTRUCTIONS = `Summarize the conversation so far into a structured handoff that another agent will use to resume the work. Return only the summary.

${TEMPLATE}

${RULES}`;
