import { segmentSentences } from '../segment/sentences.ts';
import type { Lexicon } from '../speech/lexicon.ts';
import { normalizeSpeech } from '../speech/normalize.ts';
import { contentHash } from '../text/hash.ts';
import { tokenize } from '../text/tokens.ts';
import { normalizeBlocks } from '../text/whitespace.ts';
import { estimateSeconds } from './duration.ts';
import {
  isFlowKind,
  type Book,
  type BlockKind,
  type Chapter,
  type Figure,
  type FootnoteRef,
  type Mark,
  type Paragraph,
  type Section,
  type Sentence,
  type Token,
} from './schema.ts';
import { packSections } from './sections.ts';

/** A footnote reference inside a block's text (D7). */
export interface NoteRefInput {
  /** Display offset of the reference. */
  at: number;
  /** Length of the label in the display text: EPUB > 0 (noteref text), Markdown 0. */
  length: number;
  footnoteId: string;
  label: string;
}

/** One block as a format reader produces it. */
export interface BlockInput {
  kind: BlockKind;
  level?: number;
  /** Display text. Whitespace is normalised here (B2 step 3) unless `charSources` is given. */
  text: string;
  /** List items as display ranges of `text`; sentences never cross an item boundary. */
  items?: Array<[number, number]>;
  ordered?: boolean;
  marks?: Mark[];
  footnoteId?: string;
  figure?: Figure;
  noteRefs?: NoteRefInput[];
  /** Markdown: the source range of each display character (same length as `text`, D6). */
  charSources?: Array<[number, number]>;
}

export interface ChapterInput {
  /** Chapter heading text; defaults to the first heading block, else `''`. */
  title?: string;
  blocks: BlockInput[];
}

export interface AssembleInput {
  language: string;
  title: string;
  author?: string;
  chapters: ChapterInput[];
  lexicon?: Lexicon;
}

/** Whitespace normalisation of one block (B2 steps 1–3, without block splitting). */
export function normalizeBlockText(text: string): string {
  return normalizeBlocks(text).join(' ');
}

class Occurrences {
  private readonly seen = new Map<string, number>();
  next(key: string): number {
    const n = this.seen.get(key) ?? 0;
    this.seen.set(key, n + 1);
    return n;
  }
}

/** Merges the per-character source ranges of `[start, end)` into contiguous pieces. */
function sourcePieces(charSources: Array<[number, number]>, start: number, end: number): Array<[number, number]> {
  const pieces: Array<[number, number]> = [];
  for (let c = start; c < end; c++) {
    const r = charSources[c];
    if (!r) continue;
    const last = pieces.at(-1);
    if (last && last[1] === r[0]) last[1] = r[1];
    else pieces.push([r[0], r[1]]);
  }
  return pieces;
}

/** Splits tokens at the edges of EPUB noteref labels and flags the label tokens. */
function applyNoteRefs(
  tokens: Array<Omit<Token, 'id'>>,
  refs: readonly NoteRefInput[],
): Array<Omit<Token, 'id'>> {
  const labelled = refs.filter((r) => r.length > 0);
  if (labelled.length === 0) return tokens;
  const cuts = new Set(labelled.flatMap((r) => [r.at, r.at + r.length]));
  const out: Array<Omit<Token, 'id'>> = [];
  for (const t of tokens) {
    let from = t.start;
    const edges = [...cuts].filter((c) => c > t.start && c < t.end).sort((a, b) => a - b);
    for (const edge of [...edges, t.end]) {
      const text = t.text.slice(from - t.start, edge - t.start);
      const inLabel = labelled.some((r) => r.at <= from && edge <= r.at + r.length);
      out.push({
        index: 0,
        text,
        start: from,
        end: edge,
        wordLike: edges.length === 0 ? t.wordLike : /[\p{L}\p{N}]/u.test(text),
        ...(inLabel ? { noteRef: true as const } : {}),
      });
      from = edge;
    }
  }
  return out.map((t, index) => ({ ...t, index }));
}

function buildSentences(
  paragraphId: string,
  block: BlockInput,
  text: string,
  lang: string,
  lexicon: Lexicon | undefined,
): Sentence[] {
  const segments = block.items && block.items.length > 0 ? block.items : [[0, text.length] as [number, number]];
  const occurrences = new Occurrences();
  const refs = block.noteRefs ?? [];
  const sentences: Sentence[] = [];
  for (const [segStart, segEnd] of segments) {
    // A heading is one sentence (`1. The Principle of Mentalism` must not split after `1.`).
    const spans =
      block.kind === 'heading'
        ? [{ start: 0, end: segEnd - segStart, text: text.slice(segStart, segEnd) }]
        : segmentSentences(text.slice(segStart, segEnd), lang);
    for (const span of spans) {
      const raw = span.text;
      const trimmed = raw.trimEnd();
      if (trimmed.trim() === '') continue;
      const lead = trimmed.length - trimmed.trimStart().length;
      const start = segStart + span.start + lead;
      const sentenceText = trimmed.slice(lead);
      const end = start + sentenceText.length;
      const id = `${paragraphId}/${contentHash(sentenceText)}:${occurrences.next(sentenceText)}`;
      const inSentence = refs.filter((r) => r.at >= start && r.at <= end);
      const tokens: Token[] = applyNoteRefs(tokenize(sentenceText, lang, { offset: start }), inSentence).map((t) => ({
        ...t,
        id: `${id}#${t.index}`,
        ...(block.charSources ? { src: sourcePieces(block.charSources, t.start, t.end) } : {}),
      }));
      const speech = normalizeSpeech(tokens, lang, lexicon ? { lexicon } : {});
      const sentence: Sentence = {
        id,
        start,
        end,
        text: sentenceText,
        speechText: speech.speechText,
        speechMap: speech.map,
        duration: estimateSeconds(speech.speechText, lang),
        tokens,
      };
      sentences.push(sentence);
    }
  }
  // Footnote references: EPUB → the label token; Markdown → the display token before it (D7).
  for (const r of refs) {
    const sentence =
      sentences.findLast((s) => s.start < r.at || (r.length > 0 && s.start === r.at)) ?? sentences[0];
    if (!sentence || sentence.tokens.length === 0) continue;
    const token =
      r.length > 0
        ? sentence.tokens.find((t) => t.noteRef && t.start >= r.at && t.end <= r.at + r.length)
        : (sentence.tokens.findLast((t) => t.end <= r.at) ?? sentence.tokens[0]);
    if (!token) continue;
    const ref: FootnoteRef = { tokenId: token.id, footnoteId: r.footnoteId, label: r.label };
    sentence.footnoteRefs = [...(sentence.footnoteRefs ?? []), ref];
  }
  return sentences;
}

/**
 * Builds the canonical book model with stable content-based IDs (B2) and packs each chapter
 * into sections (B3, D5). File name, size and import time are not inputs, so they never change
 * an ID.
 */
export function assembleBook(input: AssembleInput): Book {
  const lang = input.language;
  const chapterOcc = new Occurrences();
  const paragraphOcc = new Occurrences();
  const allTexts: string[] = [];

  const chapters: Chapter[] = input.chapters.map((ch) => {
    const paragraphs: Paragraph[] = ch.blocks.map((block) => {
      const text = block.charSources ? block.text : normalizeBlockText(block.text);
      if (block.charSources && block.charSources.length !== text.length) {
        throw new Error('charSources must have one entry per display character');
      }
      if (text !== '') allTexts.push(text);
      const id = `p:${contentHash(text)}:${paragraphOcc.next(text)}`;
      const paragraph: Paragraph = {
        id,
        kind: block.kind,
        displayText: text,
        sentences: buildSentences(id, block, text, lang, input.lexicon),
        ...(block.level !== undefined ? { level: block.level } : {}),
        ...(block.marks && block.marks.length > 0 ? { marks: block.marks } : {}),
        ...(block.items ? { items: block.items } : {}),
        ...(block.ordered !== undefined ? { ordered: block.ordered } : {}),
        ...(block.footnoteId !== undefined ? { footnoteId: block.footnoteId } : {}),
        ...(block.figure ? { figure: block.figure } : {}),
      };
      return paragraph;
    });

    const title = ch.title ?? paragraphs.find((p) => p.kind === 'heading')?.displayText ?? '';
    const groups = packSections(
      paragraphs.map((p) => ({
        kind: p.kind,
        duration: isFlowKind(p.kind) ? p.sentences.reduce((s, x) => s + x.duration, 0) : 0,
      })),
    );
    const sections: Section[] = groups.map((indexes) => {
      const members = indexes.map((k) => paragraphs[k]).filter((p): p is Paragraph => p !== undefined);
      return {
        id: `x:${contentHash(members.map((p) => p.id).join('\n'))}`,
        paragraphs: members,
        duration: members
          .filter((p) => isFlowKind(p.kind))
          .reduce((s, p) => s + p.sentences.reduce((a, x) => a + x.duration, 0), 0),
      };
    });
    return { id: `c:${contentHash(title)}:${chapterOcc.next(title)}`, title, sections };
  });

  // "At section end": each footnote belongs to the section of its first reference (D5).
  const attached = new Set<string>();
  for (const section of chapters.flatMap((c) => c.sections)) {
    for (const p of section.paragraphs) {
      if (!isFlowKind(p.kind)) continue;
      for (const ref of p.sentences.flatMap((s) => s.footnoteRefs ?? [])) {
        if (attached.has(ref.footnoteId)) continue;
        attached.add(ref.footnoteId);
        section.footnoteIds = [...(section.footnoteIds ?? []), ref.footnoteId];
      }
    }
  }

  return {
    id: `b:${contentHash(`${allTexts.join('\n\n')}\u0000${lang}`)}`,
    language: lang,
    title: input.title,
    ...(input.author !== undefined ? { author: input.author } : {}),
    chapters,
  };
}

/** All paragraphs in reading order. */
export function bookParagraphs(book: Book): Paragraph[] {
  return book.chapters.flatMap((c) => c.sections.flatMap((s) => s.paragraphs));
}

/** The display text rebuilt from the model: block `displayText`s joined by `\n\n` (B2). */
export function rebuildDisplayText(book: Book): string {
  return bookParagraphs(book)
    .map((p) => p.displayText)
    .filter((t) => t !== '')
    .join('\n\n');
}
