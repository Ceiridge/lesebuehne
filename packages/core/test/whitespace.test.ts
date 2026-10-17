import { describe, expect, test } from 'bun:test';
import { NORMALIZATION_WHITESPACE, normalizeBlocks, normalizeWhitespace } from '../src/index.ts';
import { mulberry32 } from './random.ts';

const D4 = ['\t', '\n', '\v', '\f', '\r', ' ', '\u0085', '\u2028', '\u2029'];
const TYPOGRAPHIC_SPACES = ['\u00A0', '\u202F', '\u2009'];
const stripD4 = (s: string): string => [...s].filter((c) => !D4.includes(c)).join('');

describe('02-1: whitespace normalisation', () => {
  test('the whitespace set is exactly the D4 set', () => {
    expect([...NORMALIZATION_WHITESPACE].sort()).toEqual([...D4].sort());
  });

  const table: Array<[step: string, input: string, output: string]> = [
    // (1) line endings to \n
    ['1: CRLF is one line break', 'a\r\nb', 'a b'],
    ['1: lone CR is one line break', 'a\rb', 'a b'],
    ['1: CRLF blank line splits blocks', 'a\r\n\r\nb', 'a\n\nb'],
    ['1: CR blank line splits blocks', 'a\r\rb', 'a\n\nb'],
    ['1: mixed line endings', 'a\r\n\nb\r\rc', 'a\n\nb\n\nc'],
    // (2) blocks at blank lines
    ['2: one blank line', 'a\n\nb', 'a\n\nb'],
    ['2: several blank lines', 'a\n\n\n\nb', 'a\n\nb'],
    ['2: blank line with spaces and tabs', 'a\n \t \nb', 'a\n\nb'],
    ['2: blank line with VT, FF, U+0085, U+2028, U+2029', 'a\n\v\f\u0085\u2028\u2029\nb', 'a\n\nb'],
    ['2: a line with a no-break space is not blank', 'a\n\u00A0\nb', 'a \u00A0 b'],
    // (3) collapse runs inside a block, trim the block
    ['3: run of spaces', 'a   b', 'a b'],
    ['3: single line break', 'a\nb', 'a b'],
    ['3: tab, VT, FF', 'a\tb\vc\fd', 'a b c d'],
    ['3: U+0085, U+2028, U+2029', 'a\u0085b\u2028c\u2029d', 'a b c d'],
    ['3: mixed run', 'a \t\n\u2028 b', 'a b'],
    ['3: trim the block', '  \t a b \u2029 ', 'a b'],
    ['3: no-break space kept', 'a\u00A0b', 'a\u00A0b'],
    ['3: narrow no-break space kept', 'z.\u202FB.', 'z.\u202FB.'],
    ['3: thin space kept', 'a\u2009b', 'a\u2009b'],
    ['3: typographic spaces are not trimmed', '\u00A0a\u2009', '\u00A0a\u2009'],
    ['3: typographic space next to collapsed run', 'a \u00A0  b', 'a \u00A0 b'],
    // (4) drop empty blocks, join with \n\n
    ['4: leading and trailing blank lines', '\n\n a \n\n\n b \n\n', 'a\n\nb'],
    ['4: empty input', '', ''],
    ['4: whitespace only', ' \n \r\n \t ', ''],
    ['4: three blocks', 'Eins.\n\nZwei\nDrei.\n \nVier.', 'Eins.\n\nZwei Drei.\n\nVier.'],
  ];

  for (const [step, input, output] of table) {
    test(`step ${step}`, () => {
      expect(normalizeWhitespace(input)).toBe(output);
    });
  }

  test('normalizeBlocks returns the blocks after step 3', () => {
    expect(normalizeBlocks('  Erster  Absatz\nmit Umbruch.\r\n\r\n\r\nZweiter.\n\n  \n')).toEqual([
      'Erster Absatz mit Umbruch.',
      'Zweiter.',
    ]);
    expect(normalizeBlocks(' \n\n ')).toEqual([]);
  });

  test('property: random strings change only in D4 whitespace characters', () => {
    const alphabet = [...D4, ...D4, ...TYPOGRAPHIC_SPACES, '\r\n', 'a', 'B', 'ä', '.', '„', '“', '’', '1', '😀', '\u00AD'];
    const random = mulberry32(0x5eed02);
    for (let n = 0; n < 2000; n++) {
      const length = Math.floor(random() * 40);
      let input = '';
      for (let i = 0; i < length; i++) input += alphabet[Math.floor(random() * alphabet.length)];
      const output = normalizeWhitespace(input);

      // Only D4 whitespace changes: every other character stays, in order.
      expect(stripD4(output)).toBe(stripD4(input));
      // The output holds no D4 whitespace except single spaces and the block separator \n\n.
      for (const c of output) if (D4.includes(c)) expect(c === ' ' || c === '\n').toBe(true);
      expect(output).not.toMatch(/ {2}|\n{3}| \n|\n | $|^ |^\n|\n$/);
      expect(output.replaceAll('\n\n', '')).not.toContain('\n');
      // Idempotent, and consistent with the block list.
      expect(normalizeWhitespace(output)).toBe(output);
      expect(normalizeBlocks(input).join('\n\n')).toBe(output);
      for (const c of TYPOGRAPHIC_SPACES) expect(output.split(c).length).toBe(input.split(c).length);
    }
  });
});
