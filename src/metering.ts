import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getConfigDir } from './config.js';
import { atomicWriteJson, readJson, withFileLock } from './storage.js';
import { redact } from './redact.js';
import { addUsage, emptyUsage, type UsageTotals } from './usage.js';
import { classifyCredentialFailure } from './failures.js';
import type { Credential } from './auth.js';
import type { PlanUsage } from './status.js';

const count = z.number().nonnegative().finite();
const recordSchema = z.object({
  type: z.enum(['api-key', 'oauth']),
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  costUsd: count,
  unpricedRequests: count,
  requests: count,
  fastRequests: count,
  errors: count,
  limitHits: count,
  lastUsed: z.string().optional(),
  status: z.enum(['ready', 'exhausted']),
  resetAt: z.string().optional(),
  lastError: z.string().optional(),
  credentialVersion: z.string().optional(),
  /** Latest subscription limits the Agent SDK reported for this credential. */
  plan: z
    .object({
      fiveHour: z.object({ used: z.number(), resetsAt: z.number().optional() }).optional(),
      weekly: z.object({ used: z.number(), resetsAt: z.number().optional() }).optional(),
      updatedAt: z.string(),
    })
    .optional(),
});
const usageSchema = z.object({
  version: z.literal(1),
  credentials: z.record(z.string(), recordSchema),
});
export type CredentialUsage = z.infer<typeof recordSchema>;
export type BankUsage = z.infer<typeof usageSchema>;

function credentialVersion(credential: Credential): string {
  return createHash('sha256').update(`${credential.type}\0${credential.secret}`).digest('hex');
}

export function credentialState(
  data: BankUsage,
  credential: Credential,
): CredentialUsage | undefined {
  const value = Object.hasOwn(data.credentials, credential.name)
    ? data.credentials[credential.name]
    : undefined;
  if (value?.credentialVersion && value.credentialVersion !== credentialVersion(credential)) {
    return { ...value, status: 'ready', resetAt: undefined, lastError: undefined };
  }
  return value;
}

export function isAvailable(usage: CredentialUsage | undefined, now = Date.now()): boolean {
  return (
    !usage || usage.status !== 'exhausted' || (!!usage.resetAt && Date.parse(usage.resetAt) <= now)
  );
}

export class MeterStore {
  readonly file: string;
  constructor(dir = getConfigDir()) {
    this.file = path.join(dir, 'usage.json');
  }

  async read(): Promise<BankUsage> {
    const data = await readJson(this.file);
    if (data === undefined) return { version: 1, credentials: {} };
    const parsed = usageSchema.safeParse(data);
    if (!parsed.success)
      throw new Error('Invalid usage.json. Restore a valid copy or move it aside.');
    return parsed.data;
  }

  private async update(
    credential: Credential,
    fn: (record: CredentialUsage) => void,
  ): Promise<void> {
    await withFileLock(this.file, async () => {
      const data = await this.read();
      const current = credentialState(data, credential) ?? {
        ...emptyUsage(),
        type: credential.type,
        errors: 0,
        limitHits: 0,
        status: 'ready' as const,
      };
      current.credentialVersion = credentialVersion(credential);
      current.type = credential.type;
      fn(current);
      data.credentials[credential.name] = current;
      await atomicWriteJson(this.file, data);
    });
  }

  async request(credential: Credential, count = 1): Promise<void> {
    await this.update(credential, (u) => {
      u.requests += count;
      u.lastUsed = new Date().toISOString();
      if (isAvailable(u)) {
        u.status = 'ready';
        delete u.resetAt;
      }
    });
  }

  async usage(credential: Credential, usage: UsageTotals): Promise<void> {
    await this.update(credential, (u) => {
      Object.assign(u, addUsage(u, { ...usage, requests: 0 }));
    });
  }

  async failure(credential: Credential, error: unknown): Promise<void> {
    const failure = classifyCredentialFailure(error);
    await this.update(credential, (u) => {
      u.errors++;
      u.lastError = redact(error instanceof Error ? error.message : String(error)).slice(0, 1000);
      if (failure) {
        u.limitHits++;
        u.status = 'exhausted';
        u.resetAt = failure.resetAt;
      }
    });
  }

  async retry(credential: Credential, error: unknown): Promise<void> {
    await this.update(credential, (u) => {
      u.errors++;
      if (classifyCredentialFailure(error)) u.limitHits++;
      u.lastError = redact(error instanceof Error ? error.message : String(error)).slice(0, 1000);
    });
  }

  async plan(credential: Credential, usage: PlanUsage): Promise<void> {
    if (!usage.fiveHour && !usage.weekly) return;
    await this.update(credential, (u) => {
      u.plan = {
        ...(usage.fiveHour
          ? { fiveHour: { used: usage.fiveHour.used, resetsAt: usage.fiveHour.resetsAt } }
          : u.plan?.fiveHour
            ? { fiveHour: u.plan.fiveHour }
            : {}),
        ...(usage.weekly
          ? { weekly: { used: usage.weekly.used, resetsAt: usage.weekly.resetsAt } }
          : u.plan?.weekly
            ? { weekly: u.plan.weekly }
            : {}),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  /** Keep a renamed credential's history under its new name. */
  async rename(name: string, next: string): Promise<void> {
    await withFileLock(this.file, async () => {
      const data = await this.read();
      if (!Object.hasOwn(data.credentials, name)) return;
      data.credentials[next] = data.credentials[name]!;
      delete data.credentials[name];
      await atomicWriteJson(this.file, data);
    });
  }

  async reset(credential: Credential): Promise<void> {
    await this.update(credential, (u) => {
      u.status = 'ready';
      delete u.resetAt;
      delete u.lastError;
    });
  }
}
