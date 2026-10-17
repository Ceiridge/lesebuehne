import { describe, expect, test } from 'bun:test';
import { LexiconSchema, parseLexicon, safeParseLexicon, speechForText, tokenize, type Lexicon } from '../src/index.ts';
import { expectValidMap } from './speech-check.ts';

function say(text: string, lang: string, lexicon: Lexicon): string {
  const result = speechForText(text, lang, { lexicon });
  expectValidMap(tokenize(text, lang), result);
  return result.speechText;
}

describe('03-2: lexicon overrides rules, zod-validated structure', () => {
  test('an entry overrides the abbreviation table', () => {
    const lexicon = parseLexicon({ entries: [{ text: 'z. B.', speech: 'zum Exempel' }] });
    expect(say('Das gilt z. B. hier.', 'de', lexicon)).toBe('Das gilt zum Exempel hier.');
    // without the lexicon the table applies
    expect(speechForText('Das gilt z. B. hier.', 'de').speechText).toBe('Das gilt zum Beispiel hier.');
  });

  test('an entry matches the display tokens whatever the spacing (z.B. ↔ z. B.)', () => {
    const lexicon = parseLexicon({ entries: [{ text: 'z. B.', speech: 'zum Exempel' }] });
    expect(say('Das gilt z.B. hier.', 'de', lexicon)).toBe('Das gilt zum Exempel hier.');
  });

  test('an entry overrides the year, ordinal, cardinal and Roman rules', () => {
    const lexicon = parseLexicon({
      entries: [
        { text: '1784', speech: 'anno siebzehnvierundachtzig' },
        { text: '3.', speech: 'Nummer drei' },
        { text: '12', speech: 'ein Dutzend' },
        { text: 'IV', speech: 'römisch vier' },
      ],
    });
    expect(say('Am 3. Mai 1784.', 'de', lexicon)).toBe('Am Nummer drei Mai anno siebzehnvierundachtzig.');
    expect(say('Es sind 12 Eier.', 'de', lexicon)).toBe('Es sind ein Dutzend Eier.');
    expect(say('Kapitel IV', 'de', lexicon)).toBe('Kapitel römisch vier');
  });

  test('pronunciation of names; the longest entry wins; case', () => {
    const lexicon = parseLexicon({
      entries: [
        { text: 'Kant', speech: 'Kannt' },
        { text: 'Prof. Kant', speech: 'Professor Immanuel Kannt' },
        { text: 'aufklärung', speech: 'Auf-klärung', ignoreCase: true },
      ],
    });
    expect(say('Prof. Kant und Kant.', 'de', lexicon)).toBe('Professor Immanuel Kannt und Kannt.');
    expect(say('Die Aufklärung.', 'de', lexicon)).toBe('Die Auf-klärung.');
    expect(say('Die KANT-Schule.', 'de', lexicon)).toBe('Die KANT-Schule.');
  });

  test('an entry with a language applies only to that language (primary subtag)', () => {
    const lexicon = parseLexicon({
      entries: [
        { text: 'Dr.', speech: 'Doc', lang: 'en' },
        { text: 'Dr.', speech: 'Herr Doktor', lang: 'de-AT' },
      ],
    });
    expect(say('Dr. Who.', 'en-GB', lexicon)).toBe('Doc Who.');
    expect(say('Dr. Who.', 'de', lexicon)).toBe('Herr Doktor Who.');
  });

  test('an English entry overrides the English table', () => {
    const lexicon = parseLexicon({ entries: [{ text: 'e.g.', speech: 'for instance' }] });
    expect(say('Fruit, e.g. apples.', 'en', lexicon)).toBe('Fruit, for instance apples.');
  });

  test('valid structures parse; strings are trimmed', () => {
    expect(parseLexicon({ entries: [] })).toEqual({ entries: [] });
    expect(parseLexicon({ entries: [{ text: ' Goethe ', speech: ' Göte ' }] })).toEqual({
      entries: [{ text: 'Goethe', speech: 'Göte' }],
    });
    expect(LexiconSchema.safeParse({ entries: [{ text: 'a', speech: 'b', lang: 'de', ignoreCase: false }] }).success).toBe(true);
  });

  const invalid: Array<[string, unknown]> = [
    ['not an object', 'Goethe=Göte'],
    ['missing entries', {}],
    ['entries is not an array', { entries: { text: 'a', speech: 'b' } }],
    ['missing speech', { entries: [{ text: 'Goethe' }] }],
    ['missing text', { entries: [{ speech: 'Göte' }] }],
    ['empty text', { entries: [{ text: '', speech: 'Göte' }] }],
    ['blank text', { entries: [{ text: '   ', speech: 'Göte' }] }],
    ['blank speech', { entries: [{ text: 'Goethe', speech: ' \n ' }] }],
    ['speech not a string', { entries: [{ text: 'Goethe', speech: 42 }] }],
    ['unknown entry key', { entries: [{ text: 'Goethe', speech: 'Göte', note: 'x' }] }],
    ['unknown top-level key', { entries: [], version: 2 }],
    ['bad language tag', { entries: [{ text: 'Goethe', speech: 'Göte', lang: 'deutsch!' }] }],
    ['ignoreCase not boolean', { entries: [{ text: 'Goethe', speech: 'Göte', ignoreCase: 'yes' }] }],
    [
      'duplicate entry',
      {
        entries: [
          { text: 'Goethe', speech: 'Göte' },
          { text: ' Goethe', speech: 'Gö-te' },
        ],
      },
    ],
  ];
  for (const [name, input] of invalid) {
    test(`invalid: ${name}`, () => {
      expect(safeParseLexicon(input).success).toBe(false);
      expect(() => parseLexicon(input)).toThrow();
    });
  }

  test('speech normalisation rejects an unvalidated, invalid lexicon', () => {
    const bad = { entries: [{ text: '', speech: 'x' }] } as unknown as Lexicon;
    expect(() => speechForText('Text.', 'de', { lexicon: bad })).toThrow();
  });
});
