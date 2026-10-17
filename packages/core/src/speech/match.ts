import type { SpeechToken } from './types.ts';

/** Helpers that rules use to read tokens. */

const DIGITS = /^\d+$/;
const DIGIT_START = /^\d/;
const LETTERS = /^\p{L}+$/u;
const WHITESPACE = /\s+/gu;

/** `text` without any whitespace: the form that `matchKey` compares. */
export function compactKey(text: string): string {
  return text.replace(WHITESPACE, '');
}

/**
 * Number of tokens from `i` whose texts, concatenated, equal `key` (whitespace between tokens
 * is ignored, so `z. B.` and `z.B.` match the same key `z.B.`); 0 if they do not.
 * `fold` maps a token text before the comparison (for example to lowercase).
 */
export function matchKey(
  tokens: readonly SpeechToken[],
  i: number,
  key: string,
  fold: (s: string) => string = (s) => s,
): number {
  let joined = '';
  for (let k = i; k < tokens.length; k++) {
    joined += fold(tokens[k]?.text ?? '');
    if (joined === key) return k - i + 1;
    if (!key.startsWith(joined)) return 0;
  }
  return 0;
}

export function isDigits(t: SpeechToken | undefined): t is SpeechToken {
  return t !== undefined && DIGITS.test(t.text);
}

export function startsWithDigit(t: SpeechToken | undefined): boolean {
  return t !== undefined && DIGIT_START.test(t.text);
}

export function isLetters(t: SpeechToken | undefined): t is SpeechToken {
  return t !== undefined && LETTERS.test(t.text);
}

export function isText(t: SpeechToken | undefined, text: string): t is SpeechToken {
  return t !== undefined && t.text === text;
}

/** `b` follows `a` directly, without whitespace (or a skipped token) between them. */
export function adjacent(a: SpeechToken | undefined, b: SpeechToken | undefined): boolean {
  return a !== undefined && b !== undefined && a.end === b.start;
}

/** A word with an uppercase first letter (a German noun, a name). */
export function isCapitalized(t: SpeechToken | undefined): boolean {
  return t !== undefined && /^\p{Lu}\p{L}*$/u.test(t.text);
}

/** No word-like token after position `k` (only closing punctuation may follow). */
export function atSentenceEnd(tokens: readonly SpeechToken[], k: number): boolean {
  for (let j = k; j < tokens.length; j++) if (tokens[j]?.wordLike) return false;
  return true;
}
