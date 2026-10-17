import { primaryLanguage } from '@lesebuehne/core';

/** The parts of `SpeechSynthesisVoice` the player uses. */
export interface VoiceInfo {
  voiceURI: string;
  name: string;
  lang: string;
  localService: boolean;
  default: boolean;
  /** Server TTS provider (`tts:<provider>:<voice>` voices). */
  provider?: string;
}

export type VoiceChoice =
  | { mode: 'silent' }
  | { mode: 'voice'; voice: VoiceInfo; /** false → no voice for the book language (notice) */ matched: boolean };

/** Voices whose primary language subtag matches `lang` (`en-GB` matches `en`), local ones first. */
export function matchingVoices(voices: readonly VoiceInfo[], lang: string): VoiceInfo[] {
  const primary = primaryLanguage(lang);
  return voices
    .filter((v) => primaryLanguage(v.lang) === primary)
    .sort((a, b) => Number(!!b.provider) - Number(!!a.provider) || Number(b.localService) - Number(a.localService) || Number(b.default) - Number(a.default));
}

/**
 * Voice selection (B7, C4): the preferred voice if it is available, else the best match for the
 * book language (local preferred), else the browser default voice with a notice, else silent mode.
 */
export function selectVoice(voices: readonly VoiceInfo[], lang: string, preferredURI?: string): VoiceChoice {
  if (voices.length === 0) return { mode: 'silent' };
  const matches = matchingVoices(voices, lang);
  const preferred = preferredURI ? voices.find((v) => v.voiceURI === preferredURI) : undefined;
  if (preferred) return { mode: 'voice', voice: preferred, matched: matches.includes(preferred) };
  const best = matches[0];
  if (best) return { mode: 'voice', voice: best, matched: true };
  const fallback = voices.find((v) => v.default) ?? voices[0];
  return fallback ? { mode: 'voice', voice: fallback, matched: false } : { mode: 'silent' };
}

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export const realTimers: Timers = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** The part of `SpeechSynthesis` needed to list voices. */
export interface VoiceSource {
  getVoices(): readonly VoiceInfo[];
  addEventListener(type: 'voiceschanged', fn: () => void): void;
  removeEventListener(type: 'voiceschanged', fn: () => void): void;
}

/** Voices load asynchronously: wait for `voiceschanged` at most `maxWaitMs` (B7: 2 s). */
export function loadVoices(source: VoiceSource | undefined, timers: Timers = realTimers, maxWaitMs = 2000): Promise<VoiceInfo[]> {
  if (!source) return Promise.resolve([]);
  const now = source.getVoices();
  if (now.length > 0) return Promise.resolve([...now]);
  return new Promise((resolve) => {
    const done = (): void => {
      timers.clearTimeout(timer);
      source.removeEventListener('voiceschanged', done);
      resolve([...source.getVoices()]);
    };
    const timer = timers.setTimeout(done, maxWaitMs);
    source.addEventListener('voiceschanged', done);
  });
}
