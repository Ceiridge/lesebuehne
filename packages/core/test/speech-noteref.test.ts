import { describe, expect, test } from 'bun:test';
import { normalizeSpeech, parseLexicon, tokenize, type SpeechToken } from '../src/index.ts';
import { expectValidMap } from './speech-check.ts';

/** Tokens of `text` with the tokens at `noteRefStarts` (display offsets) flagged `noteRef`. */
function tokensWithNoteRefs(text: string, lang: string, noteRefStarts: number[]): SpeechToken[] {
  return tokenize(text, lang).map((t) => (noteRefStarts.includes(t.start) ? { ...t, noteRef: true } : t));
}

function overlapsNoteRef(tokens: readonly SpeechToken[], display: readonly [number, number]): boolean {
  return tokens.some((t) => t.noteRef === true && t.start < display[1] && display[0] < t.end);
}

describe('03-5: noteRef tokens are never spoken', () => {
  const cases: Array<[lang: string, text: string, noteRefStart: number, expected: string]> = [
    ['de', 'Das Wort 1 steht hier.', 9, 'Das Wort steht hier.'],
    ['de', 'Es geschah 1784 1.', 16, 'Es geschah eintausendsiebenhundertvierundachtzig.'],
    ['de', 'Am 3. Mai 2 kam er.', 10, 'Am dritten Mai kam er.'],
    ['en', 'See chapter 12 here.', 12, 'See chapter here.'],
    ['fr', 'Le mot 3 est ici.', 7, 'Le mot est ici.'],
  ];
  for (const [lang, text, at, expected] of cases) {
    test(`${lang}: ${JSON.stringify(text)} with a noteRef at ${at}`, () => {
      const tokens = tokensWithNoteRefs(text, lang, [at]);
      expect(tokens.some((t) => t.noteRef)).toBe(true);
      const result = normalizeSpeech(tokens, lang);
      expect(result.speechText).toBe(expected);
      expect(result.map.some((e) => overlapsNoteRef(tokens, e.display))).toBe(false);
      expectValidMap(tokens, result);
    });
  }

  test('noteRef tokens made by splitting a word token (Wort¹)', () => {
    const tokens: SpeechToken[] = [
      { text: 'Wort', start: 0, end: 4, wordLike: true },
      { text: '1', start: 4, end: 5, wordLike: true, noteRef: true },
      { text: '.', start: 5, end: 6, wordLike: false },
      { text: 'Weiter', start: 7, end: 13, wordLike: true },
      { text: '2', start: 13, end: 14, wordLike: true, noteRef: true },
      { text: 'geht', start: 15, end: 19, wordLike: true },
    ];
    const result = normalizeSpeech(tokens, 'de');
    expect(result.speechText).toBe('Wort. Weiter geht');
    expect(result.map.map((e) => e.display)).toEqual([
      [0, 4],
      [5, 6],
      [7, 13],
      [15, 19],
    ]);
    expectValidMap(tokens, result);
  });

  test('a lexicon entry for the label does not make it spoken', () => {
    const tokens = tokensWithNoteRefs('Das Wort 1 hier.', 'de', [9]);
    const lexicon = parseLexicon({ entries: [{ text: '1', speech: 'eins' }] });
    expect(normalizeSpeech(tokens, 'de', { lexicon }).speechText).toBe('Das Wort hier.');
  });

  test('only noteRef tokens: empty speech, empty map', () => {
    for (const lang of ['de', 'en', 'fr']) {
      const tokens = tokensWithNoteRefs('12', lang, [0]);
      expect(normalizeSpeech(tokens, lang)).toEqual({ speechText: '', map: [] });
    }
    expect(normalizeSpeech([], 'de')).toEqual({ speechText: '', map: [] });
  });
});
