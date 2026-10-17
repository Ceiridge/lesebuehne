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

export interface TTSProvider extends ProviderMeta {
  kind: 'tts';
  synthesize(req: { text: string; lang: string; voice?: string; signal: AbortSignal }): Promise<{
    audio: Uint8Array;
    mime: string;
    words?: WordTiming[];
  }>;
}

export interface ImageProvider extends ProviderMeta {
  kind: 'image';
  generate(req: { prompt: string; size: string; styleRef?: string; signal: AbortSignal }): Promise<{ image: Uint8Array; mime: string }>;
}

export interface Aligner extends ProviderMeta {
  kind: 'align';
  align(req: { audio: Uint8Array; text: string; lang: string; signal: AbortSignal }): Promise<WordTiming[]>;
}

export type AnyProvider = LLMProvider | TTSProvider | ImageProvider | Aligner;
