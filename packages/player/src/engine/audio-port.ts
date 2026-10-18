import { estimateWordTimings, type WordTiming } from '@lesebuehne/core';
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
  /** An utterance that is not ready yet but can play while it is generated: its stream URL and expected length. */
  live?(text: string, lang: string, voice: string): { url: string; seconds: number } | undefined;
}

/** The parts of `HTMLAudioElement` the port uses (a fake in tests). */
export interface AudioLike {
  src: string;
  playbackRate: number;
  preservesPitch: boolean;
  currentTime: number;
  volume?: number;
  preload?: string;
  /** Loaded time ranges (real media elements); without it a stream starts at once. */
  buffered?: { readonly length: number; end(index: number): number };
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
  /** The current audio reads a live stream (closed on stop so the connection does not linger). */
  private streaming = false;

  constructor(
    private readonly o: {
      source: () => TtsSource | undefined;
      createAudio: () => AudioLike;
      ticker?: Ticker;
      now?: () => number;
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
    const fail = (e: unknown): void => {
      if (!live()) return;
      this.o.onState?.('failed', e instanceof Error ? e.message : String(e));
      r.onError('tts');
    };
    // Not generated yet and the voice streams: play while the server is still generating, with
    // estimated word times until the aligned clip arrives. Resuming inside a chunk needs the clip.
    const stream = r.startOffset ? undefined : source.live?.(r.text, r.lang, voice);
    const clip = source.clip(r.text, r.lang, voice);
    if (stream) {
      clip.catch(() => undefined);
      this.play(r, live, { url: stream.url, words: estimateWordTimings(r.text, r.lang, stream.seconds) }, { aligned: clip, seconds: stream.seconds });
    } else clip.then((c) => live() && this.play(r, live, c), fail);
  }

  private play(r: UtteranceRequest, live: () => boolean, clip: TtsClip, stream?: { aligned: Promise<TtsClip>; seconds: number }): void {
    const aligned = stream?.aligned;
    const audio = this.o.createAudio();
    this.audio = audio;
    this.streaming = !!stream;
    audio.preservesPitch = true;
    audio.src = clip.url;
    audio.playbackRate = r.rate;
    audio.volume = this.volume;
    let words = clip.words;
    const offset = r.startOffset ?? 0;
    // Timings use original text offsets. Never emit words before the requested position.
    let next = offset ? words.findIndex((w) => w.end > offset) : 0;
    if (next < 0) next = words.length;
    if (offset) audio.currentTime = words[next]?.t0 ?? words.at(-1)?.t1 ?? 0;
    // Estimated and aligned timings list the same words, so the emitted prefix stays valid.
    aligned?.then((c) => {
      if (live() && c.words.length) words = c.words;
    }, () => undefined);
    let started = false;
    const emit = (until: number): void => {
      while (next < words.length && words[next]!.t0 <= until) r.onBoundary(words[next++]!.start, 'word');
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
    const play = (): void => {
      audio.play().catch((e: unknown) => {
        if (!live()) return;
        this.o.onState?.('failed', e instanceof Error ? e.message : String(e));
        r.onError('play');
      });
    };
    if (!stream || !audio.buffered) return play();
    // Streaming: start as soon as the rest will arrive before playback gets there. The rate comes
    // from how fast the element's buffer grows; a paused element stops loading after a few
    // seconds while the server keeps generating, so progress is extrapolated from that rate. On a
    // fast GPU this starts in under a second; on a slow one it avoids stalling mid-sentence. The
    // finished clip (aligned) always starts it.
    audio.preload = 'auto';
    const now = this.o.now ?? (() => performance.now());
    const t0 = now();
    let first: { t: number; loaded: number } | undefined;
    let last: { t: number; loaded: number } | undefined;
    let begun = false;
    const begin = (): void => {
      if (begun || !live()) return;
      begun = true;
      this.stopPolling?.();
      this.stopPolling = undefined;
      play();
    };
    aligned!.then(begin, begin);
    this.stopPolling = (this.o.ticker ?? realTicker).every(100, () => {
      const ranges = audio.buffered!;
      const loaded = ranges.length ? ranges.end(ranges.length - 1) : 0;
      const t = (now() - t0) / 1000;
      if (loaded <= 0 || t <= 0) return;
      if (!last || loaded > last.loaded) {
        last = { t, loaded };
        first ??= last;
      }
      // Growth between samples excludes the time to the first byte; until then, the overall average.
      const speed = last.t - first!.t >= 0.6 ? (last.loaded - first!.loaded) / (last.t - first!.t) : loaded / t;
      if (speed <= 0) return;
      const total = Math.max(stream.seconds, loaded);
      const generated = Math.min(total, last.loaded + speed * (t - last.t));
      if ((total - generated) / speed + 0.3 <= (total - 0) / Math.max(0.25, r.rate)) begin();
    });
  }

  private stop(): void {
    this.stopPolling?.();
    this.stopPolling = undefined;
    const a = this.audio;
    this.audio = undefined;
    if (a) {
      a.onplaying = a.onended = a.onerror = null;
      a.pause();
      if (this.streaming) a.src = '';
    }
    this.streaming = false;
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
