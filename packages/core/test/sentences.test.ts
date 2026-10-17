import { describe, expect, test } from 'bun:test';
import { segmentSentences } from '../src/index.ts';
import { mulberry32 } from './random.ts';
import { R3_PROBE_TEXT, SENTENCE_TABLE } from './sentence-table.ts';

const texts = (text: string, lang: string): string[] => segmentSentences(text, lang).map((s) => s.text);

describe('02-2: sentence segmentation table (de/en)', () => {
  test('the table has at least 40 rows', () => {
    expect(SENTENCE_TABLE.length).toBeGreaterThanOrEqual(40);
  });

  test('the first row is the R3 probe text', () => {
    expect(SENTENCE_TABLE[0]?.text).toBe(R3_PROBE_TEXT);
  });

  for (const [i, r] of SENTENCE_TABLE.entries()) {
    test(`row ${i + 1} [${r.lang}] ${r.note}`, () => {
      expect(texts(r.text, r.lang)).toEqual(r.expected);
    });
  }

  test('region subtags use the rules of their language', () => {
    expect(texts('Dr. Müller kam am 3. Mai.', 'de-AT')).toEqual(['Dr. Müller kam am 3. Mai.']);
    expect(texts('Dr. Müller kam am 3. Mai.', 'DE_de')).toEqual(['Dr. Müller kam am 3. Mai.']);
    expect(texts('Mr. Smith arrived. He sat down.', 'en-GB')).toEqual(['Mr. Smith arrived. ', 'He sat down.']);
  });

  test('English uses its own smaller list, not the German one', () => {
    // "z. B." and the ordinal before a month are German corrections only.
    expect(texts('Er kam am 3. Mai.', 'en')).toEqual(['Er kam am 3. ', 'Mai.']);
  });
});

describe('02-3: sentences concatenate back to the paragraph', () => {
  test('every 02-2 table row', () => {
    for (const r of SENTENCE_TABLE) {
      const sentences = segmentSentences(r.text, r.lang);
      expect(sentences.map((s) => s.text).join('')).toBe(r.text);
    }
  });

  const pieces = [
    'Das', 'ist', 'z.', 'B.', 'Dr.', 'Mr.', 'e.g.', 'S.', '12', '3.', 'Mai', 'Auflage', 'I.', 'Kant', 'geht’s', 'dann',
    'Und', '.', '!', '?', '...', '…', ',', '„', '“', '»', '«', '"', '‚', '‘', '’', '(', ')', ' ', ' ', ' ', '  ', '\u00A0',
    '\u2009', '\n', 'ä', '😀',
  ];

  test('property: random paragraphs in de, en and other languages', () => {
    const random = mulberry32(0x5eed03);
    for (const lang of ['de', 'en', 'fr', 'ja']) {
      for (let n = 0; n < 600; n++) {
        const length = Math.floor(random() * 30);
        let text = '';
        for (let i = 0; i < length; i++) text += pieces[Math.floor(random() * pieces.length)];
        const sentences = segmentSentences(text, lang);
        expect(sentences.map((s) => s.text).join('')).toBe(text);
        let at = 0;
        for (const s of sentences) {
          expect(s.start).toBe(at);
          expect(s.end).toBeGreaterThan(s.start);
          expect(text.slice(s.start, s.end)).toBe(s.text);
          at = s.end;
        }
        expect(at).toBe(text.length);
      }
    }
  });
});
