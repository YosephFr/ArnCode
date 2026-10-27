import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { globRegExp } from './glob.js';
import { claudeToolName } from './hooks.js';

/** Rules in Claude Code's format: `Tool` or `Tool(specifier)`. */
const ruleSchema = z
  .string()
  .max(1000)
  .regex(/^[A-Za-z][\w-]*(?:\(.+\))?$/, 'Use Tool or Tool(specifier).');

export const permissionRulesSchema = z
  .object({
    allow: z.array(ruleSchema).max(500).optional(),
    deny: z.array(ruleSchema).max(500).optional(),
  })
  .strict();

export type PermissionRules = z.infer<typeof permissionRulesSchema>;

interface Rule {
  text: string;
  tool: string;
  specifier?: string;
}

function parse(text: string): Rule {
  const match = /^([A-Za-z][\w-]*)(?:\((.+)\))?$/.exec(text.trim());
  if (!match) throw new Error(`Invalid permission rule: ${text}`);
  return { text, tool: match[1]!, ...(match[2] ? { specifier: match[2] } : {}) };
}

/** As in Claude Code, Edit rules cover every tool that changes files and Read rules every reader. */
const FAMILIES: Record<string, string[]> = {
  Edit: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  Read: ['Read', 'Grep', 'Glob', 'LS'],
};

function toolMatches(rule: Rule, tool: string): boolean {
  if ((FAMILIES[rule.tool] ?? [rule.tool]).includes(tool)) return true;
  // mcp__server covers every tool from that server.
  return rule.tool.startsWith('mcp__') && tool.startsWith(`${rule.tool}__`);
}

// Shell commands. Allow rules match literally and refuse anything they cannot see; deny rules
// normalize first and look inside nested commands. Neither makes the shell a sandbox: a command
// can always reach the same effect another way.

/** Redirections that do not touch files. */
const QUIET = /\s*(?:[12]?>&[12]|&>\s*\/dev\/null|[12]?>\s*\/dev\/null)/g;
/** Operators between commands; two-character forms first. */
const CHAIN = /\s*(?:&&|\|\||\|&|;|\||&|\n)\s*/;
/** Constructs that run or read something a literal match cannot see. */
const HIDDEN = /\$\(|`|<\(|>\(|[<>]/;

function clean(command: string): string {
  return command.replace(/\\\n/g, ' ').replace(QUIET, '');
}

function parts(command: string): string[] {
  return command
    .split(CHAIN)
    .map((part) => part.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

const WRAPPERS =
  /^(?:(?:command|builtin|exec|nohup|time|sudo(?:\s+-\S+)*|nice(?:\s+-n\s*-?\d+|\s+-\d+)?|xargs(?:\s+-\S+)*|env(?:\s+-\S+)*)\s+)+/;
const ASSIGNMENTS = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/;

/** The command a part really runs, for deny rules: without wrappers, quotes or escapes. */
function denyForm(part: string): string {
  let previous = '';
  let current = part.replace(/^[\s(){}!]+|[\s(){}]+$/g, '');
  while (current !== previous) {
    previous = current;
    current = current
      .replace(ASSIGNMENTS, '')
      .replace(WRAPPERS, '')
      .replace(/\\(.)/g, '$1')
      .replace(/['"]/g, '')
      .replace(/^[\s(){}!]+/, '')
      .trim();
  }
  return current;
}

/** Commands nested in substitutions or handed to another shell, for deny rules. */
function nested(command: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < command.length; index++) {
    if (command[index] === '`') {
      const end = command.indexOf('`', index + 1);
      if (end < 0) break;
      found.push(command.slice(index + 1, end));
      index = end;
    } else if (/[$<>]/.test(command[index]!) && command[index + 1] === '(') {
      // Balanced parentheses, so a substitution inside another one is found too.
      let depth = 0;
      let end = index + 1;
      for (; end < command.length; end++) {
        if (command[end] === '(') depth++;
        else if (command[end] === ')' && --depth === 0) break;
      }
      found.push(command.slice(index + 2, end));
    }
  }
  for (const part of parts(command)) {
    const shell = /^(?:(?:ba|z|da|k)?sh\s+-c|eval)\s+(.+)$/.exec(denyForm(part));
    if (shell) found.push(shell[1]!);
  }
  return found;
}

function commandMatches(specifier: string, command: string): boolean {
  if (specifier.endsWith(':*')) {
    const prefix = specifier.slice(0, -2).trim();
    return command === prefix || command.startsWith(`${prefix} `);
  }
  return command === specifier.trim();
}

function denied(rules: Rule[], command: string, depth = 0): Rule | undefined {
  const cleaned = clean(command);
  for (const part of parts(cleaned)) {
    const form = denyForm(part);
    const rule = rules.find(
      (candidate) =>
        !candidate.specifier ||
        commandMatches(candidate.specifier, part) ||
        commandMatches(candidate.specifier, form),
    );
    if (rule) return rule;
  }
  if (depth < 3)
    for (const inner of nested(cleaned)) {
      const rule = denied(rules, inner, depth + 1);
      if (rule) return rule;
    }
  return undefined;
}

// Paths, in Claude Code's notation: `//abs`, `~/home`, `/project-root`, or relative; a pattern
// without a slash matches a name at any depth, as in .gitignore.

/** The real location of a path that may not exist yet, through its nearest existing parent. */
export async function realLocation(file: string): Promise<string> {
  const rest: string[] = [];
  for (let current = file; ; current = path.dirname(current)) {
    try {
      return path.join(await realpath(current), ...rest);
    } catch {
      if (path.dirname(current) === current) return file;
      rest.unshift(path.basename(current));
    }
  }
}

/** A path pattern as absolute (`//`, `~/`) or project-relative, slashes kept. */
function patternParts(specifier: string): { absolute?: string; relative?: string } {
  if (specifier.startsWith('//')) return { absolute: specifier.slice(1) };
  if (specifier.startsWith('~/')) return { absolute: path.join(homedir(), specifier.slice(2)) };
  const relative = specifier.replace(/^\.?\//, '');
  return { relative: relative.includes('/') ? relative : `**/${relative}` };
}

function pathMatches(specifier: string, absolute: string, root: string): boolean {
  const pattern = patternParts(specifier);
  const covers = (expression: string, value: string) =>
    globRegExp(expression).test(value) || globRegExp(`${expression}/**`).test(value);
  if (pattern.absolute) return covers(pattern.absolute, absolute);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return covers(pattern.relative!, relative);
}

/** Read deny rules as protected paths, so searches and listings skip those files too. */
export function protectedFromRules(rules: PermissionRules | undefined): string[] {
  return (rules?.deny ?? []).map(parse).flatMap((rule) => {
    if (rule.tool !== 'Read' || !rule.specifier) return [];
    const pattern = patternParts(rule.specifier);
    return [pattern.absolute ?? pattern.relative!];
  });
}

export interface RuleDecision {
  decision: 'allow' | 'deny';
  rule: string;
}

/** Permission rules from the user's configuration plus approvals given during the session. */
export class RuleSet {
  private readonly allow: Rule[];
  private readonly deny: Rule[];

  constructor(rules: PermissionRules = {}) {
    this.allow = (rules.allow ?? []).map(parse);
    this.deny = (rules.deny ?? []).map(parse);
  }

  /** Allow a rule for the rest of the session. */
  add(text: string): void {
    this.allow.push(parse(text));
  }

  clearSession(configured: PermissionRules = {}): void {
    this.allow.splice(0, this.allow.length, ...(configured.allow ?? []).map(parse));
  }

  /** Deny wins over allow. */
  async check(
    name: string,
    input: Record<string, unknown>,
    cwd: string,
  ): Promise<RuleDecision | undefined> {
    const tool = claudeToolName(name);
    if (tool === 'Bash' && typeof input.command === 'string') return this.command(input.command);
    const target = input.file_path ?? input.path;
    const paths: string[] = [];
    if (typeof target === 'string') {
      const lexical = path.resolve(cwd, target);
      paths.push(lexical, await realLocation(lexical));
    }
    const root = await realLocation(path.resolve(cwd));
    const covers = (rule: Rule, every: boolean) => {
      if (!toolMatches(rule, tool)) return false;
      if (!rule.specifier) return true;
      if (tool === 'WebFetch' && rule.specifier.startsWith('domain:'))
        return domainMatches(rule.specifier, input.url);
      if (!paths.length) return false;
      // A link inside the project must not widen what an allow rule covers.
      return every
        ? paths.every((file) => pathMatches(rule.specifier!, file, root))
        : paths.some((file) => pathMatches(rule.specifier!, file, root));
    };
    const deny = this.deny.find((rule) => covers(rule, false));
    if (deny) return { decision: 'deny', rule: deny.text };
    const allow = this.allow.find((rule) => covers(rule, true));
    return allow ? { decision: 'allow', rule: allow.text } : undefined;
  }

  private command(command: string): RuleDecision | undefined {
    const deny = denied(
      this.deny.filter((rule) => toolMatches(rule, 'Bash')),
      command,
    );
    if (deny) return { decision: 'deny', rule: deny.text };
    const allowed = this.allow.filter((rule) => toolMatches(rule, 'Bash'));
    const whole = command.trim().replace(/\s+/g, ' ');
    const exact = allowed.find((rule) => !rule.specifier || rule.specifier.trim() === whole);
    if (exact) return { decision: 'allow', rule: exact.text };
    const cleaned = clean(command);
    if (HIDDEN.test(cleaned)) return undefined;
    const pieces = parts(cleaned);
    if (!pieces.length) return undefined;
    const covering = pieces.map((part) =>
      allowed.find((rule) => commandMatches(rule.specifier!, part)),
    );
    return covering.every(Boolean) ? { decision: 'allow', rule: covering[0]!.text } : undefined;
  }
}

function domainMatches(specifier: string, url: unknown): boolean {
  if (typeof url !== 'string') return false;
  const domain = specifier.slice('domain:'.length).toLowerCase();
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

/** Common tools whose subcommand matters: `npm test` is a different request from `npm publish`. */
const TWO_WORDS = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'git',
  'cargo',
  'go',
  'uv',
  'pip',
  'make',
  'docker',
  'kubectl',
]);

/**
 * The session rule offered for "allow from now on": a command prefix for a plain command, the
 * exact command when it chains, redirects, sets variables or runs through a wrapper, and the
 * whole tool for everything else.
 */
export function sessionRule(name: string, input: Record<string, unknown>): string {
  const tool = claudeToolName(name);
  if (tool !== 'Bash' || typeof input.command !== 'string') return tool;
  const whole = input.command.trim().replace(/\s+/g, ' ');
  const cleaned = clean(input.command).trim();
  const plain =
    parts(cleaned).length === 1 &&
    !HIDDEN.test(cleaned) &&
    !ASSIGNMENTS.test(`${cleaned} `) &&
    !WRAPPERS.test(`${cleaned} `) &&
    !/[()]|^(?:(?:ba|z|da|k)?sh|eval)\b/.test(cleaned);
  const words = cleaned.split(/\s+/);
  if (!plain || !words[0]) return `Bash(${whole})`;
  const prefix = words.slice(0, TWO_WORDS.has(words[0]) && words[1] ? 2 : 1).join(' ');
  return `Bash(${prefix}:*)`;
}
