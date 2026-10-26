export type AuthMode = 'api-key' | 'oauth';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type PermissionMode = 'full' | 'ask';

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
  permissionMode: PermissionMode;
  protectedPaths: string[];
}

export interface AgentUI {
  text(value: string): void;
  endText(): void;
  status(value: string): void;
  idle(): void;
  notice(value: string): void;
  tool(name: string, input: Record<string, unknown>): void;
  diff(path: string, before: string, after: string): void;
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
