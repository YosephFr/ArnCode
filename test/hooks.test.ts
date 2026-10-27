import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hooks } from '../src/hooks.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'arncode-hooks-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('command hooks', () => {
  it('matches Claude Code tool names and passes the event as JSON on stdin', async () => {
    const hooks = new Hooks(
      {
        PreToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [{ type: 'command', command: `cat > ${dir}/input.json` }],
          },
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'exit 0' }] },
        ],
      },
      { cwd: dir, sessionId: () => 'session-1' },
    );
    expect(
      await hooks.run('PreToolUse', { tool_input: { path: 'a.ts' } }, { tool: 'edit_file' }),
    ).toEqual({});
    expect(JSON.parse(await readFile(path.join(dir, 'input.json'), 'utf8'))).toEqual({
      session_id: 'session-1',
      cwd: dir,
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'a.ts' },
    });
  });

  it('blocks on exit code 2 or a JSON decision and collects context', async () => {
    const hooks = new Hooks(
      {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo "no deletes" >&2; exit 2' }],
          },
          {
            matcher: 'Read',
            hooks: [
              {
                type: 'command',
                command:
                  'echo \'{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"secret file"}}\'',
              },
            ],
          },
        ],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo "Branch: main"' }] }],
      },
      { cwd: dir, sessionId: () => 's' },
    );
    expect(
      await hooks.run('PreToolUse', { tool_input: { command: 'rm -rf x' } }, { tool: 'bash' }),
    ).toEqual({
      blocked: 'no deletes',
    });
    expect(await hooks.run('PreToolUse', { tool_input: {} }, { tool: 'read_file' })).toEqual({
      blocked: 'secret file',
    });
    expect(await hooks.run('PreToolUse', { tool_input: {} }, { tool: 'grep' })).toEqual({});
    expect(await hooks.run('UserPromptSubmit', { prompt: 'hi' })).toEqual({
      context: 'Branch: main',
    });
  });
});
