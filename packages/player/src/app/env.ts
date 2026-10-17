import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import { AudioSpeechPort, RoutingSpeechPort, type AudioLike } from '../engine/audio-port.ts';
import { createWebSpeechPort, toVoiceInfo, type SpeechPort } from '../engine/speech-port.ts';
import { matchingVoices } from '../engine/voices.ts';
import { ttsBuffer } from '../ai/state.ts';
import { ttsStatus } from '../ai/tts.ts';
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

/**
 * Speech: Web Speech voices and server TTS voices behind one routing port (spec 004). A failed TTS
 * utterance is read by the best browser voice for its language.
 */
function speechFor(
  synth: SpeechSynthesis | undefined,
  Utterance: typeof SpeechSynthesisUtterance | undefined,
  source: VoiceSource | undefined,
): AppEnv['speech'] {
  const web = synth && Utterance ? createWebSpeechPort(synth, Utterance) : undefined;
  if (!web && typeof Audio === 'undefined') return undefined;
  let webVoices: VoiceInfo[] = [];
  const audio = new AudioSpeechPort({
    source: () => ttsBuffer.value,
    createAudio: () => new Audio() as unknown as AudioLike,
    onState: (state, error) => (ttsStatus.value = { ...ttsStatus.value, state, ...(error ? { lastError: error } : {}) }),
  });
  const port = new RoutingSpeechPort(
    web,
    audio,
    (lang) => matchingVoices(webVoices, lang)[0]?.voiceURI ?? webVoices[0]?.voiceURI,
    (error) => (ttsStatus.value = { ...ttsStatus.value, limited: true, lastError: error }),
  );
  return {
    port,
    voices: async () => (webVoices = web ? await loadVoices(source) : []),
  };
}

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
    speech: speechFor(synth, Utterance, source),
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
