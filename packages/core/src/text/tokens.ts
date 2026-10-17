import { segmenterFor } from './segmenters.ts';

/** One word segment of display text. Offsets are UTF-16 offsets in the display text of the block. */
export interface Token {
  /** Running number of the token (see `TokenizeOptions.firstIndex`). */
  index: number;
  /** The segment text, exactly as in the display text. */
  text: string;
  /** Start offset (inclusive). */
  start: number;
  /** End offset (exclusive). */
  end: number;
  /** `isWordLike` of `Intl.Segmenter`: letters or numbers, not punctuation. */
  wordLike: boolean;
}

export interface TokenizeOptions {
  /** Display offset of `text` inside its block (default 0). */
  offset?: number;
  /** Index of the first token (default 0). */
  firstIndex?: number;
}

const NON_WHITESPACE = /\S+/gu;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

/**
 * Splits `text` into tokens with `Intl.Segmenter(lang, {granularity: 'word'})`.
 * Every segment that is not whitespace becomes a token. Typographic spaces (no-break,
 * thin, …) count as whitespace here: a word segment that contains one (the segmenter keeps
 * `10\u202F000` together) is split there, and a piece is word-like if the segment was and
 * the piece holds a letter or number. The same plain segmenter is used for every language:
 * tokens have no language-specific corrections.
 */
export function tokenize(text: string, lang: string, options: TokenizeOptions = {}): Token[] {
  const offset = options.offset ?? 0;
  let index = options.firstIndex ?? 0;
  const tokens: Token[] = [];
  for (const s of segmenterFor(lang, 'word').segment(text)) {
    const wordLike = s.isWordLike === true;
    for (const piece of s.segment.matchAll(NON_WHITESPACE)) {
      const start = offset + s.index + piece.index;
      tokens.push({
        index: index++,
        text: piece[0],
        start,
        end: start + piece[0].length,
        wordLike: wordLike && LETTER_OR_NUMBER.test(piece[0]),
      });
    }
  }
  return tokens;
}
