import { primaryLanguage, tokenSpeechOffset, type Book, type Paragraph, type Sentence, type TimelineEntry } from '@lesebuehne/core';

/** Footnote reading (B8, Q6): skip (default), inline at the marker, or at the section end. */
export type FootnoteMode = 'skip' | 'inline' | 'section-end';

/** Longest utterance before the remainder is split at clause punctuation (D9). */
export const MAX_CHUNK_CHARS = 200;

export type QueueItem =
  | {
      kind: 'sentence';
      entryIndex: number;
      /** Speech offset of the chunk start in the sentence's `speechText`. */
      offset: number;
      text: string;
      /** Resume inside a canonical generated-audio chunk, without synthesizing a suffix. */
      startOffset?: number;
      /** First chunk of a sentence (sentence start event). */
      first: boolean;
      /** Last chunk of a sentence (sentence end event). */
      last: boolean;
      /** The chunk starts at speech offset 0 and the sentence is spoken to its end. */
      whole: boolean;
    }
  | {
      kind: 'footnote';
      footnoteId: string;
      text: string;
      /** The marker (carrying) token the clock stays on while the footnote is spoken (D3). */
      entryIndex: number;
      tokenIndex: number;
    };

const FOOTNOTE_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  de: ['Fußnote:', 'Ende der Fußnote.'],
  en: ['Footnote:', 'End of footnote.'],
};

/** Spoken markers around an inline footnote, by book language (German default). */
export function footnoteMarkers(lang: string): readonly [string, string] {
  return FOOTNOTE_WORDS[primaryLanguage(lang)] ?? (FOOTNOTE_WORDS.de as readonly [string, string]);
}

const CLAUSE = /[,;:–—]/gu;

/**
 * Splits `text` (starting at speech offset `base`) into chunks of at most `max` characters,
 * cutting after clause punctuation near the limit (else at a space). Offsets stay exact (D9).
 */
export function chunkSpeech(text: string, base: number, max = MAX_CHUNK_CHARS): Array<{ offset: number; text: string }> {
  const out: Array<{ offset: number; text: string }> = [];
  let start = 0;
  while (text.length - start > max) {
    const window = text.slice(start, start + max);
    let cut = -1;
    for (const m of window.matchAll(CLAUSE)) if ((m.index ?? 0) > max / 3) cut = (m.index ?? 0) + 1;
    if (cut < 0) {
      const space = window.lastIndexOf(' ');
      cut = space > max / 3 ? space : max;
    }
    while (text.charAt(start + cut) === ' ') cut++;
    out.push({ offset: base + start, text: text.slice(start, start + cut) });
    start += cut;
  }
  out.push({ offset: base + start, text: text.slice(start) });
  return out.filter((c) => c.text.trim() !== '');
}

export interface FootnoteLookup {
  /** Speech text of a footnote (its sentences' speech joined). */
  speech(footnoteId: string): string | undefined;
}

export function footnoteLookup(book: Book): FootnoteLookup {
  const byId = new Map<string, Paragraph>();
  for (const c of book.chapters) for (const s of c.sections) for (const p of s.paragraphs) if (p.footnoteId) byId.set(p.footnoteId, p);
  return {
    speech(id) {
      const p = byId.get(id);
      return p ? p.sentences.map((s) => s.speechText).filter((t) => t !== '').join(' ') : undefined;
    },
  };
}

/** Speech offset right after the carrying token of a footnote reference. */
function afterToken(sentence: Sentence, tokenIndex: number): number {
  const token = sentence.tokens[tokenIndex];
  if (!token) return sentence.speechText.length;
  const entry = sentence.speechMap.find((e) => e.display[1] >= token.end && e.display[0] <= token.start);
  if (entry) return sentence.speechText.slice(0, entry.speech[1]).trimEnd().length;
  return tokenSpeechOffset(sentence, tokenIndex + 1);
}

/**
 * The utterances for one sentence, spoken from `fromToken`: chunks of the remainder, and in
 * inline mode each referenced footnote right after its marker (B8, D3, D9).
 */
export function sentenceItems(
  entryIndex: number,
  entry: Pick<TimelineEntry, 'sentence'>,
  fromToken: number,
  mode: FootnoteMode,
  footnotes: FootnoteLookup,
  lang: string,
  canonical = false,
): QueueItem[] {
  const { sentence } = entry;
  const from = tokenSpeechOffset(sentence, fromToken);
  if (canonical && fromToken > 0) {
    const items = sentenceItems(entryIndex, entry, 0, mode, footnotes, lang);
    return items.filter((item) => item.kind === 'footnote' ? item.tokenIndex >= fromToken : item.offset + item.text.length > from)
      .map((item) => item.kind === 'sentence' && from > item.offset
        ? { ...item, startOffset: from - item.offset, whole: false }
        : item);
  }
  const cuts: Array<{ at: number; footnoteId: string; tokenIndex: number }> = [];
  if (mode === 'inline') {
    for (const ref of sentence.footnoteRefs ?? []) {
      const tokenIndex = sentence.tokens.findIndex((t) => t.id === ref.tokenId);
      if (tokenIndex < fromToken) continue;
      cuts.push({ at: afterToken(sentence, tokenIndex), footnoteId: ref.footnoteId, tokenIndex });
    }
    cuts.sort((a, b) => a.at - b.at);
  }
  const [intro, outro] = footnoteMarkers(lang);
  const items: QueueItem[] = [];
  let pos = from;
  const pushText = (end: number): void => {
    const raw = sentence.speechText.slice(pos, end);
    const lead = raw.length - raw.trimStart().length;
    for (const c of chunkSpeech(raw.trimStart(), pos + lead)) {
      items.push({ kind: 'sentence', entryIndex, offset: c.offset, text: c.text.trimEnd(), first: false, last: false, whole: false });
    }
    pos = end;
  };
  for (const cut of cuts) {
    pushText(Math.max(pos, cut.at));
    const text = footnotes.speech(cut.footnoteId);
    if (text) items.push({ kind: 'footnote', footnoteId: cut.footnoteId, text: `${intro} ${text} ${outro}`, entryIndex, tokenIndex: cut.tokenIndex });
  }
  pushText(sentence.speechText.length);
  const spoken = items.filter((i): i is Extract<QueueItem, { kind: 'sentence' }> => i.kind === 'sentence');
  if (spoken[0]) spoken[0].first = true;
  const lastSpoken = spoken.at(-1);
  if (lastSpoken) lastSpoken.last = true;
  if (from === 0 && cuts.length === 0) for (const s of spoken) s.whole = true;
  return items;
}

/** Footnotes read after the last sentence of a section ("at section end"). */
export function sectionEndItems(
  footnoteIds: readonly string[],
  footnotes: FootnoteLookup,
  entryIndex: number,
  entry: Pick<TimelineEntry, 'sentence'>,
): QueueItem[] {
  const tokenIndex = Math.max(0, entry.sentence.tokens.length - 1);
  return footnoteIds.flatMap((id) => {
    const text = footnotes.speech(id);
    return text ? [{ kind: 'footnote' as const, footnoteId: id, text, entryIndex, tokenIndex }] : [];
  });
}
