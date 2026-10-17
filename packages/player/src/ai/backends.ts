import { MemoryCache, ProviderRegistry, type Book, type LLMProvider, type ProviderStats, type ResultCache, type VisualPlan } from '@lesebuehne/core';
import {
  DEFAULT_BUDGET,
  DirectorService,
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
import type { AiPrefs, BrowserProviderId } from './prefs.ts';

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
  usage?: ProviderStats | undefined;
}

export interface BackendStatus {
  chain: string[];
  providers: ProviderStatus[];
  budget: PlanBudget;
}

/** Where AI plans come from: the local server or providers in this browser (BYOK). */
export interface AiBackend {
  readonly mode: 'server' | 'browser';
  prepare(book: Book, opts: VariantOptions, signal: AbortSignal): Promise<StyleResponse>;
  plan(book: Book, sectionId: string, opts: PlanOptions, signal: AbortSignal): Promise<PlanResponse>;
  /** Animation program for an `animation` plan (throws when none could be written). */
  animate(book: Book, sectionId: string, plan: VisualPlan, opts: AnimateOptions, signal: AbortSignal): Promise<AnimationResponse>;
  status(): Promise<BackendStatus>;
  /** Starts an own sign-in on the server; returns the URL to open. */
  login?(providerId: string): Promise<string>;
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

  async login(providerId: string): Promise<string> {
    return (await this.post<{ url: string }>(`api/auth/${encodeURIComponent(providerId)}/login`, {})).url;
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

/** Providers in this browser (BYOK), same director service as the server. */
export class BrowserBackend implements AiBackend {
  readonly mode = 'browser' as const;
  readonly registry = new ProviderRegistry();
  private readonly service: DirectorService;
  private readonly chain: string[];

  constructor(providers: LLMProvider[], cache: ResultCache = new MemoryCache()) {
    for (const p of providers) this.registry.register(p);
    this.chain = providers.map((p) => p.id);
    this.service = new DirectorService({ complete: registryComplete(this.registry, this.chain), cache, chainId: `browser:${this.chain.join(',')}` });
  }

  prepare(book: Book, opts: VariantOptions, signal: AbortSignal): Promise<StyleResponse> {
    return this.service.prepare(book, opts, signal);
  }

  plan(book: Book, sectionId: string, opts: PlanOptions, signal: AbortSignal): Promise<PlanResponse> {
    return this.service.plan(book, sectionId, opts, signal);
  }

  animate(book: Book, sectionId: string, plan: VisualPlan, opts: AnimateOptions, signal: AbortSignal): Promise<AnimationResponse> {
    return this.service.animate(book, sectionId, plan, opts, signal);
  }

  async status(): Promise<BackendStatus> {
    const providers = await Promise.all(
      this.registry.list('llm').map(async (p) => {
        const a = await this.registry.available(p.id);
        return { id: p.id, label: p.label, available: a.ok, reason: a.reason ?? null, login: false, source: null, usage: this.registry.statsOf(p.id) };
      }),
    );
    return { chain: [...this.chain, 'heuristic'], providers, budget: DEFAULT_BUDGET };
  }
}

/**
 * Finds the AI backend (B8): the server on the same origin, then the configured server URL, then
 * BYOK providers in this browser; undefined = heuristic only. Never blocks reading.
 */
export async function detectBackend(o: { prefs: AiPrefs; http: Http; baseURI: string; cache?: () => ResultCache; timeoutMs?: number }): Promise<AiBackend | undefined> {
  if (o.prefs.mode === 'off') return undefined;
  const candidates = [new URL('/', o.baseURI).href, ...(o.prefs.serverUrl ? [o.prefs.serverUrl.replace(/\/?$/u, '/')] : [])];
  for (const base of [...new Set(candidates)]) {
    try {
      const res = await o.http(new URL('api/capabilities', base).href, { signal: AbortSignal.timeout(o.timeoutMs ?? 2500) });
      const body = (await res.json().catch(() => undefined)) as { server?: string } | undefined;
      if (res.ok && body?.server === 'lesebuehne') return new ServerBackend(base, o.http);
    } catch {
      /* no server here */
    }
  }
  const providers = browserProviders(o.prefs, o.http);
  return providers.length ? new BrowserBackend(providers, o.cache?.()) : undefined;
}
