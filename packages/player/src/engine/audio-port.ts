import type { WordTiming } from '@lesebuehne/core';
import type { SpeechPort, UtteranceRequest } from './speech-port.ts';

/** Prefix of server TTS voice URIs: `tts:<providerId>:<voiceId>`. */
export const TTS_VOICE_PREFIX = 'tts:';

export const isTtsVoice = (voiceURI: string | undefined): boolean => !!voiceURI?.startsWith(TTS_VOICE_PREFIX);

/** One synthesized utterance ready to play. */
export interface TtsClip {
  url: string;
  words: WordTiming[];
}

/** Where clips come from (the TTS buffer with cache and prefetch). */
export interface TtsSource {
  clip(text: string, lang: string, voice: string): Promise<TtsClip>;
}

/** The parts of `HTMLAudioElement` the port uses (a fake in tests). */
export interface AudioLike {
  src: string;
  playbackRate: number;
  preservesPitch: boolean;
  currentTime: number;
  volume?: number;
  play(): Promise<void>;
  pause(): void;
  onplaying: (() => void) | null;
  onended: (() => void) | null;
  onerror: (() => void) | null;
}

export interface Ticker {
  every(ms: number, fn: () => void): () => void;
}

export const realTicker: Ticker = {
  every(ms, fn) {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  },
};

/** How the current TTS utterance is doing (readiness indicator). */
export type AudioState = 'idle' | 'buffering' | 'playing' | 'failed';

/**
 * Speech port for server TTS voices (spec 004 B4): plays each utterance's WAV with pitch-preserving
 * tempo and emits word boundaries when `currentTime` passes each word's start, so the engine,
 * highlighting and cues work exactly as with Web Speech.
 */
export class AudioSpeechPort implements SpeechPort {
  private generation = 0;
  private audio: AudioLike | undefined;
  private stopPolling: (() => void) | undefined;
  private volume = 1;

  constructor(
    private readonly o: {
      source: () => TtsSource | undefined;
      createAudio: () => AudioLike;
      ticker?: Ticker;
      onState?: (s: AudioState, error?: string) => void;
    },
  ) {}

  speak(r: UtteranceRequest): void {
    this.stop();
    this.volume = r.volume ?? this.volume;
    const g = ++this.generation;
    const live = (): boolean => g === this.generation;
    const source = this.o.source();
    const voice = (r.voiceURI ?? '').slice(TTS_VOICE_PREFIX.length);
    if (!source || !voice) {
      queueMicrotask(() => live() && r.onError('no TTS source'));
      return;
    }
    this.o.onState?.('buffering');
    source.clip(r.text, r.lang, voice).then(
      (clip) => {
        if (!live()) return;
        const audio = this.o.createAudio();
        this.audio = audio;
        audio.preservesPitch = true;
        audio.src = clip.url;
        audio.playbackRate = r.rate;
        audio.volume = this.volume;
        const offset = r.startOffset ?? 0;
        // Timings use original text offsets. Never emit words before the requested position.
        let next = offset ? clip.words.findIndex((w) => w.end > offset) : 0;
        if (next < 0) next = clip.words.length;
        if (offset) audio.currentTime = clip.words[next]?.t0 ?? clip.words.at(-1)?.t1 ?? 0;
        let started = false;
        const emit = (until: number): void => {
          while (next < clip.words.length && clip.words[next]!.t0 <= until) r.onBoundary(clip.words[next++]!.start, 'word');
        };
        audio.onplaying = () => {
          if (!live() || started) return;
          started = true;
          this.o.onState?.('playing');
          r.onStart();
          emit(audio.currentTime + 0.02);
          this.stopPolling = (this.o.ticker ?? realTicker).every(40, () => live() && emit(audio.currentTime + 0.02));
        };
        audio.onended = () => {
          if (!live()) return;
          this.stopPolling?.();
          emit(Infinity);
          r.onEnd();
        };
        audio.onerror = () => {
          if (!live()) return;
          this.stopPolling?.();
          this.o.onState?.('failed', 'audio playback error');
          r.onError('audio');
        };
        audio.play().catch((e: unknown) => {
          if (!live()) return;
          this.o.onState?.('failed', e instanceof Error ? e.message : String(e));
          r.onError('play');
        });
      },
      (e: unknown) => {
        if (!live()) return;
        this.o.onState?.('failed', e instanceof Error ? e.message : String(e));
        r.onError('tts');
      },
    );
  }

  private stop(): void {
    this.stopPolling?.();
    this.stopPolling = undefined;
    const a = this.audio;
    this.audio = undefined;
    if (a) {
      a.onplaying = a.onended = a.onerror = null;
      a.pause();
    }
  }

  cancel(): void {
    this.generation++;
    this.stop();
    this.o.onState?.('idle');
  }

  /** Tempo change while playing: the engine restarts the utterance anyway; kept for completeness. */
  setRate(rate: number): void {
    if (this.audio) this.audio.playbackRate = rate;
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.audio) this.audio.volume = volume;
  }
}

/**
 * Routes utterances by voice: server TTS voices to the audio port, everything else to Web Speech.
 * A TTS utterance that fails is read by the best Web Speech voice instead, never skipped.
 */
export class RoutingSpeechPort implements SpeechPort {
  constructor(
    private readonly web: SpeechPort | undefined,
    private readonly audio: AudioSpeechPort,
    private readonly fallbackVoice: (lang: string) => string | undefined,
    private readonly onFallback: (error: string) => void = () => undefined,
  ) {}

  speak(r: UtteranceRequest): void {
    if (!isTtsVoice(r.voiceURI)) {
      this.audio.cancel();
      if (this.web) this.web.speak(r);
      else queueMicrotask(() => r.onError('no speech'));
      return;
    }
    this.web?.cancel();
    this.audio.speak({
      ...r,
      onError: (error) => {
        const voiceURI = this.fallbackVoice(r.lang);
        if (!this.web || !voiceURI) return r.onError(error);
        this.onFallback(error);
        const offset = r.startOffset ?? 0;
        this.web.speak({ ...r, voiceURI, text: r.text.slice(offset), onBoundary: (index, name) => r.onBoundary(index + offset, name) });
      },
    });
  }

  cancel(): void {
    this.audio.cancel();
    this.web?.cancel();
  }

  setVolume(volume: number): void {
    this.audio.setVolume(volume);
    this.web?.setVolume?.(volume);
  }
}
