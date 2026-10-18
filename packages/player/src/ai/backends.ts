import { MemoryCache, ProviderRegistry, TaskGroup, type CacheScope, type CacheStats, type Book, type ImageProvider, type LLMProvider, type ProviderStats, type ResultCache, type TTSProvider, type TTSVoice, type VisualPlan, type WordTiming } from '@lesebuehne/core';
import {
  DEFAULT_BUDGET,
  DirectorService,
  ImageDirector,
  SpeechDirector,
  type MediaStore,
  type ImageOptions,
  registryComplete,
  type AnimateOptions,
  type AnimationResponse,
  type PlanBudget,
  type PlanOptions,
  type PlanResponse,
  type StyleResponse,
  type VariantOptions,
} from '@lesebuehne/director';
import { AnthropicCompatibleLLM } from '@lesebuehne/llm-anthropic-compatible';
import { OpenAICompatibleLLM } from '@lesebuehne/llm-openai-compatible';
import { OpenRouterLLM } from '@lesebuehne/llm-openrouter';
import { OpenAICompatibleImages, OpenRouterImages } from '@lesebuehne/image-openai-compatible';
import { OpenAICompatibleTTS, openaiTTS, qwentts } from '@lesebuehne/tts-openai-compatible';
import { MemoryMediaStore } from './idb-cache.ts';
import type { AiPrefs, BrowserProviderId } from './prefs.ts';
import { splitImageGrid } from './image-grid.ts';

export type Http = (url: string, init?: RequestInit) => Promise<Response>;

export interface ProviderStatus {
  id: string;
  label: string;
  available: boolean;
  reason: string | null;
  /** Own sign-in possible through the server. */
  login: boolean;
  /** codex-auth: which token source is in use. */
  source: string | null;
  kind?: string;
  /** TTS providers: their voices. */
  voices?: TTSVoice[];
  concurrency?: number;
  /** TTS providers on the server: audio can play while it is generated (`ttsStreamUrl`). */
  streaming?: boolean;
  usage?: ProviderStats | undefined;
}

export interface ImageResult {
  tiles?: Array<{ url: string }>;
  cached?: boolean;
  /** Absolute URL of the picture. */
  url: string;
  providerId: string;
  variants: number;
  selected: number;
}

export interface BackendStatus {
  chain: string[];
  providers: ProviderStatus[];
  budget: PlanBudget;
}

/** Where AI plans come from: the local server or providers in this browser (BYOK). */
export interface AiBackend {
  readonly mode: 'server' | 'browser';
  /** false: no text model (only voices or images); the heuristic plans stay. */
  readonly plans?: boolean;
  prepare(book: Book, opts: VariantOptions, signal: AbortSignal): Promise<StyleResponse>;
  plan(book: Book, sectionId: string, opts: PlanOptions, signal: AbortSignal): Promise<PlanResponse>;
  /** Animation program for an `animation` plan (throws when none could be written). */
  animate(book: Book, sectionId: string, plan: VisualPlan, opts: AnimateOptions, signal: AbortSignal): Promise<AnimationResponse>;
  status(): Promise<BackendStatus>;
  /** Server images (spec 005): an illustration for an `image` plan (slow: minutes). */
  image?(book: Book, sectionId: string, plan: VisualPlan, opts: ImageOptions, signal: AbortSignal): Promise<ImageResult>;
  /** Server TTS (spec 004): WAV audio and aligned word timings for one utterance. */
  tts?(text: string, lang: string, voice: string, signal: AbortSignal): Promise<{ audio: Blob; words: WordTiming[]; cached?: boolean }>;
  /** Server TTS: a URL an `<audio>` element plays while the utterance is still being generated. */
  ttsStreamUrl?(text: string, lang: string, voice: string): string;
  /** Starts an own sign-in on the server; returns the URL to open. */
  login?(providerId: string): Promise<string>;
  cacheStats?(): Promise<CacheStats>;
  clearCache?(scope: CacheScope): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function readJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new HttpError(res.status, body.error ?? 'error', body.message ?? body.error ?? `HTTP ${res.status}`);
  return body;
}

/** The local server (B7): books are uploaded once per session, then referenced by id. */
export class ServerBackend implements AiBackend {
  readonly mode = 'server' as const;
  private readonly uploaded = new Map<string, Promise<void>>();

  constructor(private readonly base: string, private readonly http: Http) {}

  private url(path: string): string {
    return new URL(path, this.base).href;
  }

  private post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.http(this.url(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    }).then((r) => readJson<T>(r));
  }

  private upload(book: Book, force = false): Promise<void> {
    if (force) this.uploaded.delete(book.id);
    let p = this.uploaded.get(book.id);
    if (!p) {
      p = this.http(this.url(`api/books/${encodeURIComponent(book.id)}`), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(book),
      }).then(async (r) => void (await readJson(r)));
      p.catch(() => this.uploaded.delete(book.id));
      this.uploaded.set(book.id, p);
    }
    return p;
  }

  /** Calls `fn`; on "unknown book" (server restarted, cache cleared) uploads again once. */
  private async withBook<T>(book: Book, fn: () => Promise<T>): Promise<T> {
    await this.upload(book);
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof HttpError && e.code === 'unknown-book')) throw e;
      await this.upload(book, true);
      return fn();
    }
  }

  prepare(book: Book, opts: VariantOptions, signal: AbortSignal): Promise<StyleResponse> {
    return this.withBook(book, () => this.post<StyleResponse>('api/llm/prepare', { bookId: book.id, ...opts }, signal));
  }

  plan(book: Book, sectionId: string, opts: PlanOptions, signal: AbortSignal): Promise<PlanResponse> {
    return this.withBook(book, () => this.post<PlanResponse>('api/llm/plan', { bookId: book.id, sectionId, ...opts }, signal));
  }

  animate(book: Book, sectionId: string, plan: VisualPlan, opts: AnimateOptions, signal: AbortSignal): Promise<AnimationResponse> {
    return this.withBook(book, () => this.post<AnimationResponse>('api/llm/animate', { bookId: book.id, sectionId, plan, ...opts }, signal));
  }

  async status(): Promise<BackendStatus> {
    const [caps, usage] = await Promise.all([
      this.http(this.url('api/capabilities')).then((r) => readJson<{ chains: { llm: string[] }; budget?: PlanBudget; providers: ProviderStatus[] }>(r)),
      this.http(this.url('api/usage'))
        .then((r) => readJson<{ providers: Record<string, ProviderStats> }>(r))
        .catch(() => ({ providers: {} as Record<string, ProviderStats> })),
    ]);
    return {
      chain: caps.chains.llm,
      budget: caps.budget ?? DEFAULT_BUDGET,
      providers: caps.providers.map((p) => ({ ...p, usage: usage.providers[p.id] })),
    };
  }

  async image(book: Book, sectionId: string, plan: VisualPlan, opts: ImageOptions, signal: AbortSignal): Promise<ImageResult> {
    const r = await this.withBook(book, () => this.post<ImageResult>('api/images', { bookId: book.id, sectionId, plan, ...opts }, signal));
    return { ...r, url: this.url(r.url), ...(r.tiles ? { tiles: r.tiles.map(tile => ({ url: this.url(tile.url) })) } : {}) };
  }

  async tts(text: string, lang: string, voice: string, signal: AbortSignal): Promise<{ audio: Blob; words: WordTiming[]; cached?: boolean }> {
    const res = await this.http(this.url('api/tts'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, lang, voice }),
      signal,
    });
    if (!res.ok) await readJson(res);
    const words = JSON.parse(decodeURIComponent(res.headers.get('x-lb-words') ?? '%5B%5D')) as WordTiming[];
    const cached = res.headers.get('x-lb-cached');
    return { audio: await res.blob(), words, ...(cached === 'true' || cached === 'false' ? { cached: cached === 'true' } : {}) };
  }

  ttsStreamUrl(text: string, lang: string, voice: string): string {
    return `${this.url('api/tts/stream')}?${new URLSearchParams({ text, lang, voice })}`;
  }

  async login(providerId: string): Promise<string> {
    return (await this.post<{ url: string }>(`api/auth/${encodeURIComponent(providerId)}/login`, {})).url;
  }

  cacheStats(): Promise<CacheStats> {
    return this.http(this.url('api/cache')).then((r) => readJson<CacheStats>(r));
  }
  async clearCache(scope: CacheScope): Promise<void> {
    await this.post('api/cache/clear', { scope });
  }
}

/** Builds the BYOK providers configured in this browser, in the user's order. */
export function browserProviders(prefs: AiPrefs, http: Http): LLMProvider[] {
  const make = (id: BrowserProviderId): LLMProvider | undefined => {
    const c = prefs.byok[id];
    if (!c.enabled || !c.model) return undefined;
    const fetch = (u: string, i?: RequestInit) => http(u, i);
    if (id === 'openrouter') return c.apiKey ? new OpenRouterLLM({ apiKey: c.apiKey, model: c.model, fetch }) : undefined;
    if (id === 'anthropic-compatible') {
      return c.apiKey ? new AnthropicCompatibleLLM({ apiKey: c.apiKey, model: c.model, browser: true, ...(c.baseURL ? { baseURL: c.baseURL } : {}), fetch }) : undefined;
    }
    return c.baseURL
      ? new OpenAICompatibleLLM({ id, baseURL: c.baseURL, model: c.model, runsIn: ['browser'], ...(c.apiKey ? { apiKey: c.apiKey } : {}), fetch })
      : undefined;
  };
  return prefs.order.map(make).filter((p): p is LLMProvider => !!p);
}

/** Image and voice providers configured in this browser (spec 006 B3). */
export interface BrowserMedia {
  image?: ImageProvider;
  tts?: TTSProvider;
}

export function browserMedia(prefs: AiPrefs, http: Http): BrowserMedia {
  const fetch = (u: string, i?: RequestInit) => http(u, i);
  const out: BrowserMedia = {};
  const im = prefs.images;
  if (im.provider === 'openrouter') {
    const key = im.apiKey || prefs.byok.openrouter.apiKey;
    if (key && im.model) out.image = new OpenRouterImages({ id: 'openrouter-images', apiKey: key, model: im.model, runsIn: ['browser'], fetch });
  } else if (im.provider === 'openai-compatible' && im.baseURL) {
    out.image = new OpenAICompatibleImages({
      id: 'browser-images',
      label: 'Images (this browser)',
      baseURL: im.baseURL,
      ...(im.apiKey ? { apiKey: im.apiKey, requiresKey: true } : {}),
      ...(im.model ? { model: im.model } : {}),
      runsIn: ['browser'],
      fetch,
    });
  }
  const v = prefs.voice;
  const voices = v.voices.split(',').map((x) => x.trim()).filter(Boolean);
  if (v.enabled) {
    if (v.preset === 'openai') {
      if (v.apiKey) out.tts = openaiTTS({ id: 'openai-tts', apiKey: v.apiKey, ...(v.model ? { model: v.model } : {}), ...(voices.length ? { voices } : {}), fetch });
    } else if (v.preset === 'qwentts') {
      if (voices.length) out.tts = qwentts({ id: 'qwentts', ...(v.baseURL ? { baseURL: v.baseURL } : {}), voices, concurrency: v.parallel, fetch });
    } else if (v.baseURL && voices.length) {
      out.tts = new OpenAICompatibleTTS({
        id: 'browser-tts',
        label: 'Voice (this browser)',
        baseURL: v.baseURL,
        voices: voices.map((id) => ({ id, name: id, languages: [] })),
        ...(v.apiKey ? { apiKey: v.apiKey, requiresKey: true } : {}),
        ...(v.model ? { model: v.model } : {}),
        concurrency: v.parallel,
        runsIn: ['browser'],
        fetch,
      });
    }
  }
  return out;
}

/** Providers in this browser (BYOK), same director service as the server. */
export class BrowserBackend implements AiBackend {
  readonly mode = 'browser' as const;
  readonly plans: boolean;
  readonly registry = new ProviderRegistry();
  readonly image?: AiBackend['image'];
  readonly tts?: AiBackend['tts'];
  private readonly service: DirectorService;
  private readonly chain: string[];
  /** Object URLs of stored pictures, one per file. */
  private readonly urls = new Map<string, string>();
  private readonly tasks = { stage: new TaskGroup(), speech: new TaskGroup() };
  private readonly store: MediaStore;

  constructor(
    providers: LLMProvider[],
    private readonly cache: ResultCache = new MemoryCache(),
    media: BrowserMedia & { store?: MediaStore; objectUrl?: (b: Blob) => string } = {},
  ) {
    for (const p of providers) this.registry.register(p);
    this.chain = providers.map((p) => p.id);
    this.plans = providers.length > 0;
    this.service = new DirectorService({ complete: registryComplete(this.registry, this.chain), cache, chainId: `browser:${this.chain.join(',')}`, imagesAvailable: !!media.image });
    const store = media.store ?? new MemoryMediaStore();
    this.store = store;
    const objectUrl = media.objectUrl ?? ((b: Blob) => URL.createObjectURL(b));
    if (media.image) {
      this.registry.register(media.image);
      const images = new ImageDirector({ registry: this.registry, chain: [media.image.id], cache, store, styleReference: true, styleBible: (b) => this.service.styleBible(b), splitGrid: splitImageGrid });
      this.image = (book, sectionId, plan, opts, signal) => this.tasks.stage.run(signal, async (s) => {
        const r = await images.generate(book, sectionId, plan, opts, s);
        const storedUrl = async (file: string, mime: string) => {
          let url = this.urls.get(file);
          if (!url) {
            const bytes = await store.get(file);
            if (!bytes) throw new Error('stored image missing');
            url = objectUrl(new Blob([bytes as BlobPart], { type: mime }));
            this.urls.set(file, url);
          }
          return url;
        };
        const url = await storedUrl(r.file, r.mime);
        const tiles = r.tiles ? await Promise.all(r.tiles.map(async tile => ({ url: await storedUrl(tile.file, tile.mime) }))) : undefined;
        return { url, providerId: r.providerId, variants: r.variants, selected: r.selected, cached: r.cached, ...(tiles ? { tiles } : {}) };
      });
    }
    if (media.tts) {
      this.registry.register(media.tts);
      const speech = new SpeechDirector(this.registry, store);
      this.tts = (text, lang, voice, signal) => this.tasks.speech.run(signal, async (s) => {
        const r = await speech.speak(text, lang, voice, s);
        return { audio: new Blob([r.audio as BlobPart], { type: 'audio/wav' }), words: r.words, cached: r.cached };
      });
    }
  }

  prepare(book: Book, opts: VariantOptions, signal: AbortSignal): Promise<StyleResponse> {
    return this.tasks.stage.run(signal, (s) => this.service.prepare(book, opts, s));
  }

  plan(book: Book, sectionId: string, opts: PlanOptions, signal: AbortSignal): Promise<PlanResponse> {
    return this.tasks.stage.run(signal, (s) => this.service.plan(book, sectionId, opts, s));
  }

  animate(book: Book, sectionId: string, plan: VisualPlan, opts: AnimateOptions, signal: AbortSignal): Promise<AnimationResponse> {
    return this.tasks.stage.run(signal, (s) => this.service.animate(book, sectionId, plan, opts, s));
  }

  async cacheStats(): Promise<CacheStats> {
    const [results, images, speech] = await Promise.all([this.cache.stats?.(), this.store.stats?.('img-'), this.store.stats?.('tts-')]);
    return {
      stage: { entries: (results?.entries ?? 0) + (images?.entries ?? 0), bytes: (results?.bytes ?? 0) + (images?.bytes ?? 0) },
      speech: speech ?? { entries: 0, bytes: 0 },
    };
  }

  async clearCache(scope: CacheScope): Promise<void> {
    if (!this.store.clear || (scope === 'stage' && !this.cache.clear)) throw new Error('cache maintenance unavailable');
    await this.tasks[scope].maintain(async () => {
      if (scope === 'stage') {
        await this.cache.clear!();
        await this.store.clear!('img-');
        for (const url of this.urls.values()) URL.revokeObjectURL(url);
        this.urls.clear();
      } else await this.store.clear!('tts-');
    });
  }

  async status(): Promise<BackendStatus> {
    const providers = await Promise.all(
      this.registry.list().map(async (p): Promise<ProviderStatus> => {
        const a = await this.registry.available(p.id);
        return {
          id: p.id,
          kind: p.kind,
          label: p.label,
          available: a.ok,
          reason: a.reason ?? null,
          login: false,
          source: null,
          usage: this.registry.statsOf(p.id),
          ...(p.kind === 'tts' ? { voices: [...p.voices], concurrency: p.limits?.concurrency ?? 2 } : {}),
        };
      }),
    );
    // No image provider here: the director plans no pictures.
    return { chain: [...this.chain, 'heuristic'], providers, budget: this.image ? DEFAULT_BUDGET : { ...DEFAULT_BUDGET, images: 0 } };
  }
}

/**
 * Finds the AI backend (B8): the server on the same origin, then the configured server URL, then
 * BYOK providers in this browser; undefined = heuristic only. Never blocks reading.
 */
export async function detectBackend(o: {
  prefs: AiPrefs;
  http: Http;
  baseURI: string;
  cache?: () => ResultCache;
  media?: () => MediaStore;
  timeoutMs?: number;
}): Promise<AiBackend | undefined> {
  if (o.prefs.mode === 'off') return undefined;
  // A hosted page (spec 006 B4) asks the configured local server first: its own origin has none.
  const own = new URL('/', o.baseURI).href;
  const configured = o.prefs.serverUrl ? [o.prefs.serverUrl.replace(/\/?$/u, '/')] : [];
  const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/)/u.test(own);
  for (const base of o.prefs.connection === 'browser' ? [] : [...new Set(local ? [own, ...configured] : [...configured, own])]) {
    try {
      const res = await o.http(new URL('api/capabilities', base).href, { signal: AbortSignal.timeout(o.timeoutMs ?? 2500) });
      const body = (await res.json().catch(() => undefined)) as { server?: string } | undefined;
      if (res.ok && body?.server === 'lesebuehne') return new ServerBackend(base, o.http);
    } catch {
      /* no server here */
    }
  }
  if (o.prefs.connection === 'server') return undefined;
  const providers = browserProviders(o.prefs, o.http);
  const media = browserMedia(o.prefs, o.http);
  if (!providers.length && !media.image && !media.tts) return undefined;
  return new BrowserBackend(providers, o.cache?.(), { ...media, ...(o.media ? { store: o.media() } : {}) });
}
