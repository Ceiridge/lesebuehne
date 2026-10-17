import { signal } from '@preact/signals';
import type { AppEnv } from '../app/env.ts';
import { route } from '../app/store.ts';
import { detectBackend } from './backends.ts';
import { IdbMediaStore, IdbResultCache } from './idb-cache.ts';
import { loadAiPrefs, saveAiPrefs, type AiPrefs } from './prefs.ts';
import { aiBackend, refreshDetails, setBackend } from './state.ts';

export const aiPrefs = signal<AiPrefs | undefined>(undefined);
export const aiConnecting = signal(false);
/** Provider edits are applied together, so typing never tears down active speech. */
export const aiDraft = signal<AiPrefs | undefined>(undefined);

let generation = 0;

/**
 * Finds the AI backend for the current preferences and attaches it to the open book. Runs at
 * start and after every provider settings change; reading never waits for it.
 */
export async function connectAi(env: AppEnv): Promise<void> {
  if (!env.http) return;
  const prefs = aiPrefs.value ?? loadAiPrefs(env.kv);
  aiPrefs.value = prefs;
  const mine = ++generation;
  aiConnecting.value = true;
  try {
    const backend = await detectBackend({
      prefs,
      http: env.http,
      baseURI: env.baseURI(),
      ...(env.indexedDB ? { cache: () => new IdbResultCache(env.indexedDB!), media: () => new IdbMediaStore(env.indexedDB!) } : {}),
    });
    if (mine !== generation) return;
    const r = route.value;
    if (r.name === 'reader') r.session.engine.pause();
    setBackend(backend);
    await refreshDetails();
    if (mine !== generation) return;
    if (r.name === 'reader') {
      await r.session.refreshVoices();
      r.session.attachAi(aiBackend.value);
    }
  } finally {
    if (mine === generation) aiConnecting.value = false;
  }
}

export function updateAiPrefs(env: AppEnv, patch: (p: AiPrefs) => AiPrefs): void {
  const next = patch(aiPrefs.value ?? loadAiPrefs(env.kv));
  aiPrefs.value = next;
  saveAiPrefs(env.kv, next);
}
