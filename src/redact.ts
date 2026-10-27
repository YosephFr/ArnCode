const secrets = new Set<string>();
const anthropicPrefix = 'sk-ant-';
const tokenCharacter = /[A-Za-z0-9_.=-]/;

export function registerSecret(secret: string): void {
  if (secret) secrets.add(secret);
}

export function registerEnvironmentSecrets(env: NodeJS.ProcessEnv = process.env): void {
  for (const [name, value] of Object.entries(env)) {
    if (
      value &&
      !/(?:_FILE_DESCRIPTOR|_HELPER)$/.test(name) &&
      /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|ACCESS_KEY|PRIVATE_KEY)(?:$|_)/.test(name)
    ) {
      registerSecret(value);
    }
  }
}

export function redact(value: string): string {
  let result = value;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(secret, '[redacted]');
  }
  return result
    .replace(/sk-ant-[A-Za-z0-9_.=-]*/g, '[redacted]')
    .replace(/\b(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s"',;}]+/gi, '$1[redacted]');
}

/** Redact every string inside a JSON value, keeping its structure valid. */
export function redactDeep<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value ?? null, (_key, item: unknown) =>
      typeof item === 'string' ? redact(item) : item,
    ),
  ) as T;
}

export class StreamingRedactor {
  private pending = '';
  private hidingToken = false;

  write(chunk: string): string {
    this.pending += chunk;
    const candidates = [...secrets].sort((a, b) => b.length - a.length);
    let output = '';
    let position = 0;

    while (position < this.pending.length) {
      const character = this.pending[position]!;
      if (this.hidingToken) {
        if (tokenCharacter.test(character)) {
          position++;
          continue;
        }
        this.hidingToken = false;
      }
      if (this.pending.startsWith(anthropicPrefix, position)) {
        output += '[redacted]';
        position += anthropicPrefix.length;
        this.hidingToken = true;
        continue;
      }
      const suffix = this.pending.slice(position);
      if (
        anthropicPrefix.startsWith(suffix) ||
        candidates.some((secret) => secret.length > suffix.length && secret.startsWith(suffix))
      ) {
        break;
      }
      const match = candidates.find((secret) => this.pending.startsWith(secret, position));
      if (match) {
        output += '[redacted]';
        position += match.length;
        continue;
      }
      output += character;
      position++;
    }
    this.pending = this.pending.slice(position);
    return output;
  }

  flush(): string {
    const partialSecret =
      this.pending.length >= 4 && [...secrets].some((secret) => secret.startsWith(this.pending));
    const result = this.hidingToken ? '' : partialSecret ? '[redacted]' : redact(this.pending);
    this.pending = '';
    this.hidingToken = false;
    return result;
  }
}
