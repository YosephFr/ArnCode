import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { getConfigDir } from './config.js';
import { redact } from './redact.js';
import { discoverSkills } from './skills.js';

async function instruction(file: string): Promise<string> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Instruction path must be a file: ${file}`);
    const bytes = Buffer.alloc(40_000);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return (
      bytes.subarray(0, bytesRead).toString('utf8') +
      (info.size > bytes.length ? '\n[Instructions truncated at 40000 bytes.]' : '')
    );
  } finally {
    await handle.close();
  }
}

export async function systemPrompt(cwd: string, nativeTools = false): Promise<string> {
  const locations = [
    ['Global instructions', path.join(getConfigDir(), 'AGENTS.md')],
    ['Project CLAUDE.md', path.join(cwd, 'CLAUDE.md')],
    ['Project AGENTS.md', path.join(cwd, 'AGENTS.md')],
  ];
  const instructions: string[] = [];
  for (const [label, file] of locations) {
    if (!file) continue;
    const content = await instruction(file);
    if (content) instructions.push(`${label}:\n${content}`);
  }
  const skills = await discoverSkills(cwd);
  const index = skills.length
    ? `Available skills (name: description):\n${skills.map((skill) => `${skill.name}: ${skill.description}`).join('\n')}\nLoad a relevant skill with ${nativeTools ? 'mcp__arncode__skill' : 'skill'} before following it. Its full instructions are available on demand.`
    : '';
  return redact(`You are ArnCode, a coding agent working in ${cwd}.
Complete the user's task, inspect the existing project before editing, and verify your changes by running the relevant checks. Keep your response concise and report real results. Use tools to act; never claim an action succeeded without a successful tool result.
Use ${nativeTools ? 'Read, mcp__arncode__glob and mcp__arncode__grep' : 'read_file, list_dir, glob and grep'} to explore. Prefer exact ${nativeTools ? 'Edit' : 'edit_file'} changes to rewriting existing files. Read applicable AGENTS.md and CLAUDE.md files before editing. Tool paths are relative to the project. Bash starts in the project directory. Commands must finish within their timeout: split lengthy work into stages, set an appropriate timeout, and do not leave background processes behind. Tool outputs may be truncated; narrow the query or read a range. Never print or copy credentials, tokens or secret files. Permission denials are final for that action; explain what is blocked without trying a different tool to bypass the denial.
${instructions.join('\n\n')}
${index}`);
}
