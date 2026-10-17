import { JobQueue, type WordTiming } from '@lesebuehne/core';
import { signal } from '@preact/signals';
import type { AudioState, TtsClip, TtsSource } from '../engine/audio-port.ts';

/** Synthesizes one utterance (the server's `/api/tts`). */
export type Synthesize = (text: string, lang: string, voice: string, signal: AbortSignal) => Promise<{ audio: Blob; words: WordTiming[] }>;

/** Readiness of server TTS (spec 004 B4): shown next to the controls. */
export interface TtsStatus {
  state: AudioState;
  /** Utterances ready ahead of the current one. */
  ahead: number;
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
  private readonly clips = new Map<string, Promise<TtsClip>>();
  private readonly ready = new Set<string>();
  private readonly queue = new JobQueue(2);
  private window: string[] = [];

  constructor(
    private readonly synthesize: Synthesize,
    private readonly maxEntries = 300,
    private readonly urls: { create(b: Blob): string; revoke(u: string): void } = { create: (b) => URL.createObjectURL(b), revoke: (u) => URL.revokeObjectURL(u) },
  ) {}

  private load(key: string, text: string, lang: string, voice: string, priority: number): Promise<TtsClip> {
    const known = this.clips.get(key);
    if (known) {
      // Touch for the LRU; raise priority if it is still queued.
      this.clips.delete(key);
      this.clips.set(key, known);
      if (this.queue.has(key)) void this.queue.enqueue({ key, priority, run: () => known });
      return known;
    }
    const p = this.queue
      .enqueue({ key, priority, run: (signal) => this.synthesize(text, lang, voice, signal) })
      .then((r) => {
        this.ready.add(key);
        this.update();
        return { url: this.urls.create(r.audio), words: r.words };
      });
    p.catch(() => {
      this.clips.delete(key);
      this.ready.delete(key);
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
      void p.then((c) => this.urls.revoke(c.url)).catch(() => undefined);
    }
  }

  private update(): void {
    const ahead = this.window.slice(1).findIndex((k) => !this.ready.has(k));
    ttsStatus.value = { ...ttsStatus.value, ahead: ahead < 0 ? Math.max(0, this.window.length - 1) : ahead };
  }

  clip(text: string, lang: string, voice: string): Promise<TtsClip> {
    return this.load(keyOf(text, lang, voice), text, lang, voice, -1);
  }

  /** The utterances from the current one onwards (in reading order). */
  prefetch(items: ReadonlyArray<{ text: string; lang: string; voice: string }>): void {
    this.window = items.map((i) => keyOf(i.text, i.lang, i.voice));
    this.queue.retain(new Set(this.window));
    items.forEach((i, k) => void this.load(this.window[k]!, i.text, i.lang, i.voice, k).catch(() => undefined));
    this.update();
  }
}
