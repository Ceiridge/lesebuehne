import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import { createWebSpeechPort, toVoiceInfo, type SpeechPort } from '../engine/speech-port.ts';
import { loadVoices, realTimers, type Timers, type VoiceInfo, type VoiceSource } from '../engine/voices.ts';
import { Highlighter } from '../highlight/highlighter.ts';
import { IndexedDbRepository } from '../storage/indexeddb.ts';
import { LibraryService } from '../storage/library.ts';
import { browserStore, SettingsStore, type KeyValueStore } from '../settings/settings.ts';

/** Everything the UI needs from the outside world; tests pass fakes (B12). */
export interface AppEnv {
  library: () => Promise<LibraryService>;
  /** Undefined → silent reading mode (B7, C4). */
  speech: { port: SpeechPort; voices: () => Promise<VoiceInfo[]> } | undefined;
  settings: SettingsStore;
  kv: KeyValueStore;
  fetch: (url: string) => Promise<Response>;
  baseURI: () => string;
  timers: Timers;
  highlighter: () => Highlighter;
  /** Whether the OS asks for dark colours / reduced motion. */
  prefersDark: () => boolean;
  /** Full HTTP (AI server and BYOK providers); undefined → no AI (tests, B8). */
  http?: (url: string, init?: RequestInit) => Promise<Response>;
  /** IndexedDB for the AI result cache (browser mode). */
  indexedDB?: IDBFactory;
}

function media(query: string): boolean {
  try {
    return globalThis.matchMedia?.(query).matches ?? false;
  } catch {
    return false;
  }
}

let libraryPromise: Promise<LibraryService> | undefined;

/** The real browser environment. */
export function browserEnv(): AppEnv {
  const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  const Utterance = (globalThis as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance }).SpeechSynthesisUtterance;
  const kv = browserStore();
  const source: VoiceSource | undefined = synth
    ? {
        getVoices: () => synth.getVoices().map(toVoiceInfo),
        addEventListener: (t, fn) => synth.addEventListener(t, fn),
        removeEventListener: (t, fn) => synth.removeEventListener(t, fn),
      }
    : undefined;
  return {
    library: () => {
      libraryPromise ??= LibraryService.create(
        typeof indexedDB === 'undefined' ? undefined : new IndexedDbRepository(indexedDB),
      );
      return libraryPromise;
    },
    speech: synth && Utterance ? { port: createWebSpeechPort(synth, Utterance), voices: () => loadVoices(source) } : undefined,
    settings: new SettingsStore(kv, media('(prefers-reduced-motion: reduce)')),
    kv,
    fetch: (url) => fetch(url),
    baseURI: () => document.baseURI,
    timers: realTimers,
    highlighter: () => Highlighter.forDocument(),
    prefersDark: () => media('(prefers-color-scheme: dark)'),
    http: (url, init) => fetch(url, init),
    ...(typeof indexedDB === 'undefined' ? {} : { indexedDB }),
  };
}

export const EnvContext = createContext<AppEnv | null>(null);

export function useEnv(): AppEnv {
  const env = useContext(EnvContext);
  if (!env) throw new Error('AppEnv missing');
  return env;
}
