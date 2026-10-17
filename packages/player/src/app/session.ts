import {
  animationCodeProblems,
  buildTimeline,
  contentHash,
  glossaryIndex,
  type AnimationProgram,
  primaryLanguage,
  type Book,
  type BookBundle,
  type GlossaryConcept,
  type Section,
  type StyleBible,
  type Timeline,
  type VisualPlan,
} from '@lesebuehne/core';
import { planSection, type ForcedMode } from '@lesebuehne/director';
import { resolveCueTimes, StageScheduler } from '@lesebuehne/renderers';
import { batch, computed, effect, signal } from '@preact/signals';
import { AiPlanner, type PlanInfo } from '../ai/planner.ts';
import type { AiBackend } from '../ai/backends.ts';
import { aiBackend, aiDetails, refreshDetails, ttsBuffer, ttsVoices } from '../ai/state.ts';
import { isTtsVoice, TTS_VOICE_PREFIX } from '../engine/audio-port.ts';
import { footnoteLookup, sentenceItems } from '../engine/queue.ts';
import { PlayerEngine, type Position } from '../engine/engine.ts';
import { selectVoice, type VoiceChoice, type VoiceInfo } from '../engine/voices.ts';
import { autoFollow, type FollowEvent, type FollowState } from '../nav/follow.ts';
import { headingAt } from '../nav/navigation.ts';
import type { Bookmark, VisualOverrides } from '../storage/repository.ts';
import type { LibraryService } from '../storage/library.ts';
import { DURATIONS } from '../theme/tokens.ts';
import type { AppEnv } from './env.ts';
import { settings } from './store.ts';

export type Panel = 'toc' | 'bookmarks' | 'settings' | 'help';

/** A section's animation program and how the sandbox is doing with it. */
export interface AnimationEntry {
  program: AnimationProgram;
  /** Identity of this program on stage (section + code hash). */
  key: string;
  status: 'loading' | 'running' | 'failed';
  reason?: string;
  /** Already restarted once after a timeout. */
  retried?: boolean;
  variants: number;
  selected: number;
}

export const VISUAL_CYCLE: readonly ForcedMode[] = ['auto', 'list', 'kinetic', 'text'];

export interface OpenOptions {
  /** false → open for this session only (not saved, B6). */
  saved: boolean;
  basicLanguage: boolean;
}

/** Everything about one open book: model, timeline, engine, plans, bookmarks, UI panels. */
export class ReaderSession {
  readonly book: Book;
  readonly timeline: Timeline;
  readonly engine: PlayerEngine;
  readonly stage: StageScheduler;
  readonly plans = signal<Map<string, VisualPlan>>(new Map());
  readonly overrides = signal<VisualOverrides>({});
  readonly bookmarks = signal<Bookmark[]>([]);
  readonly follow = signal<FollowState>('follow');
  readonly panel = signal<Panel | null>(null);
  readonly debug = signal(false);
  readonly popover = signal<{ footnoteId: string; x: number; y: number } | null>(null);
  readonly voices: VoiceInfo[];
  readonly voiceChoice = signal<VoiceChoice>({ mode: 'silent' });
  readonly saved: boolean;
  readonly basicLanguage: boolean;
  readonly sections = new Map<string, Section>();
  /** Sections in reading order. */
  readonly order: Section[] = [];
  /** Per-book Style Bible (LLM director), once prepared. */
  readonly styleBible = signal<StyleBible | undefined>(undefined);
  readonly glossary = computed<ReadonlyMap<string, GlossaryConcept>>(() => glossaryIndex(this.styleBible.value));
  /** Where each section's plan came from (AI variants, fallbacks). */
  readonly planInfo = signal<ReadonlyMap<string, PlanInfo>>(new Map());
  /** Generated illustrations by section (spec 005). */
  readonly images = signal<ReadonlyMap<string, { url: string; providerId: string; variants: number; selected: number }>>(new Map());
  /** Animation programs by section (spec 003). */
  readonly animations = signal<ReadonlyMap<string, AnimationEntry>>(new Map());
  /** LLM director, when an AI backend is available (B8). */
  ai: AiPlanner | undefined;
  private readonly aiPlans = new Map<string, VisualPlan>();
  /** Plan revision per section: a new plan gets a new stage key, so the stage crossfades to it. */
  private readonly planRev = new Map<string, number>();
  private readonly keyPlans = new Map<string, VisualPlan>();
  private readonly cueCache = new Map<string, { plan: VisualPlan; times: number[] }>();
  private readonly assetUrls = new Map<string, string>();

  private constructor(
    readonly bundle: BookBundle,
    readonly env: AppEnv,
    readonly library: LibraryService,
    o: OpenOptions & { voices: VoiceInfo[]; start: Position; overrides: VisualOverrides; bookmarks: Bookmark[] },
  ) {
    this.book = bundle.book;
    this.timeline = buildTimeline(this.book);
    this.saved = o.saved;
    this.basicLanguage = o.basicLanguage;
    this.voices = o.voices;
    for (const c of this.book.chapters) {
      for (const s of c.sections) {
        this.sections.set(s.id, s);
        this.order.push(s);
      }
    }
    const preferred = settings.value.voiceByLang[primaryLanguage(this.book.language)];
    const choice = env.speech ? selectVoice(o.voices, this.book.language, preferred) : ({ mode: 'silent' } as const);
    this.voiceChoice.value = choice;
    this.engine = new PlayerEngine({
      book: this.book,
      timeline: this.timeline,
      port: choice.mode === 'voice' ? env.speech?.port : undefined,
      voice: choice.mode === 'voice' ? choice.voice : undefined,
      tempo: settings.value.tempo,
      footnoteMode: settings.value.footnoteMode,
      timers: env.timers,
      start: o.start,
    });
    this.stage = new StageScheduler({ crossfadeMs: DURATIONS[settings.value.motion].slow });
    this.overrides.value = o.overrides;
    this.bookmarks.value = o.bookmarks;
    this.replanAll();
    this.attachAi(aiBackend.value);
    this.stopPrefetch = effect(() => this.prefetchTts(this.engine.position.value.entryIndex));
  }

  private readonly stopPrefetch: () => void;
  private lastPrefetch = -1;
  private footnotesCache: ReturnType<typeof footnoteLookup> | undefined;
  private get footnotes(): ReturnType<typeof footnoteLookup> {
    return (this.footnotesCache ??= footnoteLookup(this.book));
  }

  /**
   * Server TTS prefetch (spec 004 B4): the utterances of the next ~60 s of listening, in the
   * engine's chunking, so playback finds them ready; a jump replaces the window.
   */
  private prefetchTts(entryIndex: number): void {
    const voiceURI = this.engine?.currentVoice?.voiceURI;
    const buffer = ttsBuffer.value;
    if (!buffer || !isTtsVoice(voiceURI) || entryIndex === this.lastPrefetch) return;
    this.lastPrefetch = entryIndex;
    const voice = voiceURI!.slice(TTS_VOICE_PREFIX.length);
    const lang = this.book.language;
    const items: Array<{ text: string; lang: string; voice: string }> = [];
    let seconds = 0;
    const tempo = this.engine.currentTempo;
    for (let i = entryIndex; i < this.timeline.entries.length && seconds < 60 && items.length < 40; i++) {
      const entry = this.timeline.entries[i]!;
      const from = i === entryIndex ? this.engine.position.value.tokenIndex : 0;
      for (const item of sentenceItems(i, entry, from, settings.value.footnoteMode, this.footnotes, lang)) items.push({ text: item.text, lang, voice });
      seconds += (entry.end - entry.start) / tempo;
    }
    buffer.prefetch(items);
  }

  /** (Re)connects the LLM director, e.g. after the provider settings changed. */
  attachAi(backend: AiBackend | undefined): void {
    this.ai?.dispose();
    const env = this.env;
    this.ai = backend
      ? new AiPlanner(
          {
            book: this.book,
            order: this.order,
            currentSectionId: () => this.sectionIdAt(this.engine.position.value.entryIndex),
            planOf: (id) => this.plans.value.get(id),
            applyPlan: (id, plan, info) => this.setAiPlan(id, plan, info),
            applyStyle: (sb) => (this.styleBible.value = sb),
            applyAnimation: (id, program, info) => this.setAnimation(id, program, info),
            applyImage: (id, image) => (this.images.value = new Map(this.images.value).set(id, image)),
            now: () => env.timers.now(),
          },
          backend,
        )
      : undefined;
  }

  static async open(env: AppEnv, library: LibraryService, bundle: BookBundle, o: OpenOptions): Promise<ReaderSession> {
    // Server TTS voices (spec 004): wait briefly for the provider list, never block opening.
    if (aiBackend.value && !aiDetails.value) await Promise.race([refreshDetails(), new Promise((r) => setTimeout(r, 1500))]);
    const [webVoices, overrides, bookmarks] = await Promise.all([
      env.speech ? env.speech.voices().catch(() => []) : Promise.resolve([]),
      library.overrides(bundle.book.id),
      library.bookmarks(bundle.book.id),
    ]);
    const timeline = buildTimeline(bundle.book);
    const start = await library.loadPosition(bundle.book.id, timeline);
    const voices = env.speech ? [...ttsVoices(bundle.book.language), ...webVoices] : webVoices;
    return new ReaderSession(bundle, env, library, { ...o, voices, start, overrides, bookmarks });
  }

  /** The director plans every section on open (B9), honouring the per-book forced modes. */
  private replanAll(): void {
    const plans = new Map<string, VisualPlan>();
    for (const [id, section] of this.sections) plans.set(id, this.effectivePlan(id, section));
    this.plans.value = plans;
    this.cueCache.clear();
  }

  /** Forced mode → heuristic with that mode; auto → the AI plan if there is one, else the heuristic. */
  private effectivePlan(sectionId: string, section: Section): VisualPlan {
    const forced = this.overrides.value[sectionId] ?? 'auto';
    return (forced === 'auto' ? this.aiPlans.get(sectionId) : undefined) ?? planSection(section, this.book, forced);
  }

  private replan(sectionId: string): void {
    const section = this.sections.get(sectionId);
    if (!section) return;
    const plans = new Map(this.plans.value);
    plans.set(sectionId, this.effectivePlan(sectionId, section));
    this.plans.value = plans;
    const rev = (this.planRev.get(sectionId) ?? 0) + 1;
    this.planRev.set(sectionId, rev);
    this.keyPlans.delete(`${sectionId}@${rev - 2}`);
  }

  /** A plan from the LLM director replaces the section's plan (crossfade, dwell rule respected). */
  setAiPlan(sectionId: string, plan: VisualPlan, info: PlanInfo): void {
    this.aiPlans.set(sectionId, plan);
    this.planInfo.value = new Map(this.planInfo.value).set(sectionId, info);
    this.replan(sectionId);
  }

  /** A new program: checked here too (defence in depth) before it may run. */
  setAnimation(sectionId: string, program: AnimationProgram, info: { variants: number; selected: number }): void {
    const key = `${sectionId}#${contentHash(program.code).slice(0, 12)}`;
    const problems = animationCodeProblems(program.code);
    const entry: AnimationEntry = problems.length
      ? { program, key, status: 'failed', reason: problems.join('; '), ...info }
      : { program, key, status: 'loading', ...info };
    this.animations.value = new Map(this.animations.value).set(sectionId, entry);
    if (problems.length) this.ai?.animationFailed(sectionId, key, entry.reason!);
  }

  /** Status from the sandbox; a failure asks once for a corrected program. */
  animationStatus(key: string, status: { state: 'loading' | 'running' | 'failed'; reason?: string }): void {
    for (const [sectionId, e] of this.animations.value) {
      if (e.key !== key || e.status === status.state) continue;
      // A timeout is usually a slow start (cold page, busy tab), not a broken program: retry once
      // in a fresh frame (new key) before asking the LLM for a fix.
      if (status.state === 'failed' && /did not start|stopped responding/u.test(status.reason ?? '') && !e.retried) {
        this.animations.value = new Map(this.animations.value).set(sectionId, { ...e, key: `${e.key}~retry`, status: 'loading', retried: true });
        continue;
      }
      const next: AnimationEntry = { ...e, status: status.state, ...(status.reason ? { reason: status.reason } : {}) };
      this.animations.value = new Map(this.animations.value).set(sectionId, next);
      if (status.state === 'failed') this.ai?.animationFailed(sectionId, key, status.reason ?? 'failed');
    }
  }

  private readonly starts = new Map<string, number>();

  /** Book time (τ) where a section starts. */
  sectionStart(sectionId: string): number {
    let s = this.starts.get(sectionId);
    if (s === undefined) {
      s = this.timeline.entries.find((e) => e.sectionId === sectionId)?.start ?? 0;
      this.starts.set(sectionId, s);
    }
    return s;
  }

  /** Stage key of a section's current plan (`id` or `id@rev`). */
  stageKey(sectionId: string): string {
    const rev = this.planRev.get(sectionId);
    return rev ? `${sectionId}@${rev}` : sectionId;
  }

  /** Section of a stage key. */
  sectionOfKey(key: string): string {
    const at = key.lastIndexOf('@');
    return at > 0 && /^\d+$/u.test(key.slice(at + 1)) ? key.slice(0, at) : key;
  }

  private readonly titles = new Map<string, string>();

  /** The heading a section belongs to (stage context and title card), else the chapter title. */
  sectionTitle(sectionId: string): string {
    const cached = this.titles.get(sectionId);
    if (cached !== undefined) return cached;
    const entry = this.timeline.entries.find((e) => e.sectionId === sectionId);
    const title = entry ? headingAt(this.book, this.timeline, entry.start) || this.book.title : this.book.title;
    this.titles.set(sectionId, title);
    return title;
  }

  sectionIdAt(entryIndex: number): string | undefined {
    return this.timeline.entries[entryIndex]?.sectionId;
  }

  /**
   * Plan and cue times for a stage key or section id (cached until the plan changes). An older
   * stage key keeps its plan while it fades out.
   */
  visualFor(key: string): { plan: VisualPlan; times: number[] } | undefined {
    const sectionId = this.sectionOfKey(key);
    const current = key === this.stageKey(sectionId);
    const plan = current ? this.plans.value.get(sectionId) : (this.keyPlans.get(key) ?? this.plans.value.get(sectionId));
    if (!plan) return undefined;
    if (current) this.keyPlans.set(this.stageKey(sectionId), plan);
    const cached = this.cueCache.get(key);
    if (cached && cached.plan === plan) return cached;
    const entry = { plan, times: resolveCueTimes(plan, this.timeline) };
    this.cueCache.set(key, entry);
    return entry;
  }

  followEvent(e: FollowEvent): void {
    this.follow.value = autoFollow(this.follow.value, e);
  }

  /** User navigation: move the clock (restart speech if playing), switch the stage now (B8, B9). */
  navigate(p: Position): void {
    batch(() => {
      this.engine.seek(p);
      this.followEvent('navigate');
    });
    const section = this.sectionIdAt(this.engine.position.value.entryIndex);
    if (section) this.stage.navigate(this.stageKey(section), this.env.timers.now());
  }

  togglePlay(): void {
    if (!this.engine.playing.value) this.followEvent('play');
    this.engine.toggle();
  }

  forcedMode(sectionId: string): ForcedMode {
    return this.overrides.value[sectionId] ?? 'auto';
  }

  /** V: auto → list → kinetic → text → auto for the current section, remembered per book (B9). */
  cycleVisual(): ForcedMode | undefined {
    const sectionId = this.sectionIdAt(this.engine.position.value.entryIndex);
    const section = sectionId ? this.sections.get(sectionId) : undefined;
    if (!sectionId || !section) return undefined;
    const next = VISUAL_CYCLE[(VISUAL_CYCLE.indexOf(this.forcedMode(sectionId)) + 1) % VISUAL_CYCLE.length] ?? 'auto';
    const overrides = { ...this.overrides.value };
    if (next === 'auto') delete overrides[sectionId];
    else overrides[sectionId] = next;
    this.overrides.value = overrides;
    this.replan(sectionId);
    void this.library.setOverrides(this.book.id, overrides);
    this.stage.navigate(this.stageKey(sectionId), this.env.timers.now());
    return next;
  }

  bookmarkAt(entryIndex: number): Bookmark | undefined {
    const id = this.timeline.entries[entryIndex]?.sentence.id;
    return this.bookmarks.value.find((b) => b.sentenceId === id);
  }

  /** B: add or remove a bookmark at the current sentence. Returns true if one was added. */
  toggleBookmark(): boolean {
    const p = this.engine.position.value;
    const entry = this.timeline.entries[p.entryIndex];
    if (!entry) return false;
    const existing = this.bookmarkAt(p.entryIndex);
    const list = existing
      ? this.bookmarks.value.filter((b) => b !== existing)
      : [
          ...this.bookmarks.value,
          {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            sentenceId: entry.sentence.id,
            chapterId: entry.chapterId,
            excerpt: entry.sentence.text.length > 140 ? `${entry.sentence.text.slice(0, 140).trimEnd()} …` : entry.sentence.text,
            createdAt: new Date().toISOString(),
          },
        ];
    list.sort((a, b) => (this.timeline.indexOf.get(a.sentenceId) ?? 0) - (this.timeline.indexOf.get(b.sentenceId) ?? 0));
    this.bookmarks.value = list;
    void this.library.setBookmarks(this.book.id, list);
    return !existing;
  }

  removeBookmark(id: string): void {
    this.bookmarks.value = this.bookmarks.value.filter((b) => b.id !== id);
    void this.library.setBookmarks(this.book.id, this.bookmarks.value);
  }

  jumpToBookmark(b: Bookmark): void {
    const index = this.timeline.indexOf.get(b.sentenceId);
    if (index !== undefined) this.navigate({ entryIndex: index, tokenIndex: 0 });
    else {
      const k = this.timeline.entries.findIndex((e) => e.chapterId === b.chapterId);
      this.navigate({ entryIndex: Math.max(0, k), tokenIndex: 0 });
    }
  }

  setVoice(v: VoiceInfo): void {
    const lang = primaryLanguage(this.book.language);
    settings.value = { ...settings.value, voiceByLang: { ...settings.value.voiceByLang, [lang]: v.voiceURI } };
    this.voiceChoice.value = selectVoice(this.voices, this.book.language, v.voiceURI);
    this.engine.setVoice(v);
    this.lastPrefetch = -1;
    this.prefetchTts(this.engine.position.value.entryIndex);
  }

  savePosition(): Promise<void> {
    return this.library.savePosition(this.book.id, this.timeline, this.engine.position.value);
  }

  /** Object URL of an EPUB image asset (B3 figures). */
  assetUrl(path: string): string | undefined {
    const cached = this.assetUrls.get(path);
    if (cached) return cached;
    const asset = this.bundle.assets.find((a) => a.path === path);
    if (!asset || typeof URL.createObjectURL !== 'function') return undefined;
    const url = URL.createObjectURL(new Blob([asset.bytes as BlobPart], { type: asset.mediaType }));
    this.assetUrls.set(path, url);
    return url;
  }

  private disposed = false;

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPrefetch();
    this.ai?.dispose();
    void this.savePosition();
    this.engine.dispose();
    for (const url of this.assetUrls.values()) URL.revokeObjectURL?.(url);
    this.assetUrls.clear();
  }
}
