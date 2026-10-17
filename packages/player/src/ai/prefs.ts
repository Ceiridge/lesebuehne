import * as z from 'zod';
import type { KeyValueStore } from '../settings/settings.ts';

/** Browser providers (BYOK): keys live only in this browser's localStorage (B8). */
export const BROWSER_PROVIDERS = ['openrouter', 'openai-compatible', 'anthropic-compatible'] as const;
export type BrowserProviderId = (typeof BROWSER_PROVIDERS)[number];

const Byok = z.object({
  enabled: z.boolean().catch(false),
  apiKey: z.string().catch(''),
  model: z.string().catch(''),
  baseURL: z.string().catch(''),
});

/** Browser images (spec 006 B3): OpenRouter image models or an OpenAI-compatible images endpoint. */
export const BROWSER_IMAGE_PROVIDERS = ['off', 'openrouter', 'openai-compatible'] as const;
const BrowserImages = z.object({
  provider: z.enum(BROWSER_IMAGE_PROVIDERS).catch('off'),
  /** Empty with OpenRouter: the OpenRouter text key is used. */
  apiKey: z.string().catch(''),
  baseURL: z.string().catch(''),
  model: z.string().catch(''),
});

/** Browser voices (spec 006 B3): an OpenAI-compatible speech endpoint (a local qwentts with CORS, OpenAI …). */
export const BROWSER_VOICE_PRESETS = ['openai-compatible', 'qwentts', 'openai'] as const;
const BrowserVoice = z.object({
  enabled: z.boolean().catch(false),
  preset: z.enum(BROWSER_VOICE_PRESETS).catch('openai-compatible'),
  baseURL: z.string().catch(''),
  apiKey: z.string().catch(''),
  model: z.string().catch(''),
  /** Comma-separated voice ids. */
  voices: z.string().catch(''),
});

export const AiPrefsSchema = z.object({
  /** off: heuristic only; auto: server if present, else BYOK, else heuristic. */
  mode: z.enum(['auto', 'off']).catch('auto'),
  /** Optional server URL when the player is not served by it (e.g. `http://127.0.0.1:8787`). */
  serverUrl: z.string().catch(''),
  order: z.array(z.enum(BROWSER_PROVIDERS)).catch([...BROWSER_PROVIDERS]),
  byok: z
    .object({
      openrouter: Byok.catch(Byok.parse({})),
      'openai-compatible': Byok.catch(Byok.parse({})),
      'anthropic-compatible': Byok.catch(Byok.parse({})),
    })
    .catch({ openrouter: Byok.parse({}), 'openai-compatible': Byok.parse({}), 'anthropic-compatible': Byok.parse({}) }),
  images: BrowserImages.catch(BrowserImages.parse({})),
  voice: BrowserVoice.catch(BrowserVoice.parse({})),
});
export type AiPrefs = z.infer<typeof AiPrefsSchema>;
export type ByokConfig = z.infer<typeof Byok>;
export type BrowserImagePrefs = z.infer<typeof BrowserImages>;
export type BrowserVoicePrefs = z.infer<typeof BrowserVoice>;

/** Separate from the reading settings, so keys never travel with a settings export. */
export const AI_PREFS_KEY = 'lesebuehne.ai.v1';

export function loadAiPrefs(kv: KeyValueStore): AiPrefs {
  let raw: unknown = {};
  try {
    raw = JSON.parse(kv.get(AI_PREFS_KEY) ?? '{}');
  } catch {
    raw = {};
  }
  const prefs = AiPrefsSchema.parse(raw ?? {});
  // Keep every provider in the order list exactly once.
  prefs.order = [...new Set([...prefs.order, ...BROWSER_PROVIDERS])].filter((p) => BROWSER_PROVIDERS.includes(p));
  return prefs;
}

export function saveAiPrefs(kv: KeyValueStore, prefs: AiPrefs): void {
  kv.set(AI_PREFS_KEY, JSON.stringify(prefs));
}

/** "sk-or-…1234" for display; never the full key. */
export function maskKey(key: string): string {
  if (!key) return '';
  return key.length <= 8 ? '••••' : `${key.slice(0, 5)}…${key.slice(-4)}`;
}
