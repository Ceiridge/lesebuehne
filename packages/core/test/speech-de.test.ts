import { describe, expect, test } from 'bun:test';
import { cardinalDe, ordinalDe, speechForText, speechRulesFor, tokenize, yearDe } from '../src/index.ts';
import { expectValidMap } from './speech-check.ts';

/** Speech text of `text` in German, with the offset map checked on the way. */
function say(text: string): string {
  const tokens = tokenize(text, 'de');
  const result = speechForText(text, 'de');
  expectValidMap(tokens, result);
  return result.speechText;
}

function rows(table: ReadonlyArray<readonly [string, string]>): void {
  for (const [input, expected] of table) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(say(input)).toBe(expected);
    });
  }
}

describe('03-1: German rule tables', () => {
  test('the rules are an ordered, modular list per language', () => {
    const ids = speechRulesFor('de').map((r) => r.id);
    expect(ids).toEqual([
      'de.abbreviation',
      'de.ordinal',
      'de.roman',
      'de.hyphen',
      'de.year',
      'de.special',
      'de.cardinal',
    ]);
    expect(speechRulesFor('de').every((r) => r.lang === 'de')).toBe(true);
    expect(speechRulesFor('de-AT')).toBe(speechRulesFor('de'));
  });

  describe('abbreviations', () => {
    rows([
      ['Das gilt z. B. hier.', 'Das gilt zum Beispiel hier.'],
      ['Das gilt z.B. hier.', 'Das gilt zum Beispiel hier.'],
      ['Das gilt z. B. hier.', 'Das gilt zum Beispiel hier.'],
      ['Z. B. dies.', 'Zum Beispiel dies.'],
      ['Prof. Kant lehrte.', 'Professor Kant lehrte.'],
      ['Dr. Müller kam.', 'Doktor Müller kam.'],
      ['Das heißt d. h. nichts.', 'Das heißt das heißt nichts.'],
      ['Er kam i. d. R. spät.', 'Er kam in der Regel spät.'],
      ['Vgl. Kap. 3.', 'Vergleiche Kapitel drei.'],
      ['ca. 20 Leute, ggf. mehr, bzw. weniger', 'circa zwanzig Leute, gegebenenfalls mehr, beziehungsweise weniger'],
      ['Er kaufte Brot usw.', 'Er kaufte Brot und so weiter.'],
      ['Brot, Milch etc. kaufte er.', 'Brot, Milch et cetera kaufte er.'],
      ['Siehe S. 12.', 'Siehe Seite zwölf.'],
      ['Er sah S. an.', 'Er sah S. an.'],
      ['Art. 5 gilt.', 'Artikel fünf gilt.'],
      ['Er tat es auf seine Art.', 'Er tat es auf seine Art.'],
      ['Siehe S. 12 ff.', 'Siehe Seite zwölf folgende.'],
      ['Er starb 1050 n. Chr.', 'Er starb eintausendfünfzig nach Christus.'],
      ['Nr. 7 und St. Gallen', 'Nummer sieben und Sankt Gallen'],
      ['Das kostet 5 Mio. Euro.', 'Das kostet fünf Millionen Euro.'],
    ]);
  });

  describe('cardinals 0 – 999 999 999 999', () => {
    const table: Array<[number, string]> = [
      [0, 'null'],
      [1, 'eins'],
      [7, 'sieben'],
      [11, 'elf'],
      [12, 'zwölf'],
      [16, 'sechzehn'],
      [17, 'siebzehn'],
      [21, 'einundzwanzig'],
      [30, 'dreißig'],
      [99, 'neunundneunzig'],
      [100, 'einhundert'],
      [101, 'einhunderteins'],
      [999, 'neunhundertneunundneunzig'],
      [1000, 'eintausend'],
      [1001, 'eintausendeins'],
      [2024, 'zweitausendvierundzwanzig'],
      [21_000, 'einundzwanzigtausend'],
      [1_000_000, 'eine Million'],
      [2_000_001, 'zwei Millionen eins'],
      [101_000_000, 'einhunderteine Millionen'],
      [1_234_567, 'eine Million zweihundertvierunddreißigtausendfünfhundertsiebenundsechzig'],
      [1_000_000_000, 'eine Milliarde'],
      [
        999_999_999_999,
        'neunhundertneunundneunzig Milliarden neunhundertneunundneunzig Millionen neunhundertneunundneunzigtausendneunhundertneunundneunzig',
      ],
    ];
    for (const [n, words] of table) {
      test(`${n} → ${words}`, () => {
        expect(cardinalDe(n)).toBe(words);
        expect(say(`Es sind ${n} Stück.`)).toBe(`Es sind ${words} Stück.`);
      });
    }
    rows([
      ['Es sind 1.234.567 Stück.', 'Es sind eine Million zweihundertvierunddreißigtausendfünfhundertsiebenundsechzig Stück.'],
      ['Es sind 10 000 Stück.', 'Es sind zehntausend Stück.'],
      ['Es sind 3,5 Liter.', 'Es sind drei Komma fünf Liter.'],
      ['Agent 007.', 'Agent null null sieben.'],
      ['Es sind 1000000000000 Stück.', 'Es sind 1000000000000 Stück.'],
    ]);
    test('out of range throws', () => {
      expect(() => cardinalDe(1_000_000_000_000)).toThrow(RangeError);
      expect(() => cardinalDe(-1)).toThrow(RangeError);
    });
  });

  describe('ordinals', () => {
    rows([
      ['3. Kapitel', 'drittes Kapitel'],
      ['Er kam am 3. Mai.', 'Er kam am dritten Mai.'],
      ['Die 2. Auflage erschien.', 'Die zweite Auflage erschien.'],
      ['Im 18. Jahrhundert.', 'Im achtzehnten Jahrhundert.'],
      ['Zum 21. Mal.', 'Zum einundzwanzigsten Mal.'],
      ['Ein 2. Band folgte.', 'Ein zweiter Band folgte.'],
      ['Der 1. Teil.', 'Der erste Teil.'],
      ['Den 7. Brief las er.', 'Den siebten Brief las er.'],
      ['In 2. Auflage.', 'In zweiter Auflage.'],
      ['Vom 3. bis 5. Mai.', 'Vom dritten bis fünften Mai.'],
      ['Das 3. und 4. Kapitel.', 'Das dritte und vierte Kapitel.'],
      ['Am 3. Sept. 1784.', 'Am dritten September siebzehnhundertvierundachtzig.'],
      ['Im 18. Jh. lebte er.', 'Im achtzehnten Jahrhundert lebte er.'],
      ['Seine 100. Auflage.', 'Seine einhundertste Auflage.'],
      ['Er wurde 3.', 'Er wurde drei.'],
    ]);
    test('ordinal stems', () => {
      expect([1, 2, 3, 7, 8, 13, 19, 20, 21, 101, 1000].map(ordinalDe)).toEqual([
        'erst',
        'zweit',
        'dritt',
        'siebt',
        'acht',
        'dreizehnt',
        'neunzehnt',
        'zwanzigst',
        'einundzwanzigst',
        'einhunderterst',
        'eintausendst',
      ]);
    });
  });

  describe('Roman numerals only in context', () => {
    rows([
      ['Kapitel IV', 'Kapitel vier'],
      ['Band II.', 'Band zwei.'],
      ['Teil III beginnt.', 'Teil drei beginnt.'],
      ['Buch I', 'Buch eins'],
      ['Abschnitt XIV', 'Abschnitt vierzehn'],
      ['Chapter IX', 'Chapter neun'],
      ['XIV.', 'vierzehn.'],
      ['IV', 'vier'],
      ['I.', 'I.'],
      ['I. Kant.', 'I. Kant.'],
      ['Er sah IV Leute.', 'Er sah IV Leute.'],
      ['Kapitel IIII', 'Kapitel IIII'],
    ]);
  });

  describe('years (1100–1999 in year context)', () => {
    test('year words', () => {
      expect(yearDe(1100)).toBe('elfhundert');
      expect(yearDe(1784)).toBe('siebzehnhundertvierundachtzig');
      expect(yearDe(1801)).toBe('achtzehnhunderteins');
      expect(yearDe(1999)).toBe('neunzehnhundertneunundneunzig');
    });
    rows([
      ['Am 3. Mai 1784.', 'Am dritten Mai siebzehnhundertvierundachtzig.'],
      ['Im Jahr 1800 kam er.', 'Im Jahr achtzehnhundert kam er.'],
      ['Seit 1100 steht sie.', 'Seit elfhundert steht sie.'],
      ['Um 1999 war es.', 'Um neunzehnhundertneunundneunzig war es.'],
      ['Von 1914 bis 1918 dauerte er.', 'Von neunzehnhundertvierzehn bis neunzehnhundertachtzehn dauerte er.'],
      ['Er starb 1500 v. Chr.', 'Er starb fünfzehnhundert vor Christus.'],
      ['Im Jahr 2024 kam er.', 'Im Jahr zweitausendvierundzwanzig kam er.'],
      ['Er hatte 1784 Bücher.', 'Er hatte eintausendsiebenhundertvierundachtzig Bücher.'],
      ['Von 1500 Soldaten.', 'Von eintausendfünfhundert Soldaten.'],
    ]);
  });

  describe('hyphen constructs', () => {
    rows([
      ['Er klopfte 2-mal.', 'Er klopfte zweimal.'],
      ['Er klopfte 1-mal.', 'Er klopfte einmal.'],
      ['Die 3-jährige Tochter.', 'Die dreijährige Tochter.'],
      ['Der 100-Meter-Lauf.', 'Der einhundert-Meter-Lauf.'],
      ['Er kam -- dann ging er.', 'Er kam, dann ging er.'],
      ['Er kam--dann ging er.', 'Er kam, dann ging er.'],
      ['Siehe S. 12-15.', 'Siehe Seite zwölf bis fünfzehn.'],
      ['Der Krieg 1914–1918.', 'Der Krieg neunzehnhundertvierzehn bis neunzehnhundertachtzehn.'],
      ['Haupt- und Nebensatz.', 'Haupt- und Nebensatz.'],
    ]);
  });

  describe('special characters', () => {
    rows([
      ['Es sind 50 % mehr.', 'Es sind fünfzig Prozent mehr.'],
      ['Es sind 50% mehr.', 'Es sind fünfzig Prozent mehr.'],
      ['Nach § 5 gilt.', 'Nach Paragraf fünf gilt.'],
      ['Nach §§ 3 gilt.', 'Nach Paragrafen drei gilt.'],
      ['Müller & Söhne.', 'Müller und Söhne.'],
      ['Es gilt 2 + 2.', 'Es gilt zwei plus zwei.'],
      ['Es gilt 2+2.', 'Es gilt zwei plus zwei.'],
    ]);
  });

  test('display tokens are not changed', () => {
    const text = 'Am 3. Mai 1784 kam Prof. Kant z. B. 2-mal -- zu 50 %.';
    const tokens = tokenize(text, 'de');
    const copy = structuredClone(tokens);
    speechForText(text, 'de');
    const result = speechForText(text, 'de');
    expect(tokens).toEqual(copy);
    expect(result.speechText).toBe(
      'Am dritten Mai siebzehnhundertvierundachtzig kam Professor Kant zum Beispiel zweimal, zu fünfzig Prozent.',
    );
  });
});
