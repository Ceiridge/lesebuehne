import { addVariant, selectedValue, type AnimationProgram, type Book, type CacheEntry, type ProviderRegistry, type ResultCache, type StyleBible, type VisualPlan } from '@lesebuehne/core';
import { animateSection, animationCacheKey } from './animate.ts';
import { planSection } from '../heuristic.ts';
import { DEFAULT_BUDGET, planCacheKey, planSectionLLM, prepareBook, styleCacheKey, type Complete, type PlanBudget } from './director.ts';

/** Sections with fewer words (outside headings) keep the heuristic plan. */
export const MIN_WORDS_FOR_LLM = 12;

export interface VariantInfo {
  /** Number of stored variants (0 for a heuristic fallback). */
  variants: number;
  selected: number;
  cached: boolean;
}

export interface StyleResponse extends VariantInfo {
  styleBible: StyleBible;
}

export interface PlanResponse extends VariantInfo {
  plan: VisualPlan;
  /** true: the chain failed and this is the heuristic plan (not cached). */
  fallback: boolean;
  error?: string;
}

export interface VariantOptions {
  /** Generate a new variant even if one is cached. */
  regenerate?: boolean;
  /** Switch to a stored variant. */
  select?: number;
}

export interface AnimationResponse extends VariantInfo {
  program: AnimationProgram;
}

export interface AnimateOptions extends VariantOptions {
  /** Runtime error of the selected variant: generate a corrected one. */
  error?: string;
}

export interface PlanOptions extends VariantOptions {
  previous?: VisualPlan;
  budget?: PlanBudget;
}

export type DirectorEvent =
  | { job: 'style' | 'plan' | 'animate'; state: 'start' | 'done' | 'error'; key: string; sectionId?: string; providerId?: string; fallback?: boolean };

/**
 * Style Bible and section plans with cache, variants and the heuristic fallback (B5, B6). The
 * same service runs on the server (disk cache) and in the browser (IndexedDB cache, BYOK chain).
 */
export class DirectorService {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly o: {
      complete: (task: 'plan' | 'style' | 'animate') => Complete;
      cache: ResultCache;
      /** Identifies the provider chain in cache keys. */
      chainId: string;
      budget?: PlanBudget;
      onEvent?: (e: DirectorEvent) => void;
      log?: (line: string) => void;
    },
  ) {}

  private once<T>(key: string, run: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const p = run().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async variant<V>(key: string, select: number | undefined): Promise<CacheEntry<V> | undefined> {
    let entry = await this.o.cache.get<V>(key);
    if (entry && select !== undefined && select >= 0 && select < entry.variants.length && select !== entry.selected) {
      entry = { ...entry, selected: select };
      await this.o.cache.put(key, entry);
    }
    return entry;
  }

  async styleBible(book: Book): Promise<StyleBible | undefined> {
    return selectedValue(await this.o.cache.get<StyleBible>(styleCacheKey(book)));
  }

  /** Style Bible of the book; throws when no provider could make one. */
  async prepare(book: Book, opts: VariantOptions, signal: AbortSignal): Promise<StyleResponse> {
    const key = styleCacheKey(book);
    const entry = await this.variant<StyleBible>(key, opts.select);
    if (entry && !opts.regenerate) return { styleBible: selectedValue(entry)!, cached: true, variants: entry.variants.length, selected: entry.selected };
    const fresh = await this.once(`${key}:${opts.regenerate ? 'r' : ''}`, async () => {
      this.o.onEvent?.({ job: 'style', state: 'start', key });
      try {
        const sb = await prepareBook(book, this.o.complete('style'), signal);
        const next = addVariant(await this.o.cache.get<StyleBible>(key), sb, sb.meta?.providerId ?? '?', sb.meta?.model);
        await this.o.cache.put(key, next);
        this.o.onEvent?.({ job: 'style', state: 'done', key, ...(sb.meta ? { providerId: sb.meta.providerId } : {}) });
        this.o.log?.(`style ${book.id} ← ${sb.meta?.providerId}${sb.meta?.model ? `/${sb.meta.model}` : ''} (${sb.glossary.length} concepts)`);
        return next;
      } catch (e) {
        this.o.onEvent?.({ job: 'style', state: 'error', key });
        throw e;
      }
    });
    return { styleBible: selectedValue(fresh)!, cached: false, variants: fresh.variants.length, selected: fresh.selected };
  }

  /**
   * Animation program for a section's `animation` plan; throws when no provider could write a valid
   * one (the stage keeps the diagram). With `error`, a corrected variant is generated.
   */
  async animate(book: Book, sectionId: string, plan: VisualPlan, opts: AnimateOptions, signal: AbortSignal): Promise<AnimationResponse> {
    const section = book.chapters.flatMap((c) => c.sections).find((x) => x.id === sectionId);
    if (!section) throw new Error(`unknown section ${sectionId}`);
    if (plan.mode !== 'animation' || !plan.animation) throw new Error('plan has no animation');
    const styleBible = await this.styleBible(book);
    const key = animationCacheKey(section, book, plan, styleBible, this.o.chainId);
    const entry = await this.variant<AnimationProgram>(key, opts.select);
    const fresh = !!opts.regenerate || !!opts.error;
    if (entry && !fresh) return { program: selectedValue(entry)!, cached: true, variants: entry.variants.length, selected: entry.selected };
    const next = await this.once(`${key}:${fresh ? 'r' : ''}`, async () => {
      this.o.onEvent?.({ job: 'animate', state: 'start', key, sectionId });
      try {
        const program = await animateSection(
          section,
          book,
          plan,
          { ...(styleBible ? { styleBible } : {}), ...(opts.error ? { error: opts.error } : {}) },
          this.o.complete('animate'),
          signal,
        );
        const e = addVariant(await this.o.cache.get<AnimationProgram>(key), program, program.meta?.providerId ?? '?', program.meta?.model);
        await this.o.cache.put(key, e);
        this.o.onEvent?.({ job: 'animate', state: 'done', key, sectionId, ...(program.meta ? { providerId: program.meta.providerId } : {}) });
        this.o.log?.(`animate ${sectionId} ← ${program.meta?.providerId} (${program.code.length} chars)`);
        return e;
      } catch (err) {
        this.o.onEvent?.({ job: 'animate', state: 'error', key, sectionId });
        throw err;
      }
    });
    return { program: selectedValue(next)!, cached: false, variants: next.variants.length, selected: next.selected };
  }

  /** LLM plan of a section, or the heuristic plan when the chain is exhausted. Aborts rethrow. */
  async plan(book: Book, sectionId: string, opts: PlanOptions, signal: AbortSignal): Promise<PlanResponse> {
    const section = book.chapters.flatMap((c) => c.sections).find((s) => s.id === sectionId);
    if (!section) throw new Error(`unknown section ${sectionId}`);
    // Headings alone and very short sections need no LLM: the heuristic plan (title card) is final.
    const words = section.paragraphs
      .filter((p) => p.kind !== 'heading' && p.kind !== 'figure' && p.kind !== 'footnote')
      .reduce((n, p) => n + p.sentences.reduce((m, s) => m + s.tokens.filter((t) => t.wordLike).length, 0), 0);
    if (words < MIN_WORDS_FOR_LLM) return { plan: planSection(section, book), cached: true, fallback: false, variants: 0, selected: 0 };
    const styleBible = await this.styleBible(book);
    const key = planCacheKey(section, book, styleBible, this.o.chainId);
    const entry = await this.variant<VisualPlan>(key, opts.select);
    if (entry && !opts.regenerate) return { plan: selectedValue(entry)!, cached: true, fallback: false, variants: entry.variants.length, selected: entry.selected };
    const budget = opts.budget ?? this.o.budget ?? DEFAULT_BUDGET;
    try {
      const fresh = await this.once(`${key}:${opts.regenerate ? 'r' : ''}`, async () => {
        this.o.onEvent?.({ job: 'plan', state: 'start', key, sectionId });
        const p = await planSectionLLM(
          section,
          book,
          { ...(styleBible ? { styleBible } : {}), ...(opts.previous ? { previous: opts.previous } : {}), budget },
          this.o.complete('plan'),
          signal,
        );
        const next = addVariant(await this.o.cache.get<VisualPlan>(key), p, p.meta?.providerId ?? '?', p.meta?.model);
        await this.o.cache.put(key, next);
        this.o.onEvent?.({ job: 'plan', state: 'done', key, sectionId, ...(p.meta ? { providerId: p.meta.providerId } : {}) });
        this.o.log?.(`plan ${sectionId} ← ${p.meta?.providerId} ${p.mode}${p.meta?.dropped ? ` (dropped ${p.meta.dropped.length})` : ''}`);
        return next;
      });
      return { plan: selectedValue(fresh)!, cached: false, fallback: false, variants: fresh.variants.length, selected: fresh.selected };
    } catch (e) {
      if (signal.aborted) throw e;
      const message = e instanceof Error ? e.message : String(e);
      this.o.onEvent?.({ job: 'plan', state: 'error', key, sectionId, fallback: true });
      this.o.log?.(`plan ${sectionId} → heuristic (${message.slice(0, 160)})`);
      return { plan: planSection(section, book), cached: false, fallback: true, error: message, variants: 0, selected: 0 };
    }
  }
}

/** `Complete` over a provider chain: the first available provider answers; usage is recorded. */
export function registryComplete(
  registry: ProviderRegistry,
  chain: readonly string[],
  taskModel: (providerId: string, task: 'plan' | 'style' | 'animate') => string | undefined = () => undefined,
): (task: 'plan' | 'style' | 'animate') => Complete {
  return (task) => async (req) => {
    const r = await registry.run(
      'llm',
      chain,
      async (p, signal) => {
        const model = taskModel(p.id, task);
        const res = await p.completeJSON({ ...req, signal, ...(model ? { model } : {}) });
        registry.addUsage(p.id, res.usage);
        return res;
      },
      req.signal,
    );
    return { value: r.value.value, model: r.value.model, providerId: r.providerId };
  };
}
