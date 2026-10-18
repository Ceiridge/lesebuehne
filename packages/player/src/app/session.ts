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
  type CacheScope,
} from '@lesebuehne/core';
import { planSection, type ForcedMode } from '@lesebuehne/director';
import { resolveCueTimes, StageScheduler } from '@lesebuehne/renderers';
import { batch, computed, effect, signal } from '@preact/signals';
import { AiPlanner, type PlanInfo } from '../ai/planner.ts';
import { ImageSequencePlanner } from '../ai/image-sequence.ts';
import type { AiBackend } from '../ai/backends.ts';
import { aiBackend, aiDetails, createTtsBuffer, refreshDetails, ttsBuffer, ttsVoices } from '../ai/state.ts';
import type { TtsBuffer } from '../ai/tts.ts';
import { mergeRanges, type GenerationRange, type GenerationState } from '../ai/progress.ts';
import { isTtsVoice, TTS_VOICE_PREFIX } from '../engine/audio-port.ts';
import { footnoteLookup, sectionEndItems, sentenceItems } from '../engine/queue.ts';
import { PlayerEngine, type Position } from '../engine/engine.ts';
import { RsvpPacer } from '../engine/rsvp.ts';
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
  readonly settingsTab = signal<'reading' | 'appearance' | 'stage' | 'ai' | 'storage' | 'info'>('reading');
  readonly stageCachePaused = signal(false);
  private readonly speechCachePaused = signal(false);
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
  readonly stageGeneration = signal<ReadonlyMap<string, GenerationState>>(new Map());
  readonly imageSequence = signal<ImageSequencePlanner | undefined>(undefined);
  readonly generation = computed(() => {
    const stage: GenerationRange[] = [];
    const speech: GenerationRange[] = [];
    const states = this.stageGeneration.value;
    const buffer = ttsBuffer.value;
    const uri = this.engine.currentVoice?.voiceURI;
    const voice = isTtsVoice(uri) ? uri!.slice(TTS_VOICE_PREFIX.length) : undefined;
    const chunks = this.speechRanges.value;
    const plans = this.plans.value;
    const planned = this.planInfo.value;
    const sequence = this.imageSequence.value;
    for (const [i, entry] of this.timeline.entries.entries()) {
      if (sequence) {
        stage.push({ start: entry.start, end: entry.end, sectionId: entry.sectionId, entryIndex: i, state: sequence.stateAt(i), stageKind: 'image' });
        continue;
      }
      const state = states.get(entry.sectionId) ?? 'idle';
      // Do not label a queued AI decision with the temporary heuristic's mode.
      const mode = (state === 'working' || state === 'queued') && !planned.has(entry.sectionId) ? undefined : plans.get(entry.sectionId)?.mode;
      stage.push({ start: entry.start, end: entry.end, sectionId: entry.sectionId, state, ...(mode ? { stageKind: mode } : {}) });
    }
    if (voice && buffer) {
      for (const chunk of chunks) speech.push({ ...chunk, state: buffer.stateOf(chunk.text, this.book.language, voice) });
    }
    return { stage: mergeRanges(stage), speech: mergeRanges(speech), speechEnabled: !!voice && !!buffer };
  });
  private readonly speechRanges = computed(() => {
    const mode = settings.value.footnoteMode;
    return this.timeline.entries.flatMap((entry, i) => {
      const items = sentenceItems(i, entry, 0, mode, this.footnotes, this.book.language, true);
      const length = items.reduce((n, item) => n + item.text.length, 0);
      let at = entry.start;
      return items.map((item) => {
        const start = at;
        at += (entry.end - entry.start) * item.text.length / Math.max(1, length);
        return { start, end: at, sectionId: entry.sectionId, text: item.text };
      });
    });
  });
  /** LLM director, when an AI backend is available (B8). */
   ai: AiPlanner | ImageSequencePlanner | undefined;
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
      port: env.speech?.port,
      voice: choice.mode === 'voice' ? choice.voice : undefined,
      tempo: settings.value.tempo,
      volume: settings.value.volume,
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
    this.rsvp = new RsvpPacer({
      timeline: this.timeline,
      timers: env.timers,
      position: () => this.engine.position.value,
      seek: (p) => this.engine.seek(p),
      wpm: () => settings.value.rsvpWpm,
    });
    // Leaving the RSVP pace (other layout, voice reading again) stops the pacer.
    this.stopRsvpGuard = effect(() => {
      if (!this.pacerMode) this.rsvp.stop();
      else this.engine.pause();
    });
    this.stopVolume = effect(() => this.engine.setVolume(settings.value.volume));
    this.stopStageVisibility = effect(() => {
      const visible = this.stageVisible;
      const concurrency = settings.value.imageConcurrency;
      this.ai?.setActive(visible);
      this.ai?.setImageConcurrency(concurrency);
    });
    const planningPreference = () => {
      const s = settings.value;
      return `${s.visualKinds}:${s.imageInterval}:${s.imageIntervalSeconds}:${s.imageGrid}`;
    };
    let preference = planningPreference();
    this.stopPreference = effect(() => {
      const next = planningPreference();
      if (next === preference) return;
      preference = next;
      this.attachAi(aiBackend.peek());
    });
  }

  /** Word-by-word pacer for the RSVP layout without a voice (spec 007 B1). */
  readonly rsvp: RsvpPacer;
  private readonly stopRsvpGuard: () => void;
  private readonly stopVolume: () => void;
  private readonly stopPreference: () => void;
  private readonly stopStageVisibility: () => void;

  get stageVisible(): boolean {
    const layout = settings.value.layout;
    return layout === 'stage' || layout === 'cinema' || layout === 'overlay';
  }

  /** The RSVP layout paces itself (no voice, or "RSVP without voice"); play toggles the pacer. */
  get pacerMode(): boolean {
    const s = settings.value;
    return s.layout === 'rsvp' && (this.engine.silent || s.rsvpSilent);
  }

  /** Playing: the voice, or the RSVP pacer in pacer mode. */
  get isPlaying(): boolean {
    return this.pacerMode ? this.rsvp.running.value : this.engine.playing.value;
  }

  private readonly stopPrefetch: () => void;
  private lastPrefetch = -1;
  private prefetchSignature = '';
  private prefetchBuffer: TtsBuffer | undefined;
  private footnotesCache: ReturnType<typeof footnoteLookup> | undefined;
  private get footnotes(): ReturnType<typeof footnoteLookup> {
    return (this.footnotesCache ??= footnoteLookup(this.book));
  }

  /**
   * Keep two minutes of listening ahead, scaled by playback speed. Refresh on chunk, voice,
   * tempo, footnote mode or connection changes; word boundaries within a chunk cost nothing.
   */
  private prefetchTts(entryIndex: number): void {
    const voiceURI = this.engine?.currentVoice?.voiceURI;
    const buffer = ttsBuffer.value;
    const tempo = this.engine.currentTempo;
    const mode = settings.value.footnoteMode;
    const providers = aiDetails.value?.providers;
    if (this.pacerMode || this.speechCachePaused.value || !isTtsVoice(voiceURI)) {
      if (this.lastPrefetch !== -1) buffer?.prefetch([]);
      this.lastPrefetch = -1;
      return;
    }
    if (!buffer) return;
    const voice = voiceURI!.slice(TTS_VOICE_PREFIX.length);
    const lang = this.book.language;
    const current = this.timeline.entries[entryIndex];
    const currentItems = current ? sentenceItems(entryIndex, current, this.engine.position.value.tokenIndex, mode, this.footnotes, lang, true) : [];
    const provider = providers?.find((p) => p.id === voice.split(':')[0] && p.kind === 'tts');
    const concurrency = provider ? provider.concurrency ?? 4 : undefined;
    const signature = `${voiceURI}|${tempo}|${mode}|${concurrency}|${currentItems[0]?.text ?? ''}`;
    if (entryIndex === this.lastPrefetch && signature === this.prefetchSignature && buffer === this.prefetchBuffer) return;
    this.lastPrefetch = entryIndex;
    this.prefetchSignature = signature;
    this.prefetchBuffer = buffer;
    const items: Array<{ text: string; lang: string; voice: string }> = [];
    let seconds = 0;
    for (let i = entryIndex; i < this.timeline.entries.length && seconds < 120 && items.length < 120; i++) {
      const entry = this.timeline.entries[i]!;
      const chunks = i === entryIndex ? currentItems : sentenceItems(i, entry, 0, mode, this.footnotes, lang, true);
      for (const item of chunks) {
        if (items.length >= 120) break;
        items.push({ text: item.text, lang, voice });
      }
      if (mode === 'section-end' && this.timeline.entries[i + 1]?.sectionId !== entry.sectionId) {
        for (const item of sectionEndItems(this.sections.get(entry.sectionId)?.footnoteIds ?? [], this.footnotes, i, entry)) {
          if (items.length >= 120) break;
          items.push({ text: item.text, lang, voice });
          seconds += item.text.length / 14 / tempo;
        }
      }
      seconds += (entry.end - entry.start) / tempo;
    }
    buffer.prefetch(items);
    if (concurrency !== undefined) buffer.setConcurrency(concurrency);
  }

  /** (Re)connects the LLM director, e.g. after the provider settings changed. */
  attachAi(backend: AiBackend | undefined): void {
    if (this.disposed) return;
    this.ai?.dispose();
    this.imageSequence.value = undefined;
    this.stageGeneration.value = new Map();
    const env = this.env;
    const s = settings.peek();
    if (backend?.image && s.visualKinds === 'images' && (s.imageInterval !== 'auto' || s.imageGrid) && !this.stageCachePaused.peek()) {
      const sequence = new ImageSequencePlanner({ book: this.book, timeline: this.timeline,
        cadence: { interval: s.imageInterval === 'auto' ? 'section' : s.imageInterval, seconds: s.imageIntervalSeconds, grid: s.imageGrid },
        entryIndex: () => this.engine.position.peek().entryIndex, now: () => env.timers.now(),
        options: () => this.imageOptions(), applyStyle: style => { this.styleBible.value = style; },
      }, backend);
      this.imageSequence.value = sequence;
      this.ai = sequence;
      sequence.setImageConcurrency(s.imageConcurrency);
      sequence.setActive(this.stageVisible);
      return;
    }
    // A browser setup with only voices or images (no text model) keeps the heuristic plans.
    this.ai = backend && backend.plans !== false && !this.stageCachePaused.peek()
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
            prefer: () => (settings.value.visualKinds === 'mixed' ? undefined : settings.value.visualKinds),
            imageOptions: () => this.imageOptions(),
            generation: (id, state) => { this.stageGeneration.value = new Map(this.stageGeneration.peek()).set(id, state); },
          },
          backend,
        )
      : undefined;
    this.ai?.setActive(this.stageVisible);
    this.ai?.setImageConcurrency(s.imageConcurrency);
  }

  private imageOptions() {
    const s = settings.peek();
    return { ...(s.imageQuality !== 'auto' ? { quality: s.imageQuality } : {}), resolution: s.imageResolution, styleReference: s.imageStyleReference };
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
    this.imageSequence.peek()?.seek();
    const resume = this.rsvp.running.value;
    this.rsvp.stop();
    batch(() => {
      this.engine.seek(p);
      this.followEvent('navigate');
    });
    if (resume && this.pacerMode) this.rsvp.start();
    const section = this.sectionIdAt(this.engine.position.value.entryIndex);
    if (section) this.stage.navigate(this.stageKey(section), this.env.timers.now());
  }

  togglePlay(): void {
    if (this.pacerMode) {
      this.engine.pause();
      this.rsvp.toggle();
      return;
    }
    this.speechCachePaused.value = false;
    if (!this.engine.playing.value) this.followEvent('play');
    this.engine.toggle();
  }

  async clearCache(scope: CacheScope): Promise<void> {
    const backend = aiBackend.peek();
    if (!backend?.clearCache) throw new Error('cache maintenance unavailable');
    if (scope === 'stage') {
      this.stageCachePaused.value = true;
      this.attachAi(undefined);
      try {
        await backend.clearCache(scope);
        this.aiPlans.clear();
        this.keyPlans.clear();
        this.planInfo.value = new Map();
        this.images.value = new Map();
        this.animations.value = new Map();
        this.styleBible.value = undefined;
        for (const id of this.sections.keys()) this.replan(id);
        this.cueCache.clear();
        const id = this.sectionIdAt(this.engine.position.peek().entryIndex);
        if (id) this.stage.navigate(this.stageKey(id), this.env.timers.now());
      } catch (e) {
        this.resumeStage();
        throw e;
      }
    } else {
      this.engine.pause();
      this.speechCachePaused.value = true;
      ttsBuffer.peek()?.dispose();
      try { await backend.clearCache(scope); }
      finally {
        this.lastPrefetch = -1;
        if (aiBackend.peek() === backend && backend.tts) {
          const buffer = createTtsBuffer(backend)!;
          buffer.setConcurrency(Math.max(1, ...(aiDetails.peek()?.providers ?? []).filter((p) => p.kind === 'tts').map((p) => p.concurrency ?? 4)));
          ttsBuffer.value = buffer;
        }
      }
    }
  }

  resumeStage(): void {
    this.stageCachePaused.value = false;
    this.attachAi(aiBackend.peek());
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

  async refreshVoices(): Promise<void> {
    const web = await this.env.speech?.voices().catch(() => []) ?? [];
    if (this.disposed) return;
    this.voices.splice(0, this.voices.length, ...ttsVoices(this.book.language), ...web);
    const choice = selectVoice(this.voices, this.book.language, settings.peek().voiceByLang[primaryLanguage(this.book.language)]);
    this.voiceChoice.value = choice;
    const next = choice.mode === 'voice' ? choice.voice : undefined;
    if (this.engine.currentVoice?.voiceURI !== next?.voiceURI) this.engine.setVoice(next);
    this.lastPrefetch = -1;
    this.prefetchTts(this.engine.position.peek().entryIndex);
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
    this.stopRsvpGuard();
    this.stopVolume();
    this.stopPreference();
    this.stopStageVisibility();
    this.rsvp.stop();
    this.ai?.dispose();
    void this.savePosition();
    this.engine.dispose();
    for (const url of this.assetUrls.values()) URL.revokeObjectURL?.(url);
    this.assetUrls.clear();
  }
}
