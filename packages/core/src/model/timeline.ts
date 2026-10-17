import { isFlowKind, type Book, type Sentence } from './schema.ts';

/** One speech-flow sentence on the 1.0× time axis. */
export interface TimelineEntry {
  sentence: Sentence;
  paragraphId: string;
  sectionId: string;
  chapterId: string;
  /** Seconds at 1.0× from the start of the book. */
  start: number;
  end: number;
}

export interface Timeline {
  entries: TimelineEntry[];
  /** Total seconds at 1.0×. */
  duration: number;
  /** Sentence ID → index in `entries`. */
  indexOf: ReadonlyMap<string, number>;
}

/**
 * The cumulative 1.0× time axis over speech-flow sentences in reading order: headings included,
 * figures and footnotes excluded (B8, D5).
 */
export function buildTimeline(book: Book): Timeline {
  const entries: TimelineEntry[] = [];
  const indexOf = new Map<string, number>();
  let t = 0;
  for (const chapter of book.chapters) {
    for (const section of chapter.sections) {
      for (const p of section.paragraphs) {
        if (!isFlowKind(p.kind)) continue;
        for (const sentence of p.sentences) {
          indexOf.set(sentence.id, entries.length);
          entries.push({
            sentence,
            paragraphId: p.id,
            sectionId: section.id,
            chapterId: chapter.id,
            start: t,
            end: t + sentence.duration,
          });
          t += sentence.duration;
        }
      }
    }
  }
  return { entries, duration: t, indexOf };
}

/** Index of the entry at time `t` (clamped to the axis); -1 for an empty axis. */
export function entryIndexAt(timeline: Timeline, t: number): number {
  const { entries } = timeline;
  if (entries.length === 0) return -1;
  let lo = 0;
  let hi = entries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((entries[mid]?.start ?? 0) <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Speech-text offset where the token starts (its map entry); noteRef tokens use the next entry. */
export function tokenSpeechOffset(sentence: Sentence, tokenIndex: number): number {
  const token = sentence.tokens[tokenIndex];
  if (!token) return sentence.speechText.length;
  for (const e of sentence.speechMap) {
    if (e.display[1] > token.start) return e.speech[0];
  }
  return sentence.speechText.length;
}

/** Time of a token inside its entry, interpolated by speech-character offset. */
export function tokenTime(entry: Pick<TimelineEntry, 'sentence' | 'start' | 'end'>, tokenIndex: number): number {
  const len = entry.sentence.speechText.length;
  if (len === 0) return entry.start;
  const fraction = Math.min(1, tokenSpeechOffset(entry.sentence, tokenIndex) / len);
  return entry.start + fraction * (entry.end - entry.start);
}
