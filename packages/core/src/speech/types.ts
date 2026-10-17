/**
 * Input of speech normalisation: one display token. `Token` from `text/tokens.ts` fits this
 * type; a format reader adds `noteRef` for a footnote reference marker (EPUB noteref text),
 * which is shown but never spoken.
 */
export interface SpeechToken {
  /** The token text, exactly as in the display text. */
  readonly text: string;
  /** Display start offset (UTF-16, inclusive). */
  readonly start: number;
  /** Display end offset (UTF-16, exclusive). */
  readonly end: number;
  /** Letters or numbers, not punctuation. */
  readonly wordLike: boolean;
  /** A footnote reference marker: empty speech, no map entry. */
  readonly noteRef?: boolean;
}

/** What a rule makes of the tokens at its position. */
export interface SpeechMatch {
  /** Number of tokens the rule consumes (at least 1). */
  consume: number;
  /** Speech text for the consumed tokens (not empty). */
  speech: string;
  /** Surround with spaces even where the display has none (`50%` → `fünfzig Prozent`). */
  spaced?: boolean;
}

/**
 * One speech rule. `match` looks at the spoken tokens (without `noteRef` tokens) at position
 * `i`, may read the tokens before and after it, and returns `null` if it does not apply.
 */
export interface SpeechRule {
  readonly id: string;
  /** Primary language subtag the rule belongs to (`de`, `en`), or `*` for the lexicon. */
  readonly lang: string;
  match(tokens: readonly SpeechToken[], i: number): SpeechMatch | null;
}

/**
 * One offset-map entry: the speech range `[s, e)` came from the display range `[s, e)`, which
 * runs from the start of one display token to the end of the same or a later token. The space
 * between two entries belongs to the entry before it, so the entries cover `speechText` without
 * gaps or overlaps.
 */
export interface SpeechMapEntry {
  speech: [number, number];
  display: [number, number];
}

export interface SpeechResult {
  /** The text to speak. No leading or trailing whitespace. */
  speechText: string;
  /** Entries in speech and display order. */
  map: SpeechMapEntry[];
}
