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
});
export type AiPrefs = z.infer<typeof AiPrefsSchema>;
export type ByokConfig = z.infer<typeof Byok>;

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
