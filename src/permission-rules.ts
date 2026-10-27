import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
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

/** Shell operators that chain commands; each part must be allowed on its own. */
const CHAIN = /\s*(?:&&|\|\||;|\||\n)\s*/;
/** Constructs that run code a prefix rule cannot see, so they are never allowed by a rule. */
const HIDDEN = /\$\(|`|<\(|>\(/;

function commandMatches(specifier: string, command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, ' ');
  if (specifier.endsWith(':*')) {
    const prefix = specifier.slice(0, -2).trim();
    return normalized === prefix || normalized.startsWith(`${prefix} `);
  }
  return normalized === specifier.trim();
}

/** A gitignore-style pattern as a regular expression: `**` crosses directories, `*` does not. */
function globRegex(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === '*' && pattern[index + 1] === '*') {
      const slash = pattern[index + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function pathMatches(specifier: string, target: string, cwd: string): boolean {
  const absolute = path.resolve(cwd, target);
  const pattern = specifier.startsWith('~/')
    ? path.join(homedir(), specifier.slice(2))
    : specifier.replace(/^\.\//, '');
  if (path.isAbsolute(pattern)) return globRegex(pattern).test(absolute);
  const relative = path.relative(cwd, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  // A bare directory pattern covers what is inside it.
  return globRegex(pattern).test(relative) || globRegex(`${pattern}/**`).test(relative);
}

function domainMatches(specifier: string, url: unknown): boolean {
  if (!specifier.startsWith('domain:') || typeof url !== 'string') return false;
  const domain = specifier.slice('domain:'.length).toLowerCase();
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

function toolMatches(rule: Rule, tool: string): boolean {
  if (rule.tool === tool) return true;
  // mcp__server covers every tool from that server.
  return rule.tool.startsWith('mcp__') && tool.startsWith(`${rule.tool}__`);
}

/** Whether one rule covers a call; for shell commands, `parts` are the chained commands. */
function matches(rule: Rule, tool: string, input: Record<string, unknown>, cwd: string): boolean {
  if (!toolMatches(rule, tool)) return false;
  if (!rule.specifier) return true;
  if (tool === 'Bash') return false; // Commands are matched part by part by the caller.
  if (tool === 'WebFetch') return domainMatches(rule.specifier, input.url);
  const target = input.file_path ?? input.path;
  return typeof target === 'string' && pathMatches(rule.specifier, target, cwd);
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

  /** Deny wins over allow; a chained command is allowed only when every part is. */
  check(name: string, input: Record<string, unknown>, cwd: string): RuleDecision | undefined {
    const tool = claudeToolName(name);
    if (tool === 'Bash' && typeof input.command === 'string') {
      const parts = input.command.split(CHAIN).filter(Boolean);
      for (const rule of this.deny) {
        if (!toolMatches(rule, tool)) continue;
        if (!rule.specifier || parts.some((part) => commandMatches(rule.specifier!, part)))
          return { decision: 'deny', rule: rule.text };
      }
      const allowed = this.allow.filter((rule) => toolMatches(rule, tool));
      if (allowed.some((rule) => !rule.specifier)) return { decision: 'allow', rule: 'Bash' };
      if (HIDDEN.test(input.command)) return undefined;
      const covering = parts.map((part) =>
        allowed.find((rule) => commandMatches(rule.specifier!, part)),
      );
      return covering.every(Boolean) ? { decision: 'allow', rule: covering[0]!.text } : undefined;
    }
    const denied = this.deny.find((rule) => matches(rule, tool, input, cwd));
    if (denied) return { decision: 'deny', rule: denied.text };
    const allowed = this.allow.find((rule) => matches(rule, tool, input, cwd));
    return allowed ? { decision: 'allow', rule: allowed.text } : undefined;
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

/** The session rule offered for "allow from now on": a command prefix, or the whole tool. */
export function sessionRule(name: string, input: Record<string, unknown>): string {
  const tool = claudeToolName(name);
  if (tool !== 'Bash' || typeof input.command !== 'string') return tool;
  const words = input.command.trim().split(/\s+/);
  if (CHAIN.test(input.command.trim()) || HIDDEN.test(input.command) || !words[0]) return tool;
  const prefix = words.slice(0, TWO_WORDS.has(words[0]) && words[1] ? 2 : 1).join(' ');
  return `Bash(${prefix}:*)`;
}
