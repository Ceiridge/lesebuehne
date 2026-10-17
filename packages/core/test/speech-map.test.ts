import { describe, expect, test } from 'bun:test';
import { normalizeBlocks, normalizeSpeech, segmentSentences, tokenize, type SpeechToken } from '../src/index.ts';
import { ENGLISH_ABBREVIATIONS } from '../src/speech/rules-en.ts';
import { GERMAN_ABBREVIATIONS, GERMAN_NOUN_GENDERS } from '../src/speech/rules-de.ts';
import { mulberry32 } from './random.ts';
import { mapProblems } from './speech-check.ts';

/** Runs speech normalisation over every sentence of `source` and collects map problems. */
function check(source: string, lang: string, noteRefs?: () => boolean): string[] {
  const problems: string[] = [];
  for (const block of normalizeBlocks(source)) {
    const blockBefore = block.slice();
    for (const sentence of segmentSentences(block, lang)) {
      const tokens: SpeechToken[] = tokenize(sentence.text, lang, { offset: sentence.start }).map((t) =>
        noteRefs?.() ? { ...t, noteRef: true } : t,
      );
      const snapshot = structuredClone(tokens);
      const result = normalizeSpeech(tokens, lang);
      for (const p of mapProblems(tokens, result)) problems.push(`${lang} ${JSON.stringify(sentence.text)}: ${p}`);
      for (const e of result.map) {
        if (e.display[0] < sentence.start || e.display[1] > sentence.end) {
          problems.push(`${lang} ${JSON.stringify(sentence.text)}: display ${e.display} outside the sentence`);
        }
      }
      // Display text unchanged: tokens are untouched and still slice the block.
      expect(tokens).toEqual(snapshot);
      for (const t of tokens) {
        if (block.slice(t.start, t.end) !== t.text) problems.push(`token ${t.start}..${t.end} no longer slices the block`);
      }
      if (/\S/u.test(sentence.text) && result.speechText !== result.speechText.trim()) {
        problems.push(`${lang} ${JSON.stringify(sentence.text)}: speech has outer whitespace`);
      }
    }
    expect(block).toBe(blockBefore);
  }
  return problems;
}

const DE_FRAGMENTS = [
  'Am 3. Mai 1784 kam er.',
  'Vom 3. bis 5. Mai.',
  'Das 3. und 4. Kapitel, z. B. 2-mal -- dann.',
  'Kapitel IV.',
  'XIV.',
  'I. Kant schrieb.',
  'Siehe S. 12-15 ff.',
  'Nach §§ 3 und § 5 gilt: 50 % & 2+2.',
  'Es sind 1.234.567 bzw. 10 000 oder 3,5 Liter.',
  'Er starb 1500 v. Chr. in Rom.',
  'Der 100-Meter-Lauf im 18. Jh.',
  '„Gehst du?“ – „Ja.“',
  'Er kam (wie immer!) zu spät.',
  'Agent 007 kam um 12:30 Uhr.',
  'Prof. Dr. Müller u. a. kamen usw.',
  'Haupt- und Nebensatz.',
];
const EN_FRAGMENTS = [
  'Fruit, e.g. apples, i.e. food.',
  'Mr. Smith met Dr. Watson, etc.',
  'Chapter IV.',
  'Part II, Book XII.',
  'He paid 1,234 dollars on 3 May 1784.',
  'It was 50% of 2-3 items -- 1914–1918.',
  'I. Kant wrote.',
];
const WORDS = ['Haus', 'und', 'der', 'die', 'das', 'Kapitel', 'Mai', 'Band', 'Teil', 'house', 'the', 'Chapter', 'Part', 'am'];
const PIECES = ['.', ',', '-', '--', '–', '%', '§', '&', '+', '(', ')', '„', '“', '"', '!', '?', '…', ':', ';'];

function randomText(rand: () => number, fragments: readonly string[]): string {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
  const parts: string[] = [];
  const n = 1 + Math.floor(rand() * 12);
  for (let k = 0; k < n; k++) {
    const r = rand();
    if (r < 0.3) parts.push(pick(fragments));
    else if (r < 0.55) parts.push(pick(WORDS));
    else if (r < 0.7) parts.push(String(Math.floor(rand() ** 3 * 2_000_000_000_000)));
    else if (r < 0.78) parts.push(String(1000 + Math.floor(rand() * 1100)));
    else if (r < 0.84) parts.push(pick(['I', 'II', 'IV', 'IX', 'XIV', 'MCM', 'IIII', 'CD']));
    else parts.push(pick(PIECES));
  }
  // Join with spaces, nothing, or a typographic space.
  return parts.reduce((acc, p) => acc + pick([' ', ' ', '', ' ', ' ']) + p, '');
}

describe('03-4: offset map property', () => {
  test('German abbreviation table: every entry, its capital variant and spacing variants', () => {
    const problems: string[] = [];
    expect(GERMAN_ABBREVIATIONS.length).toBeGreaterThan(40);
    for (const a of GERMAN_ABBREVIATIONS) {
      const tight = a.text.replace(/\s+/gu, '');
      for (const form of [a.text, tight, a.text.charAt(0).toUpperCase() + a.text.slice(1)]) {
        problems.push(...check(`Es gilt ${form} 12 und ${form}`, 'de'));
      }
    }
    expect(problems).toEqual([]);
  });

  test('German ordinal nouns × determiners, years, cardinals', () => {
    const problems: string[] = [];
    const determiners = ['', 'der ', 'die ', 'das ', 'den ', 'dem ', 'am ', 'im ', 'zum ', 'ein ', 'eine ', 'einem ', 'in ', 'bis '];
    for (const noun of GERMAN_NOUN_GENDERS.keys()) {
      for (const d of determiners) problems.push(...check(`${d}3. ${noun} und ${d}21. ${noun}.`, 'de'));
    }
    for (let y = 1090; y <= 2010; y += 7) problems.push(...check(`Im Jahr ${y} und seit ${y}, um ${y}-${y + 4}.`, 'de'));
    for (const n of [0, 1, 7, 19, 99, 100, 1001, 99_999, 1_000_000, 999_999_999_999, 1_000_000_000_000]) {
      problems.push(...check(`Es sind ${n} und ${n.toLocaleString('de-DE')} Stück, ${n}-mal.`, 'de'));
    }
    expect(problems).toEqual([]);
  });

  test('English abbreviation table and Roman numerals', () => {
    const problems: string[] = [];
    for (const a of ENGLISH_ABBREVIATIONS) problems.push(...check(`It was ${a.text} 12 and ${a.text}`, 'en'));
    for (const r of ['I', 'II', 'IV', 'IX', 'XIV', 'XL', 'MCMXC']) {
      for (const w of ['Chapter', 'Part', 'Book']) problems.push(...check(`${w} ${r}. ${w} ${r}`, 'en'));
    }
    expect(problems).toEqual([]);
  });

  test('synthetic de/en corpus (seeded)', () => {
    const rand = mulberry32(0x5eec03);
    const problems: string[] = [];
    let sentences = 0;
    for (let k = 0; k < 400; k++) {
      for (const [lang, fragments] of [
        ['de', DE_FRAGMENTS],
        ['en', EN_FRAGMENTS],
      ] as const) {
        const text = randomText(rand, fragments);
        sentences += segmentSentences(normalizeBlocks(text)[0] ?? '', lang).length;
        problems.push(...check(text, lang));
        // The same text with random noteRef tokens.
        problems.push(...check(text, lang, () => rand() < 0.1));
      }
    }
    expect(sentences).toBeGreaterThan(800);
    expect(problems.slice(0, 20)).toEqual([]);
  });

  test('other languages keep the property', () => {
    const rand = mulberry32(7);
    const problems: string[] = [];
    for (let k = 0; k < 100; k++) problems.push(...check(randomText(rand, [...DE_FRAGMENTS, ...EN_FRAGMENTS]), 'fr'));
    expect(problems).toEqual([]);
  });
});
