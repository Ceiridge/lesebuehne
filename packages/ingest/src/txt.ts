import { isNormalizationWhitespace, type BlockInput, type ChapterInput } from '@lesebuehne/core';
import { IngestError } from './errors.ts';
import type { ParsedSource } from './types.ts';

interface RawBlock {
  lines: string[];
  /** Blank lines before the block (the first block counts as preceded by a page start). */
  blankBefore: number;
  first: boolean;
}

const HEADING_WORD = /^(kapitel|chapter|teil|part|buch|book|abschnitt|section)\b/iu;
const NUMERAL_LINE = /^(?:[IVXLCDM]+|\d+)\.?$/u;
const SENTENCE_END = /[.,;:]$/u;
const MAX_HEADING_LENGTH = 100;

function isBlank(line: string): boolean {
  for (const ch of line) if (!isNormalizationWhitespace(ch)) return false;
  return true;
}

/** Splits text at blank lines (lines of whitespace only), as the whitespace normalisation does. */
function rawBlocks(text: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  let blank = 0;
  let current: RawBlock | undefined;
  for (const line of text.replace(/\r\n?/gu, '\n').split('\n')) {
    if (isBlank(line)) {
      blank++;
      current = undefined;
      continue;
    }
    if (!current) {
      current = { lines: [], blankBefore: blank, first: blocks.length === 0 };
      blocks.push(current);
      blank = 0;
    }
    current.lines.push(line);
  }
  return blocks;
}

/**
 * The TXT heading rule (B3): a block of exactly one line, at most 100 characters, not ending in
 * `. , ; :`, that either starts with a chapter word (`Kapitel`, `Chapter`, `Teil`, …) or is a
 * Roman or arabic numeral line, or is preceded by at least two blank lines or is the first block.
 */
export function isTxtHeading(block: { lines: readonly string[]; blankBefore: number; first: boolean }): boolean {
  if (block.lines.length !== 1) return false;
  const line = (block.lines[0] ?? '').trim();
  if (line.length === 0 || line.length > MAX_HEADING_LENGTH || SENTENCE_END.test(line)) return false;
  return HEADING_WORD.test(line) || NUMERAL_LINE.test(line) || block.blankBefore >= 2 || block.first;
}

/**
 * Plain text: paragraphs at blank lines; each heading starts a chapter (consecutive headings share
 * one); text before the first heading forms an untitled first chapter. No footnote detection (D2).
 */
export function parseTxt(text: string, fileName: string): ParsedSource {
  const blocks = rawBlocks(text);
  if (blocks.length === 0) throw new IngestError('empty', 'The file contains no text.');
  const chapters: ChapterInput[] = [];
  let current: ChapterInput | undefined;
  for (const block of blocks) {
    const heading = isTxtHeading(block);
    const input: BlockInput = heading
      ? { kind: 'heading', level: 1, text: block.lines.join('\n') }
      : { kind: 'text', text: block.lines.join('\n') };
    // A heading starts a chapter, unless the chapter so far holds only headings (`CHAPTER II` / title).
    const onlyHeadings = current?.blocks.every((b) => b.kind === 'heading') ?? false;
    if ((heading && !onlyHeadings) || !current) {
      current = { blocks: [] };
      chapters.push(current);
    }
    current.blocks.push(input);
  }
  const firstHeading = chapters[0]?.blocks.find((b) => b.kind === 'heading');
  return {
    format: 'txt',
    title: firstHeading ? firstHeading.text.trim() : fileName.replace(/\.[^.]+$/u, ''),
    chapters,
    assets: [],
  };
}
