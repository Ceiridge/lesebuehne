import { describe, expect, test } from 'bun:test';
import { segmentSentences, tokenize } from '../src/index.ts';

const plainSentences = (text: string, lang: string): string[] =>
  [...new Intl.Segmenter(lang, { granularity: 'sentence' }).segment(text)].map((s) => s.segment);

describe('02-4: tokens and other languages', () => {
  test('R3 word probe: word-like tokens', () => {
    const tokens = tokenize('Selbstverschuldete Unmündigkeit, z. B. 1784.', 'de');
    expect(tokens.filter((t) => t.wordLike).map((t) => t.text)).toEqual([
      'Selbstverschuldete',
      'Unmündigkeit',
      'z',
      'B',
      '1784',
    ]);
    expect(tokens.map((t) => [t.text, t.wordLike])).toEqual([
      ['Selbstverschuldete', true],
      ['Unmündigkeit', true],
      [',', false],
      ['z', true],
      ['.', false],
      ['B', true],
      ['.', false],
      ['1784', true],
      ['.', false],
    ]);
  });

  test('tokens carry display offsets and a running index', () => {
    const text = 'Er sagte: „Wie geht’s?“';
    const tokens = tokenize(text, 'de');
    expect(tokens.map((t) => t.index)).toEqual(tokens.map((_, i) => i));
    for (const t of tokens) expect(text.slice(t.start, t.end)).toBe(t.text);
    expect(tokens.find((t) => t.text === 'geht’s')).toEqual({ index: 5, text: 'geht’s', start: 15, end: 21, wordLike: true });
  });

  test('offset and firstIndex place the tokens of a sentence in its block', () => {
    const block = 'Es regnet. Dr. Müller kam.';
    const [first, second] = segmentSentences(block, 'de');
    expect(second?.text).toBe('Dr. Müller kam.');
    const firstTokens = tokenize(first?.text ?? '', 'de', { offset: first?.start ?? 0 });
    const tokens = tokenize(second?.text ?? '', 'de', { offset: second?.start ?? 0, firstIndex: firstTokens.length });
    expect(tokens.map((t) => [t.index, t.text, t.start, t.end])).toEqual([
      [3, 'Dr', 11, 13],
      [4, '.', 13, 14],
      [5, 'Müller', 15, 21],
      [6, 'kam', 22, 25],
      [7, '.', 25, 26],
    ]);
    for (const t of [...firstTokens, ...tokens]) expect(block.slice(t.start, t.end)).toBe(t.text);
  });

  test('no token is whitespace, typographic spaces included', () => {
    const text = 'a \u00A0b\u2009c\u202Fd\t e\u3000f';
    const tokens = tokenize(text, 'de');
    expect(tokens.map((t) => t.text)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(tokens.every((t) => t.wordLike)).toBe(true);
  });

  test('tokens equal the plain word segmenter minus whitespace, in any language', () => {
    const samples: Array<[string, string]> = [
      ['fr', "L'homme est né libre, et partout il est dans les fers."],
      ['it', 'Nel mezzo del cammin di nostra vita.'],
      ['ja', '吾輩は猫である。名前はまだ無い。'],
      ['en', 'Mr. Smith’s dog, e.g. Rex, barked.'],
    ];
    for (const [lang, text] of samples) {
      const plain = [...new Intl.Segmenter(lang, { granularity: 'word' }).segment(text)]
        .filter((s) => !/^\s+$/u.test(s.segment))
        .map((s) => ({ text: s.segment, start: s.index, wordLike: s.isWordLike === true }));
      expect(tokenize(text, lang).map((t) => ({ text: t.text, start: t.start, wordLike: t.wordLike }))).toEqual(plain);
    }
  });

  test('other languages use the plain sentence segmenter without corrections', () => {
    const samples: Array<[string, string]> = [
      ['fr', 'M. Dupont est venu. Il est parti le 3. Mai. « Viens ! » dit-il.'],
      ['nl', 'Dr. Jansen kwam, d. h. hij kwam. Wat nu? zei hij.'],
      ['it', 'Er kam am 3. Mai. Dr. Rossi è arrivato... e poi?'],
      ['xx', 'Dr. Müller kam am 3. Mai. z. B. hier.'],
    ];
    for (const [lang, text] of samples) {
      expect(segmentSentences(text, lang).map((s) => s.text)).toEqual(plainSentences(text, lang));
    }
    // The same text in German is corrected, so the plain result above really is uncorrected.
    expect(segmentSentences('Dr. Müller kam am 3. Mai.', 'de').length).toBe(1);
    expect(plainSentences('Dr. Müller kam am 3. Mai.', 'fr').length).toBeGreaterThan(1);
  });
});
