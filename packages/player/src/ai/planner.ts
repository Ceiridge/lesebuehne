import { JobQueue, type AnimationProgram, type Book, type Section, type StyleBible, type VisualPlan } from '@lesebuehne/core';
import { budgetAfter, DEFAULT_BUDGET, preferBudget, type ImageOptions, type PlanBudget, type PlanResponse, type VisualPreference } from '@lesebuehne/director';
import type { AiBackend } from './backends.ts';
import { aiStatus } from './state.ts';
import type { GenerationState } from './progress.ts';
import { signal } from '@preact/signals';
import { GenerationThroughput } from './throughput.ts';

interface StageMeasurement { start?: number; uncached: boolean; known: boolean }

/** A position must hold this long before generation starts (fast scrubbing costs nothing). */
export const PLAN_DWELL_MS = 1500;
/** Plans are prefetched this far ahead, in listening time at 1.0×. */
export const LOOKAHEAD_SECONDS = 300;
/** A section whose LLM plan fell back is not retried for this long. */
const RETRY_AFTER_MS = 120_000;

export interface PlanInfo {
  source: 'ai' | 'heuristic';
  variants: number;
  selected: number;
  providerId?: string;
  error?: string;
}

/** What the planner needs from the reader session. */
export interface PlannerHost {
  readonly book: Book;
  /** Sections in reading order. */
  readonly order: readonly Section[];
  /** Section under the playhead. */
  currentSectionId(): string | undefined;
  /** Effective plan of a section (for "previous section" context). */
  planOf(sectionId: string): VisualPlan | undefined;
  /** An AI plan arrived (or a variant was chosen). */
  applyPlan(sectionId: string, plan: VisualPlan, info: PlanInfo): void;
  applyStyle(sb: StyleBible): void;
  /** An illustration arrived for an image plan. */
  applyImage(sectionId: string, image: { url: string; providerId: string; variants: number; selected: number }): void;
  /** An animation program arrived for an animation plan. */
  applyAnimation(sectionId: string, program: AnimationProgram, info: { variants: number; selected: number }): void;
  now(): number;
  /** Visual preference for new plans (spec 007 B2). */
  prefer?(): VisualPreference | undefined;
  imageOptions?(): ImageOptions;
  generation?(sectionId: string, state: GenerationState): void;
}

/**
 * Brings LLM plans to the open book (B5, B6): Style Bible first, then the current section, then
 * the next sections up to five minutes of listening ahead, then the previous one. Jobs start after
 * a 1.5 s dwell, are aborted when a jump makes them unnecessary, and never block reading: the
 * heuristic plan stays until the LLM plan arrives.
 */
export class AiPlanner {
  /** Estimated reading seconds prepared per wall second, including plans and their media. */
  readonly generationSpeed = signal<number | undefined>(undefined);
  private readonly throughput = new GenerationThroughput();
  private readonly planQueue = new JobQueue(2);
  private readonly imageQueue = new JobQueue(4);
  private readonly info = new Map<string, PlanInfo>();
  private readonly failedAt = new Map<string, number>();
  private style?: Promise<StyleBible | undefined>;
  private preparedStyle?: StyleBible;
  private active = true;
  private lastSection: string | undefined;
  private since = 0;
  private scheduled = false;
  private budgetStart: PlanBudget = DEFAULT_BUDGET;
  private disposed = false;
  private readonly revisions = new Map<string, object>();
  private readonly generationStates = new Map<string, GenerationState>();

  private generation(sectionId: string, state: GenerationState): void {
    if (this.disposed) return;
    this.generationStates.set(sectionId, state);
    this.host.generation?.(sectionId, state);
  }

  private job<T extends { cached?: boolean }>(sectionId: string, key: string, priority: number, run: (signal: AbortSignal) => Promise<T>, accept: (value: T) => void | boolean, measurement: StageMeasurement = { uncached: false, known: true }, queue = this.planQueue): Promise<void> {
    if (!this.active || this.disposed) return Promise.resolve();
    const revision = {};
    this.revisions.set(sectionId, revision);
    this.generation(sectionId, 'queued');
    return this.track(queue.enqueue({ key, priority, run: async (signal) => {
      this.generation(sectionId, 'working');
      measurement.start ??= this.host.now();
      const result = await run(signal);
      signal.throwIfAborted();
      measurement.uncached ||= result.cached === false;
      measurement.known &&= result.cached !== undefined;
      return result;
    } })).then((value) => {
      if (this.disposed || this.revisions.get(sectionId) !== revision) return;
      this.generation(sectionId, 'ready');
      const complete = accept(value) !== false;
      if (complete && measurement.known && measurement.uncached && measurement.start !== undefined) {
        this.throughput.add(measurement.start, this.host.now(), this.host.order.find((s) => s.id === sectionId)?.duration ?? 0);
        this.generationSpeed.value = this.throughput.speed;
      }
    }, (e: unknown) => {
      if (this.disposed || this.revisions.get(sectionId) !== revision) return;
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      this.generation(sectionId, aborted ? 'idle' : 'error');
      if (!aborted) {
        this.failedAt.set(sectionId, this.host.now());
        this.note(undefined, e);
      }
    });
  }

  constructor(private readonly host: PlannerHost, private readonly backend: AiBackend) {
    void backend
      .status()
      .then((s) => (this.budgetStart = s.budget))
      .catch(() => undefined);
  }

  infoOf(sectionId: string): PlanInfo | undefined {
    return this.info.get(sectionId);
  }

  /** Apply live without cancelling requests or discarding finished media. */
  setImageConcurrency(value: number): void {
    this.imageQueue.setConcurrency(Math.min(4, Math.max(1, value)));
  }

  /** Stop hidden-stage work, retaining finished plans/media for the next visible view. */
  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    this.scheduled = false;
    this.lastSection = undefined;
    if (active) return;
    this.revisions.clear();
    this.planQueue.retain(new Set());
    this.imageQueue.retain(new Set());
    this.style = undefined;
    for (const [id, state] of this.generationStates) {
      if (state === 'queued' || state === 'working') this.generation(id, 'idle');
    }
  }

  /** Called every frame (cheap). */
  tick(now = this.host.now()): void {
    if (this.disposed || !this.active) return;
    const id = this.host.currentSectionId();
    if (id !== this.lastSection) {
      this.lastSection = id;
      this.since = now;
      this.scheduled = false;
      return;
    }
    if (id && !this.scheduled && now - this.since >= PLAN_DWELL_MS) {
      this.scheduled = true;
      this.schedule(id);
    }
  }

  private track<T>(p: Promise<T>): Promise<T> {
    aiStatus.value = { ...aiStatus.value, working: aiStatus.value.working + 1 };
    return p.finally(() => {
      aiStatus.value = { ...aiStatus.value, working: Math.max(0, aiStatus.value.working - 1) };
    });
  }

  private ensureStyle(): Promise<StyleBible | undefined> {
    if (this.preparedStyle) return Promise.resolve(this.preparedStyle);
    if (this.style) return this.style;
    const pending = this.track(
      this.planQueue.enqueue({ key: 'style', priority: -1, run: async (signal) => {
        const result = await this.backend.prepare(this.host.book, {}, signal);
        signal.throwIfAborted();
        return result;
      } }),
    ).then(
      (r) => {
        if (this.disposed || !this.active || this.style !== pending) return undefined;
        this.preparedStyle = r.styleBible;
        this.host.applyStyle(r.styleBible);
        return r.styleBible;
      },
      (e: unknown) => {
        if (this.disposed || this.style !== pending) return undefined;
        this.style = undefined; // try again with the next schedule
        if (!(e instanceof DOMException && e.name === 'AbortError')) this.note(undefined, e);
        return undefined;
      },
    );
    this.style = pending;
    return pending;
  }

  /** Sections wanted around `sectionId`, by priority. */
  window(sectionId: string): Array<{ id: string; priority: number }> {
    const order = this.host.order;
    const k = order.findIndex((s) => s.id === sectionId);
    if (k < 0) return [];
    const out = [{ id: sectionId, priority: 0 }];
    let ahead = 0;
    for (let i = k + 1; i < order.length && ahead < LOOKAHEAD_SECONDS; i++) {
      out.push({ id: order[i]!.id, priority: 1 + (i - k) });
      ahead += order[i]!.duration;
    }
    if (k > 0) out.push({ id: order[k - 1]!.id, priority: 1000 });
    return out;
  }

  private budgetFor(sectionId: string): PlanBudget {
    const chapter = this.host.book.chapters.find((c) => c.sections.some((s) => s.id === sectionId));
    const earlier: VisualPlan[] = [];
    for (const s of chapter?.sections ?? []) {
      if (s.id === sectionId) break;
      const plan = this.info.get(s.id)?.source === 'ai' ? this.host.planOf(s.id) : undefined;
      if (plan) earlier.push(plan);
    }
    return budgetAfter(earlier, preferBudget(this.budgetStart, this.host.prefer?.()));
  }

  private previousOf(sectionId: string): VisualPlan | undefined {
    const k = this.host.order.findIndex((s) => s.id === sectionId);
    return k > 0 ? this.host.planOf(this.host.order[k - 1]!.id) : undefined;
  }

  private note(r: PlanResponse | undefined, e?: unknown): void {
    const error = e ? (e instanceof Error ? e.message : String(e)) : r?.error;
    aiStatus.value = {
      ...aiStatus.value,
      limited: !!error,
      ...(error ? { lastError: error } : {}),
      ...(r && !r.fallback && r.plan.meta ? { lastProvider: r.plan.meta.providerId } : {}),
    };
  }

  private accept(sectionId: string, r: PlanResponse, measurement: StageMeasurement): boolean {
    this.note(r);
    if (r.fallback) {
      this.generation(sectionId, 'error');
      this.failedAt.set(sectionId, this.host.now());
      this.info.set(sectionId, { source: 'heuristic', variants: 0, selected: 0, ...(r.error ? { error: r.error } : {}) });
      return false;
    }
    const info: PlanInfo = { source: 'ai', variants: r.variants, selected: r.selected, ...(r.plan.meta ? { providerId: r.plan.meta.providerId } : {}) };
    this.info.set(sectionId, info);
    this.host.applyPlan(sectionId, r.plan, info);
    if (r.plan.mode === 'animation' && r.plan.animation) {
      void this.animateJob(sectionId, r.plan, 0.5, {}, measurement);
      return false;
    }
    if (r.plan.mode === 'image' && r.plan.image) {
      void this.imageJob(sectionId, r.plan, 0.6 + this.distance(sectionId), {}, measurement);
      return false;
    }
    return true;
  }

  /** Reading distance of a section from the current one (for job priorities). */
  private distance(sectionId: string): number {
    const order = this.host.order;
    const cur = order.findIndex((s) => s.id === this.host.currentSectionId());
    const k = order.findIndex((s) => s.id === sectionId);
    return cur < 0 || k < 0 ? 0 : Math.abs(k - cur);
  }

  private imageJob(sectionId: string, plan: VisualPlan, priority: number, opts: { regenerate?: boolean } = {}, measurement?: StageMeasurement): Promise<void> {
    const image = this.backend.image?.bind(this.backend);
    if (!image) { this.generation(sectionId, 'error'); return Promise.resolve(); }
    const key = `img:${sectionId}${opts.regenerate ? ':r' : ''}`;
    return this.job(sectionId, key, priority, (signal) => image(this.host.book, sectionId, plan, { ...this.host.imageOptions?.(), ...opts }, signal), (r) => this.host.applyImage(sectionId, r), measurement, this.imageQueue);
  }

  private readonly repaired = new Set<string>();

  private animateJob(sectionId: string, plan: VisualPlan, priority: number, opts: { regenerate?: boolean; error?: string } = {}, measurement?: StageMeasurement): Promise<void> {
    const key = `anim:${sectionId}${opts.regenerate || opts.error ? ':r' : ''}`;
    return this.job(sectionId, key, priority, (signal) => this.backend.animate(this.host.book, sectionId, plan, opts, signal),
      (r) => this.host.applyAnimation(sectionId, r.program, { variants: r.variants, selected: r.selected }), measurement);
  }

  /**
   * The sandbox rejected or crashed the program: ask once per program for a corrected one (the
   * diagram stays meanwhile).
   */
  animationFailed(sectionId: string, codeKey: string, reason: string): void {
    if (!this.active || this.disposed) return;
    const plan = this.host.planOf(sectionId);
    if (!plan || plan.mode !== 'animation' || this.repaired.has(codeKey)) return;
    this.repaired.add(codeKey);
    void this.animateJob(sectionId, plan, -1, { error: reason });
  }

  private planJob(sectionId: string, priority: number, opts: { regenerate?: boolean; select?: number } = {}): Promise<void> {
    const measurement: StageMeasurement = { uncached: false, known: true };
    const key = opts.regenerate ? `regen:${sectionId}` : opts.select !== undefined ? `select:${sectionId}` : `plan:${sectionId}`;
    return this.job(sectionId, key, priority, async (signal) => {
          await this.ensureStyle();
          signal.throwIfAborted();
          const previous = this.previousOf(sectionId);
          const prefer = this.host.prefer?.();
          return this.backend.plan(this.host.book, sectionId, { ...(previous ? { previous } : {}), budget: this.budgetFor(sectionId), ...(prefer ? { prefer } : {}), ...opts }, signal);
        }, (r) => this.accept(sectionId, r, measurement), measurement);
  }

  /** Queue the window around `sectionId`; abort jobs outside it. */
  schedule(sectionId: string): void {
    if (!this.active || this.disposed) return;
    const wanted = this.window(sectionId);
    const now = this.host.now();
    const keys = new Set([
      'style',
      'style-regen',
      ...wanted.flatMap((w) => [`plan:${w.id}`, `anim:${w.id}`, `anim:${w.id}:r`, `img:${w.id}`, `img:${w.id}:r`]),
      ...[...this.info.keys()].flatMap((id) => [`regen:${id}`, `select:${id}`]),
    ]);
    this.planQueue.retain(keys);
    this.imageQueue.retain(keys);
    for (const w of wanted) {
      this.imageQueue.prioritize(`img:${w.id}`, w.priority);
      this.planQueue.prioritize(`plan:${w.id}`, w.priority);
    }
    void this.ensureStyle();
    for (const w of wanted) {
      const failed = this.failedAt.get(w.id);
      if (failed !== undefined && now - failed < RETRY_AFTER_MS) continue;
      if (this.info.get(w.id)?.source === 'ai') {
        const state = this.generationStates.get(w.id);
        const plan = this.host.planOf(w.id);
        if (state === 'idle' || state === 'error') {
          if (plan?.mode === 'image' && plan.image) void this.imageJob(w.id, plan, w.priority);
          if (plan?.mode === 'animation' && plan.animation) void this.animateJob(w.id, plan, w.priority);
        }
        continue;
      }
      void this.planJob(w.id, w.priority);
    }
  }

  /** R: a new variant for the section (old variants stay selectable); animations get a new program. */
  regenerate(sectionId: string): Promise<void> {
    if (!this.active || this.disposed) return Promise.resolve();
    this.failedAt.delete(sectionId);
    const current = this.host.planOf(sectionId);
    if (current?.mode === 'animation' && this.info.get(sectionId)?.source === 'ai') return this.animateJob(sectionId, current, -2, { regenerate: true });
    if (current?.mode === 'image' && this.info.get(sectionId)?.source === 'ai' && this.backend.image) return this.imageJob(sectionId, current, -2, { regenerate: true });
    return this.planJob(sectionId, -2, { regenerate: true });
  }

  /** A new Style Bible variant; later plans use it (their cache keys include its version). */
  async regenerateStyle(): Promise<void> {
    if (!this.active || this.disposed) return;
    try {
      const r = await this.track(this.planQueue.enqueue({ key: 'style-regen', priority: -3, run: async (signal) => {
        const result = await this.backend.prepare(this.host.book, { regenerate: true }, signal);
        signal.throwIfAborted();
        return result;
      } }));
      if (!this.active || this.disposed) return;
      this.preparedStyle = r.styleBible;
      this.style = Promise.resolve(r.styleBible);
      this.host.applyStyle(r.styleBible);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) this.note(undefined, e);
    }
  }

  /** Switch to the previous/next stored variant. */
  selectVariant(sectionId: string, delta: number): Promise<void> | undefined {
    if (!this.active || this.disposed) return;
    const info = this.info.get(sectionId);
    if (!info || info.source !== 'ai' || info.variants < 2) return undefined;
    const select = (info.selected + delta + info.variants) % info.variants;
    return this.planJob(sectionId, -2, { select });
  }

  dispose(): void {
    this.disposed = true;
    this.planQueue.retain(new Set());
    this.imageQueue.retain(new Set());
  }
}
