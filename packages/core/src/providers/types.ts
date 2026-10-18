import type * as z from 'zod';

/** Provider kinds (brief §7.1). */
export type ProviderKind = 'llm' | 'tts' | 'image' | 'align';
export type RunsIn = 'browser' | 'server';
export type CostHint = 'free' | 'subscription' | 'metered';

export interface Availability {
  ok: boolean;
  /** Why not (shown in settings and `bun run doctor`), e.g. "no API key", "token expired". */
  reason?: string;
}

export interface ProviderLimits {
  /** Requests in flight at the same time. */
  concurrency: number;
  /** Minimum time between two request starts. */
  minIntervalMs?: number;
}

/** What every provider declares about itself. */
export interface ProviderMeta {
  id: string;
  kind: ProviderKind;
  /** Human-readable name for settings and status. */
  label: string;
  runsIn: readonly RunsIn[];
  /** e.g. `{ jsonSchema: true, streaming: true, vision: false, languages: 'de,en' }`. */
  capabilities: Readonly<Record<string, boolean | string | number>>;
  limits?: ProviderLimits;
  costHint?: CostHint;
  isAvailable(): Promise<Availability>;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  /** Cost reported by the provider (OpenRouter), in USD. */
  cost?: number;
}

// ---------------------------------------------------------------------------------------------
// LLM

export interface LLMRequest<T> {
  /** Instructions (system prompt). */
  system: string;
  /** The user message; book text inside it is delimited data. */
  user: string;
  schema: z.ZodType<T>;
  /** Short identifier of the schema (`visual_plan`), used for native structured output. */
  schemaName: string;
  /**
   * Domain checks after the schema passed (verbatim anchors …). Problems trigger the one repair
   * attempt together with schema errors.
   */
  validate?: (value: T) => string[];
  signal: AbortSignal;
  /** Model override for this request (otherwise the provider's configured model). */
  model?: string;
  /** What the request is for; `reasoningEffort: 'auto'` picks a level per task. */
  task?: LlmTask;
  /** Reasoning level (`low`, `medium` …), `auto` (by task) or absent (the model's default). */
  reasoningEffort?: string;
  /** Service tier id from the model catalog (`priority` = fast), or absent (standard). */
  serviceTier?: string;
}

export type LlmTask = 'plan' | 'style' | 'animate';

/** One selectable model, as a provider's catalog describes it. */
export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  /** Reasoning levels the model accepts, in its order (empty: no reasoning control). */
  reasoningLevels?: Array<{ effort: string; description?: string }>;
  defaultReasoning?: string;
  /** Speed / service tiers beyond the standard one (`priority` = fast). */
  serviceTiers?: Array<{ id: string; name: string; description?: string }>;
  defaultServiceTier?: string;
}

const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
/** Recommended reasoning per task: plans are a quick choice, style and animation code need more thought. */
const RECOMMENDED: Record<LlmTask, string> = { plan: 'low', style: 'medium', animate: 'medium' };

/**
 * The reasoning level to send: an explicit supported level as is, `auto` mapped to the nearest
 * supported level of the task's recommendation, otherwise nothing (the model's default).
 */
export function effortFor(wanted: string | undefined, task: LlmTask | undefined, levels: readonly string[]): string | undefined {
  if (!wanted || levels.length === 0) return undefined;
  if (wanted !== 'auto') return levels.includes(wanted) ? wanted : undefined;
  const target = EFFORT_ORDER.indexOf(RECOMMENDED[task ?? 'plan']);
  let best: string | undefined;
  let distance = Infinity;
  for (const level of levels) {
    const k = EFFORT_ORDER.indexOf(level);
    const d = k < 0 ? Infinity : Math.abs(k - target);
    if (d < distance) { best = level; distance = d; }
  }
  return best;
}

export interface LLMResult<T> {
  value: T;
  model: string;
  usage?: Usage;
  /** 0 = first answer valid, 1 = valid after the repair request. */
  repairs: number;
}

export interface LLMProvider extends ProviderMeta {
  kind: 'llm';
  completeJSON<T>(req: LLMRequest<T>): Promise<LLMResult<T>>;
  /** The models this account or endpoint offers (for the model picker), if the provider can list them. */
  listModels?(signal: AbortSignal): Promise<ModelOption[]>;
}

// ---------------------------------------------------------------------------------------------
// TTS, image, alignment (interfaces for M4/M5; brief §7.1)

export interface WordTiming {
  /** Character range in the synthesised text. */
  start: number;
  end: number;
  /** Seconds from the start of the audio. */
  t0: number;
  t1: number;
}

export interface TTSVoice {
  /** Provider-local voice id (e.g. "vivian"). */
  id: string;
  /** Display name. */
  name: string;
  /** Primary languages (`de`, `en` …); empty = multilingual. */
  languages: string[];
}

export interface TTSProvider extends ProviderMeta {
  kind: 'tts';
  readonly voices: readonly TTSVoice[];
  synthesize(req: { text: string; lang: string; voice?: string; signal: AbortSignal }): Promise<{
    audio: Uint8Array;
    mime: string;
    words?: WordTiming[];
  }>;
  /**
   * Optional streaming synthesis: raw s16le mono PCM chunks while they are generated, so playback
   * can start after the first frames instead of after the whole utterance.
   */
  synthesizeStream?(req: { text: string; lang: string; voice?: string; signal: AbortSignal }): Promise<{
    sampleRate: number;
    chunks: AsyncIterable<Uint8Array>;
  }>;
}

export type ImageQuality = 'low' | 'medium' | 'high';

export interface ImageProvider extends ProviderMeta {
  kind: 'image';
  /** `size` like `1536x1024`; `styleRef` = an image whose style to follow (PNG/JPEG bytes). */
  generate(req: { prompt: string; size: string; quality?: ImageQuality; styleRef?: Uint8Array; signal: AbortSignal }): Promise<{ image: Uint8Array; mime: string; model?: string }>;
}

export interface Aligner extends ProviderMeta {
  kind: 'align';
  align(req: { audio: Uint8Array; text: string; lang: string; signal: AbortSignal }): Promise<WordTiming[]>;
}

export type AnyProvider = LLMProvider | TTSProvider | ImageProvider | Aligner;
