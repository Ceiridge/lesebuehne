import type { VoiceInfo } from './voices.ts';

/** One utterance as the sequencer asks for it. */
export interface UtteranceRequest {
  text: string;
  lang: string;
  voiceURI?: string;
  /** Speech rate = tempo (0.75 … 2.5). */
  rate: number;
  /** Start at this character in a cached generated-audio clip. */
  startOffset?: number;
  volume?: number;
  onStart(): void;
  /** `charIndex` relative to `text`; `name` is `word` or `sentence`. */
  onBoundary(charIndex: number, name: string): void;
  onEnd(): void;
  onError(error: string): void;
  /** Playback was paused from outside (media keys, headset, the OS). */
  onInterrupted?(): void;
}

/** What the engine needs from a TTS (Web Speech in the browser, a fake in tests, B12). */
export interface SpeechPort {
  speak(request: UtteranceRequest): void;
  cancel(): void;
  setVolume?(volume: number): void;
  /** Waiting for audio that is still being generated (not stuck). */
  busy?(): boolean;
}

/** The parts of the Web Speech API the adapter uses. */
export interface SynthLike {
  speak(u: SpeechSynthesisUtterance): void;
  cancel(): void;
  getVoices(): readonly SpeechSynthesisVoice[];
}

/**
 * Web Speech adapter. Keeps strong references to live utterances (some engines drop events of
 * garbage-collected utterances) and waits one macrotask between `cancel()` and `speak()`.
 */
export function createWebSpeechPort(synth: SynthLike, Utterance: typeof SpeechSynthesisUtterance): SpeechPort {
  const live = new Set<SpeechSynthesisUtterance>();
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let volume = 1;
  return {
    speak(r) {
      volume = r.volume ?? volume;
      if (pendingTimer !== undefined) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => {
        pendingTimer = undefined;
        const u = new Utterance(r.text);
        u.lang = r.lang;
        u.rate = r.rate;
        u.volume = volume;
        const voice = r.voiceURI ? synth.getVoices().find((v) => v.voiceURI === r.voiceURI) : undefined;
        if (voice) u.voice = voice;
        const release = (): void => {
          live.delete(u);
        };
        u.onstart = () => r.onStart();
        u.onboundary = (e) => r.onBoundary(e.charIndex, e.name);
        u.onend = () => {
          release();
          r.onEnd();
        };
        u.onerror = (e) => {
          release();
          if (e.error !== 'interrupted' && e.error !== 'canceled') r.onError(e.error);
        };
        live.add(u);
        synth.speak(u);
      }, 0);
    },
    cancel() {
      if (pendingTimer !== undefined) clearTimeout(pendingTimer);
      pendingTimer = undefined;
      synth.cancel();
      live.clear();
    },
    setVolume(value) {
      volume = value;
      for (const u of live) u.volume = value;
    },
  };
}

export function toVoiceInfo(v: SpeechSynthesisVoice): VoiceInfo {
  return { voiceURI: v.voiceURI, name: v.name, lang: v.lang, localService: v.localService, default: v.default };
}
