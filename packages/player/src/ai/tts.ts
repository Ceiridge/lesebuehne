import { estimateSeconds, JobQueue, type QueueSnapshot, type WordTiming } from '@lesebuehne/core';
import { signal } from '@preact/signals';
import type { AudioState, TtsClip, TtsSource } from '../engine/audio-port.ts';
import type { GenerationState } from './progress.ts';
import { GenerationThroughput } from './throughput.ts';
import { recordActivity } from './activity.ts';

/** Synthesizes one utterance (the server's `/api/tts`). */
export type Synthesize = (text: string, lang: string, voice: string, signal: AbortSignal) => Promise<{ audio: Blob; words: WordTiming[]; cached?: boolean }>;

/** A URL that plays an utterance while it is generated (the server's `/api/tts/stream`), if the voice streams. */
export type StreamUrl = (text: string, lang: string, voice: string) => string | undefined;

/** Readiness of server TTS (spec 004 B4): shown next to the controls. */
export interface TtsStatus {
  state: AudioState;
  /** Utterances ready ahead of the current one. */
  ahead: number;
  /** Contiguous audio seconds ready after the current clip, at 1×. */
  aheadSeconds?: number;
  /** Audio seconds generated per wall second, combining overlapping requests; excludes cache hits. */
  generationSpeed?: number;
  /** Estimated timeline seconds per actual audio second for the selected voice. */
  contentSpeed?: number;
  /** The last utterance fell back to a browser voice. */
  limited: boolean;
  lastError?: string;
}

export const ttsStatus = signal<TtsStatus>({ state: 'idle', ahead: 0, limited: false });

const keyOf = (text: string, lang: string, voice: string): string => `${voice}\u0001${lang}\u0001${text}`;

/**
 * Clip cache with prefetch (spec 004 B4): object URLs in an LRU, synthesis through a job queue
 * (current utterance first, then by distance); `prefetch` with a new window cancels the rest.
 */
export class TtsBuffer implements TtsSource {
  readonly generation = signal<ReadonlyMap<string, GenerationState>>(new Map());

  stateOf(text: string, lang: string, voice: string): GenerationState {
    return this.generation.value.get(keyOf(text, lang, voice)) ?? 'idle';
  }

  private setState(key: string, state: GenerationState): void {
    if (this.disposed) return;
    const next = new Map(this.generation.peek());
    if (state === 'idle') next.delete(key);
    else next.set(key, state);
    this.generation.value = next;
  }
  private readonly clips = new Map<string, Promise<TtsClip>>();
  private readonly ready = new Set<string>();
  private readonly seconds = new Map<string, number>();
  private readonly samples = new Map<string, GenerationThroughput>();
  private readonly cadence = new Map<string, Array<{ content: number; audio: number }>>();
  private voice = '';
  private readonly cancelled = new Set<string>();
  // Up to four utterances in flight: a batching server (qwentts `--max-batch`) uses them; the
  // provider gate on the other side keeps any limit lower than that.
  private readonly queue = new JobQueue(4);
  private window: string[] = [];
  private disposed = false;

  constructor(
    private readonly synthesize: Synthesize,
    private readonly maxEntries = 300,
    private readonly urls: { create(b: Blob): string; revoke(u: string): void } = { create: (b) => URL.createObjectURL(b), revoke: (u) => URL.revokeObjectURL(u) },
    private readonly now: () => number = () => performance.now(),
    private readonly stream?: StreamUrl,
  ) {}

  private load(key: string, text: string, lang: string, voice: string, priority: number): Promise<TtsClip> {
    const known = this.cancelled.has(key) ? undefined : this.clips.get(key);
    if (known) {
      // Touch for the LRU; raise priority if it is still queued.
      this.clips.delete(key);
      this.clips.set(key, known);
      this.queue.prioritize(key, priority);
      return known;
    }
    this.setState(key, 'queued');
    this.cancelled.delete(key);
    const p = this.queue
      .enqueue({ key, priority, run: async (signal) => {
        this.setState(key, 'working');
        const start = this.now();
        const result = await this.synthesize(text, lang, voice, signal);
        signal.throwIfAborted();
        const duration = result.words.at(-1)?.t1 ?? 0;
        if (duration > 0) {
          const samples = this.cadence.get(voice) ?? [];
          samples.push({ content: estimateSeconds(text, lang), audio: duration });
          this.cadence.set(voice, samples.slice(-24));
        }
        recordActivity({ kind: 'speech', outcome: result.cached === true ? 'cached' : 'new', ms: this.now() - start, label: text, audioSeconds: duration });
        if (result.cached === false && duration > 0) {
          const samples = this.samples.get(voice) ?? new GenerationThroughput();
          samples.add(start, this.now(), duration);
          this.samples.set(voice, samples);
        }
        return result;
      } })
      .then((r) => {
        if (this.disposed) throw new DOMException('disposed', 'AbortError');
        const url = this.urls.create(r.audio);
        if (this.clips.get(key) === p) {
          this.ready.add(key);
          this.seconds.set(key, r.words.at(-1)?.t1 ?? Math.max(1, text.length / 14));
          this.setState(key, 'ready');
        }
        this.update();
        return { url, words: r.words };
      });
    p.catch((e: unknown) => {
      if (this.clips.get(key) === p) {
        this.clips.delete(key);
        this.cancelled.delete(key);
        this.ready.delete(key);
        const aborted = e instanceof DOMException && e.name === 'AbortError';
        if (!aborted) recordActivity({ kind: 'speech', outcome: 'failed', ms: 0, label: text });
        this.setState(key, aborted ? 'idle' : 'error');
        this.update();
      }
    });
    this.clips.set(key, p);
    this.evict();
    return p;
  }

  private evict(): void {
    while (this.clips.size > this.maxEntries) {
      const [oldest, p] = this.clips.entries().next().value as [string, Promise<TtsClip>];
      this.clips.delete(oldest);
      this.ready.delete(oldest);
      this.seconds.delete(oldest);
      this.setState(oldest, 'idle');
      void p.then((c) => this.urls.revoke(c.url)).catch(() => undefined);
    }
  }

  private update(): void {
    const ahead = this.window.slice(1).findIndex((k) => !this.ready.has(k));
    const count = ahead < 0 ? Math.max(0, this.window.length - 1) : ahead;
    const aheadSeconds = this.window.slice(1, count + 1).reduce((sum, key) => sum + (this.seconds.get(key) ?? 0), 0);
    const speed = this.samples.get(this.voice)?.speed;
    const cadence = this.cadence.get(this.voice) ?? [];
    const contentSpeed = cadence.length >= 4 ? cadence.reduce((n, s) => n + s.content, 0) / cadence.reduce((n, s) => n + s.audio, 0) : undefined;
    ttsStatus.value = { ...ttsStatus.peek(), ahead: count, aheadSeconds, generationSpeed: speed, contentSpeed };
  }

  clip(text: string, lang: string, voice: string): Promise<TtsClip> {
    if (this.disposed) return Promise.reject(new DOMException('disposed', 'AbortError'));
    return this.load(keyOf(text, lang, voice), text, lang, voice, -1);
  }

  /**
   * For an utterance that is not ready yet: a stream URL to start playing at once, and the expected
   * audio length for provisional word timings (from this voice's recent clips).
   */
  live(text: string, lang: string, voice: string): { url: string; seconds: number } | undefined {
    if (this.disposed || !this.stream || this.ready.has(keyOf(text, lang, voice))) return undefined;
    const url = this.stream(text, lang, voice);
    if (!url) return undefined;
    const cadence = this.cadence.get(voice) ?? [];
    const speed = cadence.length ? cadence.reduce((n, s) => n + s.content, 0) / cadence.reduce((n, s) => n + s.audio, 0) : 1;
    return { url, seconds: estimateSeconds(text, lang) / (speed > 0 ? speed : 1) };
  }

  /** The synthesis queue, with the spoken text as each job's label. */
  queueSnapshot(): QueueSnapshot {
    const s = this.queue.snapshot();
    const text = (key: string): string => key.split('')[2] ?? key;
    return { ...s, running: s.running.map(text), queued: s.queued.map(text) };
  }

  setConcurrency(value: number): void {
    this.queue.setConcurrency(value);
  }

  dispose(): void {
    this.disposed = true;
    this.queue.retain(new Set());
    for (const p of this.clips.values()) void p.then((c) => this.urls.revoke(c.url)).catch(() => undefined);
    this.clips.clear();
    this.ready.clear();
    this.seconds.clear();
    this.samples.clear();
    this.cadence.clear();
    this.cancelled.clear();
    this.generation.value = new Map();
    this.window = [];
    this.update();
  }

  /** The utterances from the current one onwards (in reading order). */
  prefetch(items: ReadonlyArray<{ text: string; lang: string; voice: string }>): void {
    if (this.disposed) return;
    this.window = items.map((i) => keyOf(i.text, i.lang, i.voice));
    this.voice = items[0]?.voice ?? '';
    const wanted = new Set(this.window);
    for (const key of this.clips.keys()) {
      if (!wanted.has(key) && this.queue.has(key)) this.cancelled.add(key);
    }
    this.queue.retain(wanted);
    const seen = new Set<string>();
    items.forEach((i, k) => {
      const key = this.window[k]!;
      if (seen.has(key)) return;
      seen.add(key);
      void this.load(key, i.text, i.lang, i.voice, k).catch(() => undefined);
    });
    this.update();
  }
}
