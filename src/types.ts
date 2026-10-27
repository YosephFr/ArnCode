import type { HooksConfig } from './hooks.js';
import type { McpServers } from './mcp.js';
export type AuthMode = 'api-key' | 'oauth';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type PermissionMode = 'full' | 'edits' | 'ask' | 'plan';

/** The user's answer to a finished plan: approve it in a mode, or keep planning. */
export interface PlanDecision {
  approved: boolean;
  mode?: PermissionMode;
  feedback?: string;
}
export type ExitPlan = (plan: string, signal?: AbortSignal) => Promise<PlanDecision>;

export interface Settings {
  cwd: string;
  auth: AuthMode;
  profile?: string;
  pinnedCredential?: string;
  authRestriction?: AuthMode;
  model: string;
  baseUrl?: string;
  effort: Effort;
  fast: boolean;
  maxTokens: number;
  maxTurns: number;
  /** Context size in tokens at which API conversations are summarized. */
  compactAt: number;
  /** Web search and fetch: server tools in API mode, native tools in OAuth mode. */
  webTools: boolean;
  permissionMode: PermissionMode;
  /** Terminal colors; `auto` follows the terminal's background. */
  theme?: 'auto' | 'dark' | 'light' | 'plain';
  protectedPaths: string[];
  /** Command hooks from the user's configuration. */
  hooks?: HooksConfig;
  /** MCP servers from the user's configuration. */
  mcpServers?: McpServers;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** Present-tense wording shown while the item is in progress. */
  activeForm: string;
}

export interface AgentUI {
  text(value: string): void;
  endText(): void;
  status(value: string): void;
  idle(): void;
  notice(value: string): void;
  /** Stream a progress note the model writes between tool calls. */
  progress(value: string): void;
  tool(name: string, input: Record<string, unknown>): void;
  toolResult(
    name: string,
    output: string,
    options?: { isError?: boolean; durationMs?: number },
  ): void;
  diff(path: string, before: string, after: string): void;
  /** Show the agent's current checklist. */
  todos?(items: TodoItem[]): void;
}

export interface Approval {
  allowed: boolean;
  reason?: string;
}
export type Approve = (
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<Approval>;
