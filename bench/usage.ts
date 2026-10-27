import { stripVTControlCharacters } from 'node:util';

/** What a contestant reported about one run. A figure it did not report stays null. */
export interface Usage {
  /** Input tokens billed at the base rate: neither read from nor written to a prompt cache. */
  inputTokens: number | null;
  /** Output tokens, including reasoning or thinking. */
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** The tool's own cost estimate in USD. */
  costUsd: number | null;
  /** Model requests, when the tool reports them. */
  turns: number | null;
}

type Parser = (stdout: string, stderr: string) => Usage;
type Json = Record<string, unknown>;

export function unknownUsage(): Usage {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
    turns: null,
  };
}

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const figure = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Sums a figure across reports; unknown when any report lacks it. */
function total<T>(items: T[], pick: (item: T) => number | null): number | null {
  let sum = 0;
  for (const item of items) {
    const value = pick(item);
    if (value === null) return null;
    sum += value;
  }
  return items.length ? sum : null;
}

function jsonLines(text: string): Json[] {
  const events: Json[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isObject(value)) events.push(value);
    } catch {
      // Not an event line.
    }
  }
  return events;
}

// ArnCode prints formatUsage() from src/usage.ts on stderr after a -p run:
// "Session: 1,234 uncached in · 56 out · 7,890 cache read · 12 cache write · $0.0123 estimated".
const SESSION =
  /^Session: ([\d,]+) uncached in · ([\d,]+) out · ([\d,]+) cache read · ([\d,]+) cache write · (.+)$/;

function arncode(stdout: string, stderr: string): Usage {
  // `--output-format json` prints one result object with exact figures.
  const result = jsonLines(stdout)
    .reverse()
    .find((event) => event.type === 'result');
  if (result) {
    const usage = isObject(result.usage) ? result.usage : {};
    return {
      inputTokens: figure(usage.input_tokens),
      outputTokens: figure(usage.output_tokens),
      cacheReadTokens: figure(usage.cache_read_input_tokens),
      cacheWriteTokens: figure(usage.cache_creation_input_tokens),
      costUsd: figure(result.total_cost_usd),
      turns: figure(result.num_turns),
    };
  }
  const lines = stripVTControlCharacters(stderr).split('\n').reverse();
  for (const line of lines) {
    if (line.trim() === 'Session: No usage yet.') {
      const none = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      return { ...none, costUsd: 0, turns: null };
    }
    const match = SESSION.exec(line.trim());
    if (!match) continue;
    const [input, output, read, write] = match
      .slice(1, 5)
      .map((n) => Number(n.replaceAll(',', '')));
    const [cost, ...extras] = (match[5] ?? '').split(' · ');
    // "<$0.0001", "cost unavailable" and partly unpriced sessions have no exact total.
    const price = /^\$(\d+(?:\.\d+)?) estimated$/.exec(cost ?? '');
    const partial = extras.some((extra) => extra.includes('unpriced'));
    return {
      inputTokens: input ?? null,
      outputTokens: output ?? null,
      cacheReadTokens: read ?? null,
      cacheWriteTokens: write ?? null,
      costUsd: price && !partial ? Number(price[1]) : null,
      turns: null,
    };
  }
  return unknownUsage();
}

// claude -p --output-format json prints one result object. Its `usage` covers the main agent loop
// only; `modelUsage` adds subagents and auxiliary models and matches `total_cost_usd`.
function claudeCode(stdout: string): Usage {
  let result: Json | undefined;
  try {
    const value: unknown = JSON.parse(stdout);
    if (isObject(value)) result = value;
  } catch {
    result = jsonLines(stdout)
      .reverse()
      .find((event) => event.type === 'result');
  }
  if (!result || result.type !== 'result') return unknownUsage();
  const models = isObject(result.modelUsage)
    ? Object.values(result.modelUsage).filter(isObject)
    : [];
  const main = isObject(result.usage) ? result.usage : undefined;
  const tokens = (modelKey: string, usageKey: string) =>
    models.length
      ? total(models, (model) => figure(model[modelKey]))
      : main
        ? figure(main[usageKey])
        : null;
  return {
    inputTokens: tokens('inputTokens', 'input_tokens'),
    outputTokens: tokens('outputTokens', 'output_tokens'),
    cacheReadTokens: tokens('cacheReadInputTokens', 'cache_read_input_tokens'),
    cacheWriteTokens: tokens('cacheCreationInputTokens', 'cache_creation_input_tokens'),
    costUsd: figure(result.total_cost_usd),
    turns: figure(result.num_turns),
  };
}

// opencode run --format json prints one event per line; each model request ends with a
// step_finish event whose part carries cost and tokens. OpenCode 1.x counts reasoning apart from
// visible output and bills both at the output rate. Subagent sessions emit no events here.
function opencode(stdout: string): Usage {
  const steps = jsonLines(stdout)
    .filter((event) => event.type === 'step_finish')
    .map((event) => event.part)
    .filter(isObject);
  if (!steps.length) return unknownUsage();
  const tokens = (part: Json): Json => (isObject(part.tokens) ? part.tokens : {});
  const cache = (part: Json): Json => {
    const value = tokens(part).cache;
    return isObject(value) ? value : {};
  };
  return {
    inputTokens: total(steps, (part) => figure(tokens(part).input)),
    outputTokens: total(steps, (part) => {
      const output = figure(tokens(part).output);
      return output === null ? null : output + (figure(tokens(part).reasoning) ?? 0);
    }),
    cacheReadTokens: total(steps, (part) => figure(cache(part).read)),
    cacheWriteTokens: total(steps, (part) => figure(cache(part).write)),
    costUsd: total(steps, (part) => figure(part.cost)),
    turns: steps.length,
  };
}

// codex exec --json prints one event per line; each turn.completed carries usage. As in the
// Responses API, input_tokens includes cached reads and cache writes, and output_tokens includes
// reasoning. Codex reports no cost.
function codex(stdout: string): Usage {
  const turns = jsonLines(stdout)
    .filter((event) => event.type === 'turn.completed')
    .map((event) => event.usage)
    .filter(isObject);
  if (!turns.length) return unknownUsage();
  const input = total(turns, (usage) => figure(usage.input_tokens));
  const read = total(turns, (usage) => figure(usage.cached_input_tokens));
  const write = total(turns, (usage) => figure(usage.cache_write_input_tokens));
  return {
    inputTokens: input === null || read === null ? null : input - read - (write ?? 0),
    outputTokens: total(turns, (usage) => figure(usage.output_tokens)),
    cacheReadTokens: read,
    cacheWriteTokens: write,
    costUsd: null,
    turns: null,
  };
}

export const usageParsers: Record<string, Parser> = {
  arncode,
  'claude-code': claudeCode,
  opencode,
  codex,
  none: () => unknownUsage(),
};

export function parseUsage(parser: string, stdout: string, stderr: string): Usage {
  const parse = usageParsers[parser];
  if (!parse) throw new Error(`Unknown usage parser ${parser}.`);
  return parse(stdout, stderr);
}
