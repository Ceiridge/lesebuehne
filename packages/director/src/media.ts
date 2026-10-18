/**
 * Images and speech shared by the server and the browser (spec 005 B2, spec 004 B3, spec 006 B3):
 * provider chain through the registry, variants, style reference and alignment. Where the bytes
 * live is the caller's: disk on the server, IndexedDB in the browser.
 */
import {
  addVariant,
  ALIGNER_VERSION,
  alignWords,
  cacheKey,
  contentHash,
  decodeWav,
  pcm16ToWav,
  selectedValue,
  styleBibleVersion,
  type Book,
  type CacheEntry,
  type ImageProvider,
  type ImageQuality,
  type ProviderRegistry,
  type ResultCache,
  type StyleBible,
  type TTSProvider,
  type VisualPlan,
  type WordTiming,
  type CacheUsage,
} from '@lesebuehne/core';

/** Stored bytes by name (`<key>-<n>.png`, `<key>.wav` …). */
export interface MediaStore {
  get(name: string): Promise<Uint8Array | undefined>;
  put(name: string, bytes: Uint8Array): Promise<void>;
  stats?(prefix: string): Promise<CacheUsage>;
  clear?(prefix: string): Promise<void>;
}

/** One image variant: the stored file name and its type. */
export interface ImageVariant {
  file: string;
  mime: string;
  tiles?: Array<{ file: string; mime: string }>;
}

export interface ImageOutcome {
  file: string;
  mime: string;
  providerId: string;
  cached: boolean;
  variants: number;
  selected: number;
  tiles?: Array<{ file: string; mime: string }>;
}

export const IMAGE_SIZES: Readonly<Record<string, string>> = { '16:9': '1536x1024', '3:2': '1536x1024', '4:3': '1536x1024', '1:1': '1024x1024' };

export interface ImageOptions {
  regenerate?: boolean;
  select?: number;
  quality?: ImageQuality;
  resolution?: 'standard' | 'compact' | 'square';
  styleReference?: boolean;
  /** Four independent prompts in reading order: top-left, top-right, bottom-left, bottom-right. */
  panels?: string[];
}

export type SplitImageGrid = (image: Uint8Array, mime: string) => Promise<Array<{ image: Uint8Array; mime: string }>>;

/** The full prompt: the director's scene in the book's illustration style, without lettering. */
export function imagePrompt(plan: VisualPlan, sb: StyleBible | undefined): string {
  return [plan.image?.prompt ?? '', sb ? `Style: ${sb.illustrationStyle}` : '', 'No text, no letters, no captions, no watermarks.'].filter(Boolean).join('\n\n');
}

const extension = (mime: string): string => (mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png');

/** Images for `image` plans: variants, and the book's first image as style reference for the rest. */
export class ImageDirector {
  private readonly inflight = new Map<string, { promise: Promise<CacheEntry<ImageVariant>>; signal: AbortSignal }>();

  constructor(
    private readonly o: {
      registry: ProviderRegistry;
      chain: string[];
      cache: ResultCache;
      store: MediaStore;
      styleReference: boolean;
      styleBible: (book: Book) => Promise<StyleBible | undefined>;
      splitGrid?: SplitImageGrid;
      log?: (line: string) => void;
    },
  ) {}

  private refKey = (book: Book): string => cacheKey('imgref', { book: book.id });

  private async styleRef(book: Book): Promise<Uint8Array | undefined> {
    if (!this.o.styleReference) return undefined;
    const ref = selectedValue(await this.o.cache.get<ImageVariant>(this.refKey(book)));
    return ref ? this.o.store.get(ref.file) : undefined;
  }

  async generate(book: Book, sectionId: string, plan: VisualPlan, opts: ImageOptions, signal: AbortSignal): Promise<ImageOutcome> {
    if (plan.mode !== 'image' || !plan.image) throw new Error('plan has no image');
    if (this.o.chain.length === 0) throw new Error('no image provider');
    if (opts.panels && (opts.panels.length !== 4 || !this.o.splitGrid)) throw new Error('2x2 images need four prompts and an image cropper');
    const sb = await this.o.styleBible(book);
    const key = cacheKey('img', { book: book.id, section: sectionId, spec: contentHash(JSON.stringify(plan.image)), style: styleBibleVersion(sb), chain: this.o.chain.join(','),
      ...(opts.quality ? { quality: opts.quality } : {}), ...(opts.styleReference === false ? { reference: 'off' } : {}),
      ...(opts.resolution && opts.resolution !== 'standard' ? { resolution: opts.resolution } : {}),
      ...(opts.panels ? { grid: contentHash(JSON.stringify(opts.panels)), crop: '2x2-v1' } : {}) });
    let entry = await this.o.cache.get<ImageVariant>(key);
    if (entry && opts.select !== undefined && opts.select < entry.variants.length) {
      entry = { ...entry, selected: opts.select };
      await this.o.cache.put(key, entry);
    }
    const outcome = (e: CacheEntry<ImageVariant>, cached: boolean): ImageOutcome => ({
      ...selectedValue(e)!,
      providerId: e.variants[e.selected]?.providerId ?? '?',
      cached,
      variants: e.variants.length,
      selected: e.selected,
    });
    if (entry && !opts.regenerate) return outcome(entry, true);
    const flight = `${key}:${opts.regenerate ? 'r' : ''}`;
    const existing = this.inflight.get(flight);
    let p = existing && !existing.signal.aborted ? existing.promise : undefined;
    if (!p) {
      p = (async () => {
        const styleRef = opts.styleReference === false ? undefined : await this.styleRef(book);
        const size = opts.resolution === 'square' ? '1024x1024'
          : opts.resolution === 'compact' ? (plan.image!.aspect === '1:1' ? '832x832' : '1024x688')
          : IMAGE_SIZES[plan.image!.aspect] ?? '1536x1024';
        const prompt = opts.panels
          ? ['Create one contact sheet of exactly FOUR independent illustrations in an exact 2 by 2 grid. Each panel fills one equal quadrant. No gutters, no borders, no text, no labels. Keep each scene entirely inside its own quadrant. Do not merge scenes.',
            ...opts.panels.map((text, i) => `${['TOP LEFT', 'TOP RIGHT', 'BOTTOM LEFT', 'BOTTOM RIGHT'][i]}: ${text.slice(0, 300)}`),
            sb ? `Shared illustration style: ${sb.illustrationStyle.slice(0, 250)}` : ''].join('\n\n')
          : imagePrompt(plan, sb);
        const r = await this.o.registry.run(
          'image',
          this.o.chain,
          (provider: ImageProvider, s) => provider.generate({ prompt, size, ...(opts.quality ? { quality: opts.quality } : {}), ...(styleRef ? { styleRef } : {}), signal: s }),
          signal,
        );
        signal.throwIfAborted();
        const crops = opts.panels ? await this.o.splitGrid!(r.value.image, r.value.mime) : undefined;
        signal.throwIfAborted();
        if (crops && crops.length !== 4) throw new Error('image cropper returned an incomplete 2x2 grid');
        const before = await this.o.cache.get<ImageVariant>(key);
        // URLs are immutable. A cache clear must not reuse a browser-cached image URL.
        const file = `${key}-${before?.variants.length ?? 0}-${crypto.randomUUID().slice(0, 8)}.${extension(r.value.mime)}`;
        await this.o.store.put(file, r.value.image);
        const tiles = crops ? await Promise.all(crops.map(async (crop, i) => {
          const tileFile = `${file.slice(0, file.lastIndexOf('.'))}-tile${i}.${extension(crop.mime)}`;
          await this.o.store.put(tileFile, crop.image);
          return { file: tileFile, mime: crop.mime };
        })) : undefined;
        const next = addVariant(before, { file, mime: r.value.mime, ...(tiles ? { tiles } : {}) }, r.providerId, r.value.model);
        await this.o.cache.put(key, next);
        // The first image of a book sets its visual style for the following ones.
        if (!(await this.o.cache.get(this.refKey(book)))) await this.o.cache.put(this.refKey(book), addVariant(undefined, tiles?.[0] ?? { file, mime: r.value.mime }, r.providerId));
        this.o.log?.(`image ${sectionId} ← ${r.providerId} (${Math.round(r.value.image.byteLength / 1024)} KB${styleRef ? ', style ref' : ''})`);
        return next;
      })().finally(() => { if (this.inflight.get(flight)?.promise === p) this.inflight.delete(flight); });
      this.inflight.set(flight, { promise: p, signal });
    }
    return outcome(await p, false);
  }
}

export interface SpeechOutcome {
  audio: Uint8Array;
  words: WordTiming[];
  providerId: string;
  cached: boolean;
}

/**
 * A clip that is still being generated: its PCM chunks so far, readable from the first byte by any
 * number of listeners while more arrive.
 */
export class LiveSpeech {
  readonly chunks: Uint8Array[] = [];
  private waiting: Array<() => void> = [];
  private state: 'live' | 'done' | 'failed' = 'live';
  private error: unknown;

  constructor(readonly sampleRate: number) {}

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.wake();
  }

  end(error?: unknown): void {
    if (this.state !== 'live') return;
    this.state = error === undefined ? 'done' : 'failed';
    this.error = error;
    this.wake();
  }

  private wake(): void {
    const w = this.waiting;
    this.waiting = [];
    for (const f of w) f();
  }

  /** Every chunk from the start; ends with the clip, or early when `signal` aborts. */
  async *read(signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    let i = 0;
    for (;;) {
      while (i < this.chunks.length) yield this.chunks[i++]!;
      if (this.state === 'done' || signal?.aborted) return;
      if (this.state === 'failed') throw this.error;
      await new Promise<void>((resolve) => {
        const go = (): void => {
          signal?.removeEventListener('abort', go);
          resolve();
        };
        this.waiting.push(go);
        signal?.addEventListener('abort', go, { once: true });
      });
    }
  }
}

/** Aborts a shared job only when every caller that joined it has given up. */
class SharedAbort {
  private readonly ctrl = new AbortController();
  private callers = 0;
  readonly signal = this.ctrl.signal;

  join(signal: AbortSignal): void {
    if (signal.aborted) return;
    this.callers++;
    signal.addEventListener('abort', () => {
      if (--this.callers <= 0) this.ctrl.abort();
    }, { once: true });
  }
}

interface SpeechFlight {
  promise: Promise<SpeechOutcome>;
  /** Resolves with the live clip once audio streams, or `undefined` when it never will. */
  live: Promise<LiveSpeech | undefined>;
  shared: SharedAbort;
}

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
};

/** Settles with `p`, or rejects as soon as this caller's `signal` aborts (the job itself goes on). */
function until<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/**
 * Speech for `<providerId>:<voiceId>` voices: synthesis through the registry (gate, cooldown,
 * stats), alignment with the energy aligner, audio and timings cached under one key. With
 * `stream`, providers that can stream deliver PCM while it is generated; `stream()` hands that
 * live clip to a player, and the finished clip is aligned and cached as usual. Callers of the same
 * utterance share one synthesis, which stops only when all of them have aborted.
 */
export class SpeechDirector {
  private readonly inflight = new Map<string, SpeechFlight>();

  constructor(private readonly registry: ProviderRegistry, private readonly store: MediaStore, private readonly o: { stream?: boolean } = {}) {}

  private async read(key: string, text: string, lang: string): Promise<Omit<SpeechOutcome, 'cached'> | undefined> {
    const [audio, meta] = await Promise.all([this.store.get(`${key}.wav`), this.store.get(`${key}.json`)]);
    if (!audio || !meta) return undefined;
    let m: { words: WordTiming[]; providerId: string; aligner?: string };
    try {
      m = JSON.parse(new TextDecoder().decode(meta)) as typeof m;
    } catch {
      return undefined;
    }
    // Timings from an older aligner (no version: the first one) are recomputed from the audio.
    if ((m.aligner ?? 'energy-1') !== ALIGNER_VERSION) {
      try {
        m = { ...m, words: alignWords(decodeWav(audio), text, lang), aligner: ALIGNER_VERSION };
        await this.store.put(`${key}.json`, new TextEncoder().encode(JSON.stringify(m))).catch(() => undefined);
      } catch {
        // Undecodable audio keeps its old timings.
      }
    }
    return { audio, words: m.words, providerId: m.providerId };
  }

  private resolve(text: string, lang: string, voice: string): { key: string; providerId: string; voiceId: string } {
    const sep = voice.indexOf(':');
    const providerId = voice.slice(0, sep);
    const voiceId = voice.slice(sep + 1);
    if (sep <= 0 || !voiceId || !this.registry.get(providerId, 'tts')) throw new Error(`unknown voice ${voice}`);
    // The audio key keeps the first aligner's name, so a new aligner reuses the audio.
    return { key: cacheKey('tts', { provider: providerId, voice: voiceId, lang, text: contentHash(text), aligner: 'energy-1' }), providerId, voiceId };
  }

  private flight(key: string, providerId: string, voiceId: string, text: string, lang: string, signal: AbortSignal): SpeechFlight {
    const known = this.inflight.get(key);
    if (known && !known.shared.signal.aborted) {
      known.shared.join(signal);
      return known;
    }
    const shared = new SharedAbort();
    shared.join(signal);
    let announce!: (live: LiveSpeech | undefined) => void;
    const live = new Promise<LiveSpeech | undefined>((r) => (announce = r));
    const stream = this.o.stream;
    const promise = (async () => {
      const r = await this.registry.run('tts', [providerId], async (provider: TTSProvider, s) => {
        if (!stream || !provider.synthesizeStream) return provider.synthesize({ text, lang, voice: voiceId, signal: s });
        const st = await provider.synthesizeStream({ text, lang, voice: voiceId, signal: s });
        const clip = new LiveSpeech(st.sampleRate);
        announce(clip);
        try {
          for await (const chunk of st.chunks) clip.push(chunk);
        } catch (e) {
          clip.end(e);
          throw e;
        }
        clip.end();
        return { audio: pcm16ToWav(concat(clip.chunks), st.sampleRate), mime: 'audio/wav' };
      }, shared.signal);
      const words = r.value.words ?? alignWords(decodeWav(r.value.audio), text, lang);
      // Timings first: a clip without them is never read back.
      await this.store.put(`${key}.json`, new TextEncoder().encode(JSON.stringify({ words, providerId: r.providerId, aligner: ALIGNER_VERSION })));
      await this.store.put(`${key}.wav`, r.value.audio);
      return { audio: r.value.audio, words, providerId: r.providerId, cached: false };
    })().finally(() => {
      announce(undefined);
      if (this.inflight.get(key)?.promise === promise) this.inflight.delete(key);
    });
    promise.catch(() => undefined);
    const f: SpeechFlight = { promise, live, shared };
    this.inflight.set(key, f);
    return f;
  }

  async speak(text: string, lang: string, voice: string, signal: AbortSignal): Promise<SpeechOutcome> {
    const { key, providerId, voiceId } = this.resolve(text, lang, voice);
    const hit = await this.read(key, text, lang);
    if (hit) return { ...hit, cached: true };
    return until(this.flight(key, providerId, voiceId, text, lang, signal).promise, signal);
  }

  /**
   * For playback while generating: the cached or finished clip, or the live clip as soon as its
   * first audio streams. Joins a running synthesis of the same utterance instead of starting one.
   */
  async stream(text: string, lang: string, voice: string, signal: AbortSignal): Promise<{ done: SpeechOutcome } | { live: LiveSpeech; finished: Promise<SpeechOutcome> }> {
    const { key, providerId, voiceId } = this.resolve(text, lang, voice);
    const hit = await this.read(key, text, lang);
    if (hit) return { done: { ...hit, cached: true } };
    const f = this.flight(key, providerId, voiceId, text, lang, signal);
    const live = await until(f.live, signal);
    if (live) return { live, finished: f.promise };
    return { done: await until(f.promise, signal) };
  }
}
