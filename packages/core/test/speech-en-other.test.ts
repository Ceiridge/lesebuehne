import { describe, expect, test } from 'bun:test';
import { normalizeBlocks, segmentSentences, speechForText, speechRulesFor, tokenize } from '../src/index.ts';
import { expectValidMap } from './speech-check.ts';

function say(text: string, lang: string): string {
  const result = speechForText(text, lang);
  expectValidMap(tokenize(text, lang), result);
  return result.speechText;
}

describe('03-3: English small rule set, other languages identity', () => {
  test('English rules', () => {
    expect(speechRulesFor('en').map((r) => r.id)).toEqual(['en.abbreviation', 'en.roman']);
    expect(speechRulesFor('en-GB')).toBe(speechRulesFor('en'));
  });

  const english: Array<[string, string]> = [
    ['Fruit, e.g. apples.', 'Fruit, for example apples.'],
    ['Fruit, e. g. apples.', 'Fruit, for example apples.'],
    ['One fruit, i.e. an apple.', 'One fruit, that is an apple.'],
    ['Mr. Smith met Dr. Watson.', 'Mister Smith met Doctor Watson.'],
    ['Mrs. Hudson and Ms. Adler.', 'Missus Hudson and Miz Adler.'],
    ['Tea, cakes, etc.', 'Tea, cakes, et cetera.'],
    ['Tea, cakes, etc. were served.', 'Tea, cakes, et cetera were served.'],
    ['Chapter IV', 'Chapter 4'],
    ['CHAPTER XII.', 'CHAPTER 12.'],
    ['Part II begins.', 'Part 2 begins.'],
    ['Book I', 'Book 1'],
    ['He saw IV men.', 'He saw IV men.'],
    ['I. Kant wrote.', 'I. Kant wrote.'],
    ['XIV.', 'XIV.'],
  ];
  for (const [input, expected] of english) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(say(input, 'en')).toBe(expected);
    });
  }

  test('English numbers are left to the voice', () => {
    for (const text of [
      'He paid 1,234 dollars on 3 May 1784.',
      'It was 50% of 2-3 items, 3.5 kg, the 3rd time, §5 & 2+2 -- 1914–1918.',
      'In 1800 there were 1000000000000 stars.',
    ]) {
      expect(say(text, 'en')).toBe(text);
    }
  });

  test('a region tag gets the rules of its language', () => {
    expect(say('Dr. Watson.', 'en-US')).toBe('Doctor Watson.');
    expect(say('Prof. Kant, z. B. 3. Kapitel.', 'de-AT')).toBe('Professor Kant, zum Beispiel drittes Kapitel.');
  });

  describe('other languages: identity map', () => {
    const samples: Array<[string, string]> = [
      ['fr', 'M. Dupont a vu 3 chats, p. ex. le 3e, à 50 % ! Chapitre IV.'],
      ['es', 'El Sr. García tiene 1.234 libros (p. ej. 3). Capítulo II.'],
      ['it', 'Il dott. Rossi, 2-3 volte -- nel 1784.'],
      ['ja', '吾輩は猫である。名前はまだ無い。'],
      ['xx-invalid', 'Prof. Kant z. B. 3. Kapitel 1784.'],
    ];
    for (const [lang, text] of samples) {
      test(`${lang}: speech = display`, () => {
        expect(speechRulesFor(lang)).toEqual([]);
        const block = normalizeBlocks(text)[0] ?? '';
        for (const sentence of segmentSentences(block, lang)) {
          const tokens = tokenize(sentence.text, lang, { offset: sentence.start });
          const result = speechForText(sentence.text, lang, { offset: sentence.start });
          expectValidMap(tokens, result);
          // The sentence text includes its trailing whitespace; speech text does not.
          expect(result.speechText).toBe(sentence.text.trimEnd());
          // Every entry speaks exactly its display text.
          for (const e of result.map) {
            expect(result.speechText.slice(...e.speech).trimEnd()).toBe(block.slice(...e.display));
          }
          expect(result.map.length).toBe(tokens.length);
        }
      });
    }

    test('a lexicon does not apply to other languages', () => {
      const lexicon = { entries: [{ text: 'Kant', speech: 'Kannt' }] };
      expect(speechForText('Kant a écrit.', 'fr', { lexicon }).speechText).toBe('Kant a écrit.');
    });
  });
});
