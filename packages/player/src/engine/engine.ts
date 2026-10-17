import { tokenTime, type Book, type Sentence, type Timeline } from '@lesebuehne/core';
import { signal, type Signal } from '@preact/signals';
import { BoundaryDetector, Calibration, WordEstimator } from './estimator.ts';
import { footnoteLookup, sectionEndItems, sentenceItems, type FootnoteLookup, type FootnoteMode, type QueueItem } from './queue.ts';
import type { SpeechPort } from './speech-port.ts';
import { realTimers, type Timers, type VoiceInfo } from './voices.ts';

/** The reading position: a sentence on the time axis and a token in it. */
export interface Position {
  entryIndex: number;
  tokenIndex: number;
}

export const MIN_TEMPO = 0.75;
export const MAX_TEMPO = 2.5;
export const TEMPO_STEP = 0.25;
/** Watchdog floor (D9). */
export const WATCHDOG_MIN_MS = 15_000;

export function clampTempo(t: number): number {
  return Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, Math.round(t / TEMPO_STEP) * TEMPO_STEP));
}

/** Token index whose speech range contains `offset` (the token where that speech came from). */
export function tokenAtSpeechOffset(sentence: Pick<Sentence, 'speechMap' | 'tokens'>, offset: number): number {
  let entry = sentence.speechMap[0];
  for (const e of sentence.speechMap) if (e.speech[0] <= offset) entry = e;
  if (!entry) return 0;
  const k = sentence.tokens.findIndex((t) => t.start === entry.display[0]);
  return k < 0 ? 0 : k;
}

export interface EngineOptions {
  book: Book;
  timeline: Timeline;
  /** No port or no voice → silent reading mode (B7, C4). */
  port?: SpeechPort | undefined;
  voice?: VoiceInfo | undefined;
  tempo?: number;
  footnoteMode?: FootnoteMode;
  timers?: Timers;
  calibration?: Calibration;
  detector?: BoundaryDetector;
  start?: Position;
}

/**
 * Playback engine with one master clock (B7): the reading position, advanced only by speech
 * events, the word estimator and navigation. It speaks one utterance at a time, sentence by
 * sentence; pause, tempo and voice changes cancel and restart at the current word.
 */
export class PlayerEngine {
  readonly position: Signal<Position>;
  readonly playing = signal(false);
  /** The footnote being read aloud (the clock stays on its marker, D3). */
  readonly speakingFootnote = signal<string | null>(null);
  /** The word highlight is estimated (voice without word boundaries, Q4). */
  readonly estimated = signal(false);
  readonly silent: boolean;

  private readonly book: Book;
  private readonly timeline: Timeline;
  private readonly port: SpeechPort | undefined;
  private voice: VoiceInfo | undefined;
  private tempo: number;
  private footnoteMode: FootnoteMode;
  private readonly timers: Timers;
  private readonly calibration: Calibration;
  readonly detector: BoundaryDetector;
  private readonly footnotes: FootnoteLookup;

  private generation = 0;
  private items: QueueItem[] = [];
  private current: QueueItem | undefined;
  private sectionDone = new Set<string>();
  private estimator: WordEstimator | undefined;
  private chunkStartedAt = 0;
  private sentenceStartedAt = 0;
  private positionAt = 0;
  private watchdog: unknown;

  constructor(o: EngineOptions) {
    this.book = o.book;
    this.timeline = o.timeline;
    this.port = o.port;
    this.voice = o.voice;
    this.silent = !o.port || !o.voice;
    this.tempo = clampTempo(o.tempo ?? 1);
    this.footnoteMode = o.footnoteMode ?? 'skip';
    this.timers = o.timers ?? realTimers;
    this.calibration = o.calibration ?? new Calibration();
    this.detector = o.detector ?? new BoundaryDetector();
    this.footnotes = footnoteLookup(o.book);
    this.position = signal(o.start ?? { entryIndex: 0, tokenIndex: 0 });
    this.estimated.value = this.voice ? this.detector.hint(this.voice.voiceURI) : false;
  }

  get currentTempo(): number {
    return this.tempo;
  }
  get currentVoice(): VoiceInfo | undefined {
    return this.voice;
  }

  private setPosition(p: Position): void {
    const cur = this.position.value;
    this.positionAt = this.timers.now();
    if (cur.entryIndex !== p.entryIndex || cur.tokenIndex !== p.tokenIndex) this.position.value = p;
  }

  private clamp(p: Position): Position {
    const n = this.timeline.entries.length;
    const entryIndex = Math.min(Math.max(0, p.entryIndex), Math.max(0, n - 1));
    const tokens = this.timeline.entries[entryIndex]?.sentence.tokens.length ?? 1;
    return { entryIndex, tokenIndex: Math.min(Math.max(0, p.tokenIndex), Math.max(0, tokens - 1)) };
  }

  /** Navigation: set the position; if playing, speech restarts there (B8, seek semantics). */
  seek(p: Position): void {
    const target = this.clamp(p);
    this.setPosition(target);
    if (this.playing.value) this.speakFrom(target);
  }

  play(): void {
    if (this.silent || this.playing.value || this.timeline.entries.length === 0) return;
    this.playing.value = true;
    this.speakFrom(this.position.value);
  }

  pause(): void {
    if (!this.playing.value) return;
    this.stopSpeech();
    this.playing.value = false;
  }

  toggle(): void {
    if (this.playing.value) this.pause();
    else this.play();
  }

  setTempo(t: number): void {
    const next = clampTempo(t);
    if (next === this.tempo) return;
    this.tempo = next;
    if (this.playing.value) this.speakFrom(this.position.value);
  }

  setVoice(v: VoiceInfo): void {
    this.voice = v;
    this.estimated.value = this.detector.hint(v.voiceURI);
    if (this.playing.value) this.speakFrom(this.position.value);
  }

  setFootnoteMode(m: FootnoteMode): void {
    this.footnoteMode = m;
    if (this.playing.value) this.speakFrom(this.position.value);
  }

  dispose(): void {
    this.stopSpeech();
    this.playing.value = false;
  }

  private stopSpeech(): void {
    this.generation++;
    this.port?.cancel();
    this.timers.clearTimeout(this.watchdog);
    this.items = [];
    this.current = undefined;
    this.estimator = undefined;
    this.speakingFootnote.value = null;
  }

  private speakFrom(p: Position): void {
    this.stopSpeech();
    this.sectionDone = new Set();
    const entry = this.timeline.entries[p.entryIndex];
    if (!entry) return;
    this.setPosition(p);
    this.items = sentenceItems(p.entryIndex, entry, p.tokenIndex, this.footnoteMode, this.footnotes, this.book.language);
    this.next();
  }

  private sectionFootnotes(entryIndex: number): string[] {
    const entry = this.timeline.entries[entryIndex];
    const next = this.timeline.entries[entryIndex + 1];
    if (!entry || (next && next.sectionId === entry.sectionId) || this.sectionDone.has(entry.sectionId)) return [];
    this.sectionDone.add(entry.sectionId);
    for (const c of this.book.chapters) for (const s of c.sections) if (s.id === entry.sectionId) return s.footnoteIds ?? [];
    return [];
  }

  private next(): void {
    while (this.items.length === 0) {
      const at = this.current?.entryIndex ?? this.position.value.entryIndex;
      if (this.footnoteMode === 'section-end') {
        const ids = this.sectionFootnotes(at);
        const entry = this.timeline.entries[at];
        if (ids.length > 0 && entry) {
          this.items = sectionEndItems(ids, this.footnotes, at, entry);
          if (this.items.length > 0) break;
        }
      }
      const nextIndex = at + 1;
      const entry = this.timeline.entries[nextIndex];
      if (!entry) {
        // End of the book: stay on the last word.
        this.stopSpeech();
        this.playing.value = false;
        return;
      }
      this.items = sentenceItems(nextIndex, entry, 0, this.footnoteMode, this.footnotes, this.book.language);
      if (this.items.length === 0) this.current = { kind: 'sentence', entryIndex: nextIndex, offset: 0, text: '', first: true, last: true, whole: false };
    }
    const item = this.items.shift();
    if (item) this.speak(item);
  }

  private estimateMs(item: QueueItem): number {
    const cps = this.calibration.cps(this.voice?.voiceURI ?? '', this.tempo, this.book.language);
    return (item.text.length / cps) * 1000;
  }

  private armWatchdog(item: QueueItem, g: number): void {
    this.timers.clearTimeout(this.watchdog);
    const ms = Math.max(2 * this.estimateMs(item), WATCHDOG_MIN_MS);
    this.watchdog = this.timers.setTimeout(() => {
      if (g !== this.generation || !this.playing.value) return;
      // No speech event for too long (lost `end`, D9): restart at the estimated word.
      this.frame(this.timers.now());
      this.speakFrom(this.position.value);
    }, ms);
  }

  private speak(item: QueueItem): void {
    const port = this.port;
    if (!port) return;
    this.current = item;
    const g = this.generation;
    const live = (): boolean => g === this.generation;
    port.speak({
      text: item.text,
      lang: this.book.language,
      ...(this.voice ? { voiceURI: this.voice.voiceURI } : {}),
      rate: this.tempo,
      onStart: () => {
        if (!live()) return;
        this.armWatchdog(item, g);
        this.onStart(item);
      },
      onBoundary: (charIndex, name) => {
        if (!live()) return;
        this.armWatchdog(item, g);
        if (name === 'word') this.onWord(item, charIndex);
      },
      onEnd: () => {
        if (live()) this.onEnd(item);
      },
      onError: () => {
        if (live()) this.onEnd(item);
      },
    });
    this.armWatchdog(item, g);
  }

  private onStart(item: QueueItem): void {
    const now = this.timers.now();
    if (item.kind === 'footnote') {
      this.speakingFootnote.value = item.footnoteId;
      this.estimator = undefined;
      this.setPosition({ entryIndex: item.entryIndex, tokenIndex: item.tokenIndex });
      return;
    }
    this.speakingFootnote.value = null;
    const sentence = this.timeline.entries[item.entryIndex]?.sentence;
    if (!sentence) return;
    if (item.first) {
      this.detector.sentenceStart();
      this.sentenceStartedAt = now;
    }
    this.chunkStartedAt = now;
    const cps = this.calibration.cps(this.voice?.voiceURI ?? '', this.tempo, this.book.language);
    this.estimator = new WordEstimator(sentence, item.offset, cps);
    this.setPosition({ entryIndex: item.entryIndex, tokenIndex: tokenAtSpeechOffset(sentence, item.offset) });
  }

  private onWord(item: QueueItem, charIndex: number): void {
    if (item.kind !== 'sentence' || !this.voice) return;
    this.detector.word(this.voice.voiceURI);
    this.estimated.value = false;
    const sentence = this.timeline.entries[item.entryIndex]?.sentence;
    if (!sentence) return;
    const token = tokenAtSpeechOffset(sentence, item.offset + charIndex);
    const cur = this.position.value;
    if (cur.entryIndex !== item.entryIndex || token >= cur.tokenIndex) this.setPosition({ entryIndex: item.entryIndex, tokenIndex: token });
  }

  private onEnd(item: QueueItem): void {
    this.timers.clearTimeout(this.watchdog);
    if (item.kind === 'sentence' && item.last && this.voice) {
      const sentence = this.timeline.entries[item.entryIndex]?.sentence;
      if (sentence) {
        const words = sentence.tokens.filter((t) => t.wordLike && !t.noteRef).length;
        this.detector.sentenceEnd(this.voice.voiceURI, words);
        this.estimated.value = this.detector.hint(this.voice.voiceURI);
        if (item.whole) {
          const seconds = (this.timers.now() - this.sentenceStartedAt) / 1000;
          this.calibration.update(this.voice.voiceURI, this.tempo, this.book.language, sentence.speechText.length, seconds);
        }
      }
    }
    if (item.kind === 'footnote') this.speakingFootnote.value = null;
    this.estimator = undefined;
    this.next();
  }

  /**
   * Called once per animation frame. Advances the estimated word for voices without word
   * boundaries and returns the book time τ for visuals (interpolated, never past the next token
   * for boundary voices, never past the sentence end).
   */
  frame(now: number): number {
    const p = this.position.value;
    const entry = this.timeline.entries[p.entryIndex];
    if (!entry) return 0;
    const voiceURI = this.voice?.voiceURI ?? '';
    if (this.playing.value && this.estimator && this.current?.kind === 'sentence' && this.detector.state(voiceURI) !== 'yes') {
      const token = this.estimator.tokenAt(now - this.chunkStartedAt);
      if (this.current.entryIndex === p.entryIndex && token > p.tokenIndex) this.setPosition({ entryIndex: p.entryIndex, tokenIndex: token });
    }
    const q = this.position.value;
    const base = tokenTime(entry, q.tokenIndex);
    if (!this.playing.value || this.speakingFootnote.value) return base;
    const cap =
      this.detector.state(voiceURI) === 'yes' && q.tokenIndex + 1 < entry.sentence.tokens.length ? tokenTime(entry, q.tokenIndex + 1) : entry.end;
    return Math.min(cap, base + ((now - this.positionAt) / 1000) * this.tempo);
  }

  /** τ of the current position without interpolation. */
  time(): number {
    const p = this.position.value;
    const entry = this.timeline.entries[p.entryIndex];
    return entry ? tokenTime(entry, p.tokenIndex) : 0;
  }
}
