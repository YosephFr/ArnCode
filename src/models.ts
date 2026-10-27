import type { Effort } from './types.js';

export interface ModelFeatures {
  label: string;
  contextWindow: number;
  /** `thinking: {type: "adaptive"}` and `output_config.effort`. */
  adaptive: boolean;
  xhigh: boolean;
  /** `thinking.display: "updates"` returns progress notes between tool calls. */
  progressUpdates: boolean;
  /** Server-side refusal fallback with `fallbacks: "default"`. */
  fallbacks: boolean;
  /** Effort changes through an effort-only `role: "system"` message. */
  messageEffort: boolean;
  /** Mid-conversation `role: "system"` messages. */
  systemMessages: boolean;
  /** On-demand server-side compaction. */
  compaction: boolean;
  fast: boolean;
}

const modern = {
  contextWindow: 1_000_000,
  adaptive: true,
  xhigh: true,
  progressUpdates: false,
  fallbacks: false,
  messageEffort: false,
  systemMessages: false,
  compaction: true,
  fast: false,
};

// Capabilities checked 2026-10-27 against the Claude API model migration guide.
const known: Record<string, ModelFeatures> = {
  'claude-fable-5-1': {
    ...modern,
    label: 'Fable 5.1',
    progressUpdates: true,
    fallbacks: true,
    messageEffort: true,
    systemMessages: true,
  },
  'claude-fable-5': {
    ...modern,
    label: 'Fable 5',
    progressUpdates: true,
    fallbacks: true,
    systemMessages: true,
  },
  'claude-opus-5-5': {
    ...modern,
    label: 'Opus 5.5',
    progressUpdates: true,
    fallbacks: true,
    messageEffort: true,
    systemMessages: true,
    fast: true,
  },
  'claude-opus-5': {
    ...modern,
    label: 'Opus 5',
    fallbacks: true,
    messageEffort: true,
    systemMessages: true,
    fast: true,
  },
  'claude-sonnet-5-5': {
    ...modern,
    label: 'Sonnet 5.5',
    progressUpdates: true,
    fallbacks: true,
    messageEffort: true,
    systemMessages: true,
  },
  'claude-sonnet-5': { ...modern, label: 'Sonnet 5' },
  'claude-haiku-5-5': {
    ...modern,
    label: 'Haiku 5.5',
    messageEffort: true,
    systemMessages: true,
  },
  'claude-opus-4-8': { ...modern, label: 'Opus 4.8', systemMessages: true, fast: true },
  'claude-opus-4-7': { ...modern, label: 'Opus 4.7' },
  'claude-opus-4-6': { ...modern, label: 'Opus 4.6', xhigh: false },
  'claude-sonnet-4-6': { ...modern, label: 'Sonnet 4.6', xhigh: false },
  'claude-haiku-4-5': {
    ...modern,
    label: 'Haiku 4.5',
    contextWindow: 200_000,
    adaptive: false,
    xhigh: false,
    compaction: false,
  },
};

export const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  fable: 'claude-fable-5-1',
};

export function resolveModel(model: string): string {
  return MODEL_ALIASES[model.toLowerCase()] ?? model;
}

export function modelFeatures(model: string): ModelFeatures {
  const id = model.replace(/-\d{8}$/, '');
  return (
    known[id] ?? {
      ...modern,
      label: id.replace(/^claude-/, ''),
      contextWindow: 200_000,
      compaction: false,
    }
  );
}

/** Effort the model accepts: `xhigh` falls back to `high` where it is unsupported. */
export function modelEffort(model: string, effort: Effort): Effort {
  return effort === 'xhigh' && !modelFeatures(model).xhigh ? 'high' : effort;
}

export const KNOWN_MODELS = Object.keys(known);
