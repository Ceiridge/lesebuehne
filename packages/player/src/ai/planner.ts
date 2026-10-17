import { JobQueue, type AnimationProgram, type Book, type Section, type StyleBible, type VisualPlan } from '@lesebuehne/core';
import { budgetAfter, DEFAULT_BUDGET, type PlanBudget, type PlanResponse } from '@lesebuehne/director';
import type { AiBackend } from './backends.ts';
import { aiStatus } from './state.ts';

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
  /** An animation program arrived for an animation plan. */
  applyAnimation(sectionId: string, program: AnimationProgram, info: { variants: number; selected: number }): void;
  now(): number;
}

/**
 * Brings LLM plans to the open book (B5, B6): Style Bible first, then the current section, then
 * the next sections up to five minutes of listening ahead, then the previous one. Jobs start after
 * a 1.5 s dwell, are aborted when a jump makes them unnecessary, and never block reading: the
 * heuristic plan stays until the LLM plan arrives.
 */
export class AiPlanner {
  private readonly queue = new JobQueue(2);
  private readonly info = new Map<string, PlanInfo>();
  private readonly failedAt = new Map<string, number>();
  private style?: Promise<StyleBible | undefined>;
  private lastSection: string | undefined;
  private since = 0;
  private scheduled = false;
  private budgetStart: PlanBudget = DEFAULT_BUDGET;
  private disposed = false;

  constructor(private readonly host: PlannerHost, private readonly backend: AiBackend) {
    void backend
      .status()
      .then((s) => (this.budgetStart = s.budget))
      .catch(() => undefined);
  }

  infoOf(sectionId: string): PlanInfo | undefined {
    return this.info.get(sectionId);
  }

  /** Called every frame (cheap). */
  tick(now = this.host.now()): void {
    if (this.disposed) return;
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
    this.style ??= this.track(
      this.queue.enqueue({ key: 'style', priority: -1, run: (signal) => this.backend.prepare(this.host.book, {}, signal) }),
    ).then(
      (r) => {
        this.host.applyStyle(r.styleBible);
        return r.styleBible;
      },
      (e: unknown) => {
        this.style = undefined; // try again with the next schedule
        if (!(e instanceof DOMException && e.name === 'AbortError')) this.note(undefined, e);
        return undefined;
      },
    );
    return this.style;
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
    return budgetAfter(earlier, this.budgetStart);
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

  private accept(sectionId: string, r: PlanResponse): void {
    this.note(r);
    if (r.fallback) {
      this.failedAt.set(sectionId, this.host.now());
      this.info.set(sectionId, { source: 'heuristic', variants: 0, selected: 0, ...(r.error ? { error: r.error } : {}) });
      return;
    }
    const info: PlanInfo = { source: 'ai', variants: r.variants, selected: r.selected, ...(r.plan.meta ? { providerId: r.plan.meta.providerId } : {}) };
    this.info.set(sectionId, info);
    this.host.applyPlan(sectionId, r.plan, info);
    if (r.plan.mode === 'animation' && r.plan.animation) void this.animateJob(sectionId, r.plan, 0.5);
  }

  private readonly repaired = new Set<string>();

  private animateJob(sectionId: string, plan: VisualPlan, priority: number, opts: { regenerate?: boolean; error?: string } = {}): Promise<void> {
    const key = `anim:${sectionId}${opts.regenerate || opts.error ? ':r' : ''}`;
    return this.track(this.queue.enqueue({ key, priority, run: (signal) => this.backend.animate(this.host.book, sectionId, plan, opts, signal) })).then(
      (r) => this.host.applyAnimation(sectionId, r.program, { variants: r.variants, selected: r.selected }),
      (e: unknown) => {
        if (!(e instanceof DOMException && e.name === 'AbortError')) this.note(undefined, e);
      },
    );
  }

  /**
   * The sandbox rejected or crashed the program: ask once per program for a corrected one (the
   * diagram stays meanwhile).
   */
  animationFailed(sectionId: string, codeKey: string, reason: string): void {
    const plan = this.host.planOf(sectionId);
    if (!plan || plan.mode !== 'animation' || this.repaired.has(codeKey)) return;
    this.repaired.add(codeKey);
    void this.animateJob(sectionId, plan, -1, { error: reason });
  }

  private planJob(sectionId: string, priority: number, opts: { regenerate?: boolean; select?: number } = {}): Promise<void> {
    const key = opts.regenerate ? `regen:${sectionId}` : opts.select !== undefined ? `select:${sectionId}` : `plan:${sectionId}`;
    return this.track(
      this.queue.enqueue({
        key,
        priority,
        run: async (signal) => {
          await this.ensureStyle();
          const previous = this.previousOf(sectionId);
          return this.backend.plan(this.host.book, sectionId, { ...(previous ? { previous } : {}), budget: this.budgetFor(sectionId), ...opts }, signal);
        },
      }),
    ).then(
      (r) => this.accept(sectionId, r),
      (e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        this.failedAt.set(sectionId, this.host.now());
        this.note(undefined, e);
      },
    );
  }

  /** Queue the window around `sectionId`; abort jobs outside it. */
  schedule(sectionId: string): void {
    const wanted = this.window(sectionId);
    const now = this.host.now();
    const keys = new Set([
      'style',
      'style-regen',
      ...wanted.flatMap((w) => [`plan:${w.id}`, `anim:${w.id}`, `anim:${w.id}:r`]),
      ...[...this.info.keys()].flatMap((id) => [`regen:${id}`, `select:${id}`]),
    ]);
    this.queue.retain(keys);
    void this.ensureStyle();
    for (const w of wanted) {
      if (this.info.get(w.id)?.source === 'ai') continue;
      const failed = this.failedAt.get(w.id);
      if (failed !== undefined && now - failed < RETRY_AFTER_MS) continue;
      void this.planJob(w.id, w.priority);
    }
  }

  /** R: a new variant for the section (old variants stay selectable); animations get a new program. */
  regenerate(sectionId: string): Promise<void> {
    this.failedAt.delete(sectionId);
    const current = this.host.planOf(sectionId);
    if (current?.mode === 'animation' && this.info.get(sectionId)?.source === 'ai') return this.animateJob(sectionId, current, -2, { regenerate: true });
    return this.planJob(sectionId, -2, { regenerate: true });
  }

  /** A new Style Bible variant; later plans use it (their cache keys include its version). */
  async regenerateStyle(): Promise<void> {
    try {
      const r = await this.track(this.queue.enqueue({ key: 'style-regen', priority: -3, run: (signal) => this.backend.prepare(this.host.book, { regenerate: true }, signal) }));
      this.style = Promise.resolve(r.styleBible);
      this.host.applyStyle(r.styleBible);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) this.note(undefined, e);
    }
  }

  /** Switch to the previous/next stored variant. */
  selectVariant(sectionId: string, delta: number): Promise<void> | undefined {
    const info = this.info.get(sectionId);
    if (!info || info.source !== 'ai' || info.variants < 2) return undefined;
    const select = (info.selected + delta + info.variants) % info.variants;
    return this.planJob(sectionId, -2, { select });
  }

  dispose(): void {
    this.disposed = true;
    this.queue.retain(new Set());
  }
}
