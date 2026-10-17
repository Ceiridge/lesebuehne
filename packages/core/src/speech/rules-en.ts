import { abbreviationRule, type Abbreviation } from './abbreviations.ts';
import { romanInContext } from './rules-de.ts';
import type { SpeechRule } from './types.ts';

/** English abbreviation table (small by design: numbers are left to the voice). */
export const ENGLISH_ABBREVIATIONS: readonly Abbreviation[] = [
  { text: 'e. g.', speech: 'for example' },
  { text: 'i. e.', speech: 'that is' },
  { text: 'etc.', speech: 'et cetera' },
  { text: 'cf.', speech: 'compare' },
  { text: 'vs.', speech: 'versus' },
  { text: 'approx.', speech: 'approximately' },
  { text: 'Mr.', speech: 'Mister' },
  { text: 'Mrs.', speech: 'Missus' },
  { text: 'Ms.', speech: 'Miz' },
  { text: 'Dr.', speech: 'Doctor' },
  { text: 'Prof.', speech: 'Professor' },
  { text: 'Jr.', speech: 'Junior' },
  { text: 'Sr.', speech: 'Senior' },
  // Also ordinary words or initials: only before a number.
  { text: 'p.', speech: 'page', when: 'beforeNumber' },
  { text: 'pp.', speech: 'pages', when: 'beforeNumber' },
  { text: 'No.', speech: 'number', when: 'beforeNumber' },
  { text: 'vol.', speech: 'volume', when: 'beforeNumber' },
  { text: 'ch.', speech: 'chapter', when: 'beforeNumber' },
  { text: 'fig.', speech: 'figure', when: 'beforeNumber' },
];

/** Roman numerals after Chapter/Part/Book become digits (`Chapter IV` → `Chapter 4`). */
const roman: SpeechRule = {
  id: 'en.roman',
  lang: 'en',
  match(tokens, i) {
    const value = romanInContext(tokens, i, false);
    return value === undefined ? null : { consume: 1, speech: String(value) };
  },
};

/** English speech rules in priority order (the per-book lexicon comes before them). */
export const ENGLISH_SPEECH_RULES: readonly SpeechRule[] = Object.freeze([
  abbreviationRule('en.abbreviation', 'en', ENGLISH_ABBREVIATIONS),
  roman,
]);
