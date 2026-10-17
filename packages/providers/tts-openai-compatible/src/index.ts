/**
 * @lesebuehne/tts-openai-compatible — any OpenAI-compatible speech endpoint (`POST
 * {baseURL}/audio/speech`): a local qwentts.cpp `tts-server`, OpenAI, or others. Always asks for
 * WAV (or raw PCM, wrapped), so audio can be decoded and aligned everywhere.
 */
import {
  pcm16ToWav,
  ProviderError,
  request,
  type Availability,
  type CostHint,
  type FetchLike,
  type RunsIn,
  type TTSProvider,
  type TTSVoice,
} from '@lesebuehne/core';

export interface OpenAICompatibleTTSConfig {
  id: string;
  label?: string;
  /** e.g. `http://127.0.0.1:8080/v1` (qwentts `tts-server`), `https://api.openai.com/v1`. */
  baseURL: string;
  apiKey?: string;
  model?: string;
  voices: TTSVoice[];
  /** How the language is sent: not at all, as ISO code (`de`) or as English name (`German`). */
  language?: 'none' | 'code' | 'name';
  /** `wav` (default) or raw 16-bit PCM at `pcmSampleRate`. */
  format?: 'wav' | 'pcm';
  pcmSampleRate?: number;
  /** Extra body fields (`seed`, `temperature` …). */
  body?: Record<string, unknown>;
  requiresKey?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  costHint?: CostHint;
  runsIn?: readonly RunsIn[];
  fetch?: FetchLike;
}

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  de: 'German',
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
};

export class OpenAICompatibleTTS implements TTSProvider {
  readonly kind = 'tts' as const;
  readonly id: string;
  readonly label: string;
  readonly runsIn: readonly RunsIn[];
  readonly capabilities: Record<string, boolean | string | number>;
  readonly limits: { concurrency: number };
  readonly costHint: CostHint;
  readonly voices: readonly TTSVoice[];
  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: OpenAICompatibleTTSConfig) {
    this.id = config.id;
    this.label = config.label ?? config.id;
    this.runsIn = config.runsIn ?? ['server'];
    this.voices = config.voices;
    this.capabilities = { wordTimings: false, format: config.format ?? 'wav' };
    this.limits = { concurrency: config.concurrency ?? 2 };
    this.costHint = config.costHint ?? (config.requiresKey ? 'metered' : 'free');
    this.fetchImpl = config.fetch ?? ((u, i) => fetch(u, i));
  }

  private url(path: string): string {
    return `${this.config.baseURL.replace(/\/+$/u, '')}${path}`;
  }

  async isAvailable(): Promise<Availability> {
    if (!this.config.baseURL) return { ok: false, reason: 'no base URL configured' };
    if (this.voices.length === 0) return { ok: false, reason: 'no voices configured' };
    if (this.config.requiresKey) return this.config.apiKey ? { ok: true } : { ok: false, reason: 'no API key configured' };
    // Local servers: any HTTP answer means it is running.
    try {
      await this.fetchImpl(this.config.baseURL.replace(/\/v1\/?$/u, '/'), { method: 'GET', signal: AbortSignal.timeout(1500) });
      return { ok: true };
    } catch {
      return { ok: false, reason: `not reachable at ${this.config.baseURL}` };
    }
  }

  async synthesize(req: { text: string; lang: string; voice?: string; signal: AbortSignal }): Promise<{ audio: Uint8Array; mime: string }> {
    const voice = req.voice ?? this.voices[0]?.id;
    if (!voice) throw new ProviderError(this.id, 'bad-request', 'no voice');
    const lang = req.lang.toLowerCase().split(/[-_]/u)[0] ?? req.lang;
    const language = this.config.language === 'code' ? lang : this.config.language === 'name' ? (LANGUAGE_NAMES[lang] ?? lang) : undefined;
    const format = this.config.format ?? 'wav';
    const res = await request(this.id, this.fetchImpl, this.url('/audio/speech'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) },
      body: JSON.stringify({
        ...(this.config.model ? { model: this.config.model } : {}),
        input: req.text,
        voice,
        response_format: format,
        ...(language ? { language } : {}),
        ...this.config.body,
      }),
      timeoutMs: this.config.timeoutMs ?? 120_000,
      signal: req.signal,
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength < 64) throw new ProviderError(this.id, 'invalid-output', 'empty audio');
    if (format === 'pcm') return { audio: pcm16ToWav(bytes, this.config.pcmSampleRate ?? 24000), mime: 'audio/wav' };
    const riff = String.fromCharCode(...bytes.slice(0, 4));
    if (riff !== 'RIFF') throw new ProviderError(this.id, 'invalid-output', 'answer is not WAV audio');
    return { audio: bytes, mime: 'audio/wav' };
  }
}

/** A local qwentts.cpp `tts-server` (Qwen3-TTS): one request at a time, language by name, fixed seed. */
export function qwentts(o: { id?: string; baseURL?: string; voices: Array<string | TTSVoice>; seed?: number; fetch?: FetchLike }): OpenAICompatibleTTS {
  return new OpenAICompatibleTTS({
    id: o.id ?? 'qwentts',
    label: 'Qwen3-TTS (qwentts.cpp, local)',
    baseURL: o.baseURL ?? 'http://127.0.0.1:8080/v1',
    voices: o.voices.map((v) => (typeof v === 'string' ? { id: v, name: v, languages: [] } : v)),
    language: 'name',
    format: 'wav',
    body: { seed: o.seed ?? 42 },
    concurrency: 1,
    timeoutMs: 300_000,
    costHint: 'free',
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
}

/** OpenAI's speech endpoint (metered). */
export function openaiTTS(o: { id?: string; apiKey?: string; model?: string; voices?: string[]; fetch?: FetchLike }): OpenAICompatibleTTS {
  return new OpenAICompatibleTTS({
    id: o.id ?? 'openai-tts',
    label: 'OpenAI speech',
    baseURL: 'https://api.openai.com/v1',
    ...(o.apiKey ? { apiKey: o.apiKey } : {}),
    model: o.model ?? 'gpt-4o-mini-tts',
    voices: (o.voices ?? ['alloy', 'nova', 'onyx']).map((v) => ({ id: v, name: v, languages: [] })),
    requiresKey: true,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
}

export default function create(config: OpenAICompatibleTTSConfig): OpenAICompatibleTTS {
  return new OpenAICompatibleTTS(config);
}
