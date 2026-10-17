import { primaryLanguage } from '../text/segmenters.ts';
import { tokenize } from '../text/tokens.ts';
import { lexiconRule, type Lexicon } from './lexicon.ts';
import { ENGLISH_SPEECH_RULES } from './rules-en.ts';
import { GERMAN_SPEECH_RULES } from './rules-de.ts';
import type { SpeechMapEntry, SpeechResult, SpeechRule, SpeechToken } from './types.ts';

const RULES: ReadonlyMap<string, readonly SpeechRule[]> = new Map([
  ['de', GERMAN_SPEECH_RULES],
  ['en', ENGLISH_SPEECH_RULES],
]);
const NO_RULES: readonly SpeechRule[] = Object.freeze([]);

/** The speech rules of a language (by primary subtag). Other languages have none: speech = display. */
export function speechRulesFor(lang: string): readonly SpeechRule[] {
  return RULES.get(primaryLanguage(lang)) ?? NO_RULES;
}

export interface SpeechOptions {
  /** Per-book pronunciation lexicon; applies only to languages with rules. */
  lexicon?: Lexicon;
}

/**
 * Speech text for the display tokens of one sentence, with an offset map back to display token
 * ranges. `noteRef` tokens are never spoken. Tokens are not changed.
 *
 * Pieces are joined with one space where the display has whitespace before a token, and without
 * one where the token follows its predecessor directly. A pause comma (`--` → `,`) attaches to
 * the word before it; a `spaced` match (a symbol spoken as a word: `50%`) always gets spaces.
 */
export function normalizeSpeech(
  tokens: readonly SpeechToken[],
  lang: string,
  options: SpeechOptions = {},
): SpeechResult {
  const base = speechRulesFor(lang);
  const rules = options.lexicon && base.length > 0 ? [lexiconRule(options.lexicon, lang), ...base] : base;

  // Whitespace before each spoken token, judged against the token directly before it.
  const spoken: SpeechToken[] = [];
  const spaceBefore: boolean[] = [];
  const position: number[] = [];
  for (const [k, t] of tokens.entries()) {
    if (t.noteRef) continue;
    const prev = tokens[k - 1];
    spaceBefore.push(prev !== undefined && prev.end !== t.start);
    spoken.push(t);
    position.push(k);
  }
  // A match may not reach across a noteRef token.
  const contiguous = (i: number, consume: number): boolean =>
    (position[i + consume - 1] ?? -1) - (position[i] ?? 0) === consume - 1;

  let speechText = '';
  const map: SpeechMapEntry[] = [];
  let forceSpace = false; // after a pause comma
  let spacedBefore = false; // after a `spaced` match: space before a following word
  for (let i = 0; i < spoken.length; ) {
    let consume = 1;
    let speech = spoken[i]?.text ?? '';
    let spaced = false;
    for (const rule of rules) {
      const m = rule.match(spoken, i);
      if (m && contiguous(i, m.consume)) {
        consume = m.consume;
        speech = m.speech;
        spaced = m.spaced === true;
        break;
      }
    }
    const pause = speech === ',';
    const wordAfterSpaced = spacedBefore && spoken[i]?.wordLike === true;
    if (speechText !== '' && !pause && (forceSpace || spaced || wordAfterSpaced || spaceBefore[i])) speechText += ' ';
    const first = spoken[i];
    const last = spoken[i + consume - 1];
    if (first && last) {
      const prev = map.at(-1);
      if (prev) prev.speech[1] = speechText.length;
      map.push({ speech: [speechText.length, 0], display: [first.start, last.end] });
    }
    speechText += speech;
    forceSpace = pause;
    spacedBefore = spaced;
    i += consume;
  }
  const lastEntry = map.at(-1);
  if (lastEntry) lastEntry.speech[1] = speechText.length;
  return { speechText, map };
}

/** `normalizeSpeech` over the tokens of `text` (display offsets start at `offset`). */
export function speechForText(
  text: string,
  lang: string,
  options: SpeechOptions & { offset?: number } = {},
): SpeechResult {
  const { offset, ...rest } = options;
  return normalizeSpeech(tokenize(text, lang, offset !== undefined ? { offset } : {}), lang, rest);
}
