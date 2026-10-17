import type { Sentence, Timeline } from '@lesebuehne/core';
import { signal } from '@preact/signals';
import type { Position } from './engine.ts';
import type { Timers } from './voices.ts';

/**
 * RSVP reading (spec 007 B1): one word at a time at a fixed place, its optimal recognition point
 * (ORP) marked, so the eyes never move.
 */

/** ORP letter index of a word (letters and digits only count): slightly left of the middle. */
export function orpIndex(word: string): number {
  const n = [...word].length;
  if (n <= 1) return 0;
  if (n <= 5) return 1;
  if (n <= 9) return 2;
  if (n <= 13) return 3;
  return 4;
}

export interface RsvpWord {
  /** Text left of the ORP letter (leading punctuation included). */
  before: string;
  pivot: string;
  /** Text right of it (trailing punctuation included). */
  after: string;
  /** The word token shown. */
  tokenIndex: number;
}

interface DisplayUnit { first: number; last: number; anchor: number; text: string }
const unitsCache = new WeakMap<Sentence, DisplayUnit[]>();

/** Keep every visible source character, including standalone operators and currency prefixes. */
function units(sentence: Sentence): DisplayUnit[] {
  const cached = unitsCache.get(sentence);
  if (cached) return cached;
  const out: DisplayUnit[] = [];
  sentence.tokens.forEach((token, k) => {
    if (token.noteRef || !token.text.trim()) return;
    const previous = out.at(-1);
    if (previous && previous.last === k - 1 && sentence.tokens[previous.last]!.end === token.start) {
      previous.text += token.text;
      previous.last = k;
      if (!sentence.tokens[previous.anchor]!.wordLike && token.wordLike) previous.anchor = k;
    } else out.push({ first: k, last: k, anchor: k, text: token.text });
  });
  unitsCache.set(sentence, out);
  return out;
}

/** The word token for a reading position: the token itself, else the nearest word before it. */
export function wordTokenAt(sentence: Sentence, tokenIndex: number): number | undefined {
  const all = units(sentence);
  return (all.find((u) => tokenIndex >= u.first && tokenIndex <= u.last)
    ?? all.findLast((u) => u.first <= tokenIndex) ?? all[0])?.anchor;
}

/** The word at a position, split around its ORP letter, with attached punctuation. */
export function rsvpWord(sentence: Sentence, tokenIndex: number): RsvpWord | undefined {
  const k = wordTokenAt(sentence, tokenIndex);
  if (k === undefined) return undefined;
  const chars = [...units(sentence).find((u) => u.anchor === k)!.text];
  const letters = chars.map((c, i) => (/[\p{L}\p{N}]/u.test(c) ? i : -1)).filter((i) => i >= 0);
  const at = letters[orpIndex(letters.map((i) => chars[i]).join(''))] ?? 0;
  return { before: chars.slice(0, at).join(''), pivot: chars[at] ?? '', after: chars.slice(at + 1).join(''), tokenIndex: k };
}

/** How long a word stays at `wpm`: longer words a little longer, pauses at clause and sentence ends. */
export function wordDelayMs(sentence: Sentence, tokenIndex: number, wpm: number): number {
  const w = rsvpWord(sentence, tokenIndex);
  const base = 60_000 / Math.max(50, wpm);
  if (!w) return base;
  const letters = [...(w.before + w.pivot + w.after)].filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
  let f = 1 + Math.min(0.6, Math.max(0, letters - 7) * 0.06);
  const last = units(sentence).at(-1)?.anchor === w.tokenIndex;
  if (last || /[.!?…]/u.test(w.after)) f *= 2.2;
  else if (/[,;:–—)]/u.test(w.after)) f *= 1.6;
  return Math.round(base * f);
}

/** The next word token after `p`, across sentences; undefined at the end of the book. */
export function nextWord(timeline: Timeline, p: Position): Position | undefined {
  for (let e = p.entryIndex, from = p.tokenIndex + 1; e < timeline.entries.length; e++, from = 0) {
    const unit = units(timeline.entries[e]!.sentence).find((u) => u.anchor >= from);
    if (unit) return { entryIndex: e, tokenIndex: unit.anchor };
  }
  return undefined;
}

/** Advances the reading position word by word at a words-per-minute pace (no voice). */
export class RsvpPacer {
  readonly running = signal(false);
  private timer: unknown;

  constructor(
    private readonly o: {
      timeline: Timeline;
      timers: Timers;
      position: () => Position;
      seek: (p: Position) => void;
      wpm: () => number;
    },
  ) {}

  start(): void {
    if (this.running.value) return;
    const p = this.o.position();
    const sentence = this.o.timeline.entries[p.entryIndex]?.sentence;
    const tokenIndex = sentence ? wordTokenAt(sentence, p.tokenIndex) : undefined;
    if (tokenIndex !== undefined && tokenIndex !== p.tokenIndex) this.o.seek({ ...p, tokenIndex });
    this.running.value = true;
    this.schedule();
  }

  stop(): void {
    this.o.timers.clearTimeout(this.timer);
    this.timer = undefined;
    this.running.value = false;
  }

  toggle(): void {
    if (this.running.value) this.stop();
    else this.start();
  }

  private schedule(): void {
    const p = this.o.position();
    const sentence = this.o.timeline.entries[p.entryIndex]?.sentence;
    if (!sentence) return this.stop();
    this.timer = this.o.timers.setTimeout(() => {
      if (!this.running.value) return;
      const next = nextWord(this.o.timeline, this.o.position());
      if (!next) return this.stop();
      this.o.seek(next);
      this.schedule();
    }, wordDelayMs(sentence, p.tokenIndex, this.o.wpm()));
  }
}
