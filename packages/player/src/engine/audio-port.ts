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
  readonly paused?: boolean;
  readonly duration?: number;
  play(): Promise<void>;
  pause(): void;
  onplaying: (() => void) | null;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  /** Paused by someone else (media keys, headset, the OS); the port pauses only after clearing it. */
  onpause?: (() => void) | null;
}

/** No progress for this long while playing counts as a stall. */
export const STALL_MS = 2500;

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
  /** Waiting for generated audio: before playback starts, or a stream waiting for its clip. */
  private waiting = false;

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
    this.waiting = true;
    const fail = (e: unknown): void => {
      if (!live()) return;
      this.waiting = false;
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
    let finished: TtsClip | undefined;
    aligned?.then((c) => {
      finished = c;
      if (live() && c.words.length) words = c.words;
    }, () => undefined);
    let started = false;
    let ended = false;
    const now = this.o.now ?? (() => performance.now());
    const emit = (until: number): void => {
      while (next < words.length && words[next]!.t0 <= until) r.onBoundary(words[next++]!.start, 'word');
    };
    const end = (): void => {
      if (!live() || ended) return;
      ended = true;
      this.waiting = false;
      this.stopPolling?.();
      this.stopPolling = undefined;
      emit(Infinity);
      r.onEnd();
    };
    const fail = (error: string, message: string): void => {
      if (!live() || ended) return;
      ended = true;
      this.waiting = false;
      this.stopPolling?.();
      this.stopPolling = undefined;
      this.o.onState?.('failed', message);
      r.onError(error);
    };
    const play = (): void => {
      audio.play().catch((e: unknown) => fail('play', e instanceof Error ? e.message : String(e)));
    };
    // A stream that broke off continues from the finished clip at the same moment.
    let switched = false;
    const toClip = (c: TtsClip): void => {
      if (!live() || ended || switched) return;
      switched = true;
      const at = audio.currentTime;
      audio.src = c.url;
      audio.playbackRate = r.rate;
      audio.currentTime = at;
      play();
    };
    // Progress watch: an element can stop without `ended` (cut off at the end, a lost stream).
    let lastTime = -1;
    let lastMove = 0;
    let nudged = false;
    const watch = (): void => {
      if (!live() || ended) return;
      const t = audio.currentTime;
      emit(t + 0.02);
      if (t !== lastTime || audio.paused) {
        lastTime = t;
        lastMove = now();
        this.waiting = false;
        return;
      }
      if (now() - lastMove < STALL_MS) return;
      lastMove = now();
      const duration = audio.duration ?? NaN;
      if (Number.isFinite(duration) && t >= duration - 0.3) return end();
      if (this.streaming && !switched) {
        if (finished) toClip(finished);
        else this.waiting = true; // Still generating: the clip takes over once it is ready.
        return;
      }
      if (nudged) return fail('stall', 'audio playback stalled');
      nudged = true;
      audio.currentTime = t;
      play();
    };
    audio.onplaying = () => {
      if (!live() || started) return;
      started = true;
      this.waiting = false;
      this.o.onState?.('playing');
      r.onStart();
      emit(audio.currentTime + 0.02);
      this.stopPolling = (this.o.ticker ?? realTicker).every(40, watch);
    };
    audio.onended = () => {
      if (!this.streaming || switched || !aligned) return end();
      // A stream of unknown length also "ends" when its connection drops: when the finished clip
      // is longer, continue from it. At a regular end the clip arrives within moments.
      const at = audio.currentTime;
      const check = (c: TtsClip | undefined): void => {
        if ((c?.words.at(-1)?.t1 ?? 0) > at + 0.3) toClip(c!);
        else end();
      };
      if (finished) return check(finished);
      const timer = setTimeout(() => check(finished), 1500);
      aligned.then((c) => { clearTimeout(timer); check(c); }, () => { clearTimeout(timer); end(); });
    };
    audio.onerror = () => {
      if (!live() || ended) return;
      if (this.streaming && !switched && aligned) {
        aligned.then(toClip, () => fail('audio', 'audio playback error'));
        return;
      }
      fail('audio', 'audio playback error');
    };
    audio.onpause = () => {
      // Our own pauses clear the handlers first. At the end of the media `pause` comes right
      // before `ended`, so only a pause that stays without `ended` is an interruption.
      if (!live() || ended || !started) return;
      setTimeout(() => {
        if (live() && !ended && audio.paused !== false) r.onInterrupted?.();
      }, 300);
    };
    if (!stream || !audio.buffered) return play();
    // Streaming: start as soon as the rest will arrive before playback gets there. The rate comes
    // from how fast the element's buffer grows; a paused element stops loading after a few
    // seconds while the server keeps generating, so progress is extrapolated from that rate. On a
    // fast GPU this starts in under a second; on a slow one it avoids stalling mid-sentence. The
    // finished clip (aligned) always starts it.
    audio.preload = 'auto';
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
      a.onpause = null;
      a.pause();
      if (this.streaming) a.src = '';
    }
    this.streaming = false;
    this.waiting = false;
  }

  cancel(): void {
    this.generation++;
    this.stop();
    this.o.onState?.('idle');
  }

  busy(): boolean {
    return this.waiting;
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

  busy(): boolean {
    return this.audio.busy();
  }

  setVolume(volume: number): void {
    this.audio.setVolume(volume);
    this.web?.setVolume?.(volume);
  }
}
