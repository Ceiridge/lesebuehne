import { abbreviationRule, type Abbreviation } from './abbreviations.ts';
import {
  adjacent,
  compactKey,
  isCapitalized,
  isDigits,
  isLetters,
  isText,
  matchKey,
} from './match.ts';
import {
  cardinalDe,
  digitsDe,
  MAX_CARDINAL_DE,
  MAX_ORDINAL_DE,
  ordinalDe,
  romanValue,
  yearDe,
} from './numbers-de.ts';
import type { SpeechMatch, SpeechRule, SpeechToken } from './types.ts';

const MONTH_ABBREVIATIONS: ReadonlyArray<readonly [string, string]> = [
  ['Jan.', 'Januar'], ['Feb.', 'Februar'], ['Febr.', 'Februar'], ['Mrz.', 'März'], ['Apr.', 'April'],
  ['Jun.', 'Juni'], ['Jul.', 'Juli'], ['Aug.', 'August'], ['Sep.', 'September'], ['Sept.', 'September'],
  ['Septemb.', 'September'], ['Okt.', 'Oktober'], ['Octob.', 'Oktober'], ['Nov.', 'November'],
  ['Novemb.', 'November'], ['Dez.', 'Dezember'], ['Dezemb.', 'Dezember'], ['Decemb.', 'Dezember'],
];

/** German abbreviation table (longest match wins; capital variants are added automatically). */
export const GERMAN_ABBREVIATIONS: readonly Abbreviation[] = [
  { text: 'z. B.', speech: 'zum Beispiel' },
  { text: 'd. h.', speech: 'das heißt' },
  { text: 'u. a.', speech: 'unter anderem' },
  { text: 'u. ä.', speech: 'und Ähnliches' },
  { text: 'o. ä.', speech: 'oder Ähnliches' },
  { text: 'u. U.', speech: 'unter Umständen' },
  { text: 'z. T.', speech: 'zum Teil' },
  { text: 'i. d. R.', speech: 'in der Regel' },
  { text: 'v. a.', speech: 'vor allem' },
  { text: 's. o.', speech: 'siehe oben' },
  { text: 's. u.', speech: 'siehe unten' },
  { text: 'n. Chr.', speech: 'nach Christus' },
  { text: 'v. Chr.', speech: 'vor Christus' },
  { text: 'usw.', speech: 'und so weiter' },
  { text: 'etc.', speech: 'et cetera' },
  { text: 'bzw.', speech: 'beziehungsweise' },
  { text: 'ca.', speech: 'circa' },
  { text: 'ggf.', speech: 'gegebenenfalls' },
  { text: 'evtl.', speech: 'eventuell' },
  { text: 'inkl.', speech: 'inklusive' },
  { text: 'insb.', speech: 'insbesondere' },
  { text: 'bspw.', speech: 'beispielsweise' },
  { text: 'sog.', speech: 'sogenannte' },
  { text: 'vgl.', speech: 'vergleiche' },
  { text: 'geb.', speech: 'geboren' },
  { text: 'gest.', speech: 'gestorben' },
  { text: 'Dr.', speech: 'Doktor' },
  { text: 'Prof.', speech: 'Professor' },
  { text: 'Hr.', speech: 'Herr' },
  { text: 'Hrn.', speech: 'Herrn' },
  { text: 'Fr.', speech: 'Frau' },
  { text: 'Frl.', speech: 'Fräulein' },
  { text: 'St.', speech: 'Sankt' },
  { text: 'Nr.', speech: 'Nummer' },
  { text: 'Kap.', speech: 'Kapitel' },
  { text: 'Abb.', speech: 'Abbildung' },
  { text: 'Tab.', speech: 'Tabelle' },
  { text: 'Bd.', speech: 'Band' },
  { text: 'Bde.', speech: 'Bände' },
  { text: 'Hg.', speech: 'Herausgeber' },
  { text: 'Hrsg.', speech: 'Herausgeber' },
  { text: 'Aufl.', speech: 'Auflage' },
  { text: 'Anm.', speech: 'Anmerkung' },
  { text: 'Abs.', speech: 'Absatz' },
  { text: 'Str.', speech: 'Straße' },
  { text: 'Jh.', speech: 'Jahrhundert' },
  { text: 'Jhd.', speech: 'Jahrhundert' },
  { text: 'Mio.', speech: 'Millionen' },
  { text: 'Mrd.', speech: 'Milliarden' },
  { text: 'Tsd.', speech: 'Tausend' },
  { text: 'Std.', speech: 'Stunden' },
  { text: 'Tel.', speech: 'Telefon' },
  // Also ordinary words or initials: only next to a number.
  { text: 'S.', speech: 'Seite', when: 'beforeNumber' },
  { text: 'Sp.', speech: 'Spalte', when: 'beforeNumber' },
  { text: 'Bl.', speech: 'Blatt', when: 'beforeNumber' },
  { text: 'Art.', speech: 'Artikel', when: 'beforeNumber' },
  { text: 'ff.', speech: 'folgende', when: 'afterNumber' },
  { text: 'f.', speech: 'folgende', when: 'afterNumber' },
  ...MONTH_ABBREVIATIONS.map(([text, speech]): Abbreviation => ({ text, speech, when: 'date' })),
];

export type Gender = 'm' | 'f' | 'n';

const MONTHS = [
  'Januar', 'Jänner', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober',
  'November', 'Dezember',
];
const MONTH_STEMS = MONTH_ABBREVIATIONS.map(([text]) => text.slice(0, -1));

/**
 * Nouns (and month names) after which `\d+.` is an ordinal, with their grammatical gender for
 * the adjective ending (`3. Kapitel` → `drittes Kapitel`, `3. Auflage` → `dritte Auflage`).
 */
export const GERMAN_NOUN_GENDERS: ReadonlyMap<string, Gender> = new Map<string, Gender>([
  ...MONTHS.map((m): [string, Gender] => [m, 'm']),
  ...MONTH_STEMS.map((m): [string, Gender] => [m, 'm']),
  ...(
    [
      ['Auflage', 'f'], ['Ausgabe', 'f'], ['Band', 'm'], ['Buch', 'n'], ['Teil', 'm'], ['Kapitel', 'n'],
      ['Abschnitt', 'm'], ['Absatz', 'm'], ['Artikel', 'm'], ['Paragraph', 'm'], ['Paragraf', 'm'], ['Akt', 'm'],
      ['Aufzug', 'm'], ['Auftritt', 'm'], ['Szene', 'f'], ['Strophe', 'f'], ['Vers', 'm'], ['Brief', 'm'],
      ['Lieferung', 'f'], ['Folge', 'f'], ['Satz', 'm'], ['Sinfonie', 'f'], ['Symphonie', 'f'],
      ['Jahrhundert', 'n'], ['Jh', 'n'], ['Jhd', 'n'], ['Jahrtausend', 'n'], ['Jahrzehnt', 'n'], ['Jahr', 'n'],
      ['Monat', 'm'], ['Woche', 'f'], ['Tag', 'm'], ['Stunde', 'f'], ['Mal', 'n'], ['Stock', 'm'],
      ['Stockwerk', 'n'], ['Etage', 'f'], ['Platz', 'm'], ['Rang', 'm'], ['Klasse', 'f'], ['Reihe', 'f'],
      ['Runde', 'f'], ['Hälfte', 'f'], ['Geburtstag', 'm'], ['Jahrestag', 'm'], ['Todestag', 'm'],
      ['Seite', 'f'], ['Sitzung', 'f'], ['Gesang', 'm'], ['Abteilung', 'f'],
    ] as Array<[string, Gender]>
  ),
]);

const MONTH_WORDS = new Set([...MONTHS, ...MONTH_STEMS]);

// ---------------------------------------------------------------------------------------------
// Ordinals: `\d+.` + noun or month. The ending comes from the word before the number.

const STRONG: Readonly<Record<Gender, string>> = { m: 'er', f: 'e', n: 'es' };
const LIKE_DER = new Set(['der', 'dieser', 'jener', 'jeder', 'welcher']);
const LIKE_DIE = new Set(['die', 'diese', 'jene', 'jede', 'welche']);
const LIKE_DAS = new Set(['das', 'dieses', 'jenes', 'jedes', 'welches', 'ins', 'ans', 'aufs', 'fürs', 'übers', 'durchs', 'ums']);
const WEAK_EN = new Set([
  'den', 'dem', 'des', 'am', 'im', 'vom', 'zum', 'zur', 'beim', 'bis',
  'diesen', 'diesem', 'jenen', 'jenem', 'jeden', 'jedem', 'welchen', 'welchem',
]);
const MIXED_STEMS = ['ein', 'kein', 'mein', 'dein', 'sein', 'ihr', 'unser', 'euer', 'eur'];
/** Prepositions with the dative, directly before the number (`in 2. Auflage` → `in zweiter Auflage`). */
const DATIVE_PREPOSITIONS = new Set([
  'aus', 'bei', 'mit', 'nach', 'seit', 'von', 'zu', 'ab', 'in', 'an', 'auf', 'vor', 'hinter', 'über', 'unter',
  'neben', 'zwischen', 'gegenüber',
]);
/** Words that join two ordinals before one noun (`3. und 4. Kapitel`, `3. bis 5. Mai`). */
const ORDINAL_JOINS = new Set(['und', 'oder', 'bis', '-', '–']);

function mixedEnding(word: string, g: Gender): string | undefined {
  for (const stem of MIXED_STEMS) {
    if (!word.startsWith(stem)) continue;
    const suffix = word.slice(stem.length);
    if (suffix === '') return g === 'f' ? 'e' : STRONG[g];
    if (suffix === 'e') return g === 'f' ? 'e' : 'en';
    if (['en', 'em', 'er', 'es'].includes(suffix)) return 'en';
  }
  return undefined;
}

/** Adjective ending of an ordinal after `determiner` (lowercase) before a noun of gender `g`. */
function ordinalEnding(determiner: string | undefined, g: Gender): string {
  if (determiner === undefined) return STRONG[g];
  if (LIKE_DER.has(determiner)) return g === 'm' ? 'e' : 'en';
  if (LIKE_DIE.has(determiner)) return g === 'f' ? 'e' : 'en';
  if (LIKE_DAS.has(determiner)) return g === 'n' ? 'e' : 'en';
  if (WEAK_EN.has(determiner)) return 'en';
  const mixed = mixedEnding(determiner, g);
  if (mixed !== undefined) return mixed;
  if (DATIVE_PREPOSITIONS.has(determiner)) return g === 'f' ? 'er' : 'em';
  return STRONG[g];
}

/** `tokens[j]`, `tokens[j+1]` are `\d+` and an adjacent `.`. */
function isOrdinalAt(tokens: readonly SpeechToken[], j: number): boolean {
  return isDigits(tokens[j]) && isText(tokens[j + 1], '.') && adjacent(tokens[j], tokens[j + 1]);
}

/** Gender of the noun after an ordinal whose period is at `j - 1`, across `3. und 4. Kapitel`. */
function ordinalNounGender(tokens: readonly SpeechToken[], j: number): Gender | undefined {
  for (let hops = 0; hops < 4; hops++) {
    const t = tokens[j];
    if (t === undefined) return undefined;
    const g = GERMAN_NOUN_GENDERS.get(t.text);
    if (g !== undefined) return g;
    if (!ORDINAL_JOINS.has(t.text) || !isOrdinalAt(tokens, j + 1)) return undefined;
    j += 3;
  }
  return undefined;
}

/** The word that decides the ending: before the number, or before the first of joined ordinals. */
function ordinalDeterminer(tokens: readonly SpeechToken[], i: number): string | undefined {
  let j = i - 1;
  while (ORDINAL_JOINS.has(tokens[j]?.text ?? '') && isOrdinalAt(tokens, j - 2)) j -= 3;
  const t = tokens[j];
  return t?.wordLike ? t.text.toLowerCase() : undefined;
}

const ordinal: SpeechRule = {
  id: 'de.ordinal',
  lang: 'de',
  match(tokens, i) {
    if (!isOrdinalAt(tokens, i)) return null;
    const n = Number(tokens[i]?.text);
    if (n < 1 || n > MAX_ORDINAL_DE) return null;
    const g = ordinalNounGender(tokens, i + 2);
    if (g === undefined) return null;
    return { consume: 2, speech: ordinalDe(n) + ordinalEnding(ordinalDeterminer(tokens, i), g) };
  },
};

// ---------------------------------------------------------------------------------------------
// Roman numerals: after a context word, or a heading of one word with at least two letters.

const ROMAN_CONTEXT = new Set(['kapitel', 'band', 'teil', 'buch', 'abschnitt', 'chapter', 'part', 'book']);

/** Value of the Roman numeral at `i` if the context allows it (shared by the English rule). */
export function romanInContext(tokens: readonly SpeechToken[], i: number, heading: boolean): number | undefined {
  const t = tokens[i];
  if (t === undefined) return undefined;
  const value = romanValue(t.text);
  if (value === undefined) return undefined;
  const before = tokens[i - 1];
  if (before !== undefined && ROMAN_CONTEXT.has(before.text.toLowerCase())) return value;
  if (!heading || i !== 0 || t.text.length < 2) return undefined;
  const rest = tokens.slice(1);
  return rest.length === 0 || (rest.length === 1 && isText(rest[0], '.')) ? value : undefined;
}

const roman: SpeechRule = {
  id: 'de.roman',
  lang: 'de',
  match(tokens, i) {
    const value = romanInContext(tokens, i, true);
    return value === undefined ? null : { consume: 1, speech: cardinalDe(value) };
  },
};

// ---------------------------------------------------------------------------------------------
// Years: 4 digits 1100–1999 in year context.

const YEAR_WORDS = new Set([
  'jahr', 'jahre', 'jahres', 'jahrs', 'anno', 'sommer', 'winter', 'herbst', 'frühjahr', 'frühling', 'ostern',
  'weihnachten',
]);
/** Year cues only when no noun follows the number (`von 1500 Soldaten` is a count). */
const YEAR_PREPOSITIONS = new Set(['seit', 'bis', 'um', 'ab', 'von', 'vor', 'nach']);

function yearValue(t: SpeechToken | undefined): number | undefined {
  if (t === undefined || !/^\d{4}$/.test(t.text)) return undefined;
  const n = Number(t.text);
  return n >= 1100 && n <= 1999 ? n : undefined;
}

function followedByEra(tokens: readonly SpeechToken[], k: number): boolean {
  return matchKey(tokens, k, compactKey('n. Chr.')) > 0 || matchKey(tokens, k, compactKey('v. Chr.')) > 0;
}

function isYearContext(tokens: readonly SpeechToken[], i: number): boolean {
  const before = tokens[i - 1];
  const after = tokens[i + 1];
  if (followedByEra(tokens, i + 1)) return true;
  if (before === undefined) return false;
  if (MONTH_WORDS.has(before.text)) return true;
  if (isText(before, '.') && MONTH_WORDS.has(tokens[i - 2]?.text ?? '')) return true;
  const word = before.text.toLowerCase();
  if (YEAR_WORDS.has(word)) return true;
  return YEAR_PREPOSITIONS.has(word) && !isCapitalized(after);
}

const year: SpeechRule = {
  id: 'de.year',
  lang: 'de',
  match(tokens, i) {
    const n = yearValue(tokens[i]);
    return n !== undefined && isYearContext(tokens, i) ? { consume: 1, speech: yearDe(n) } : null;
  },
};

// ---------------------------------------------------------------------------------------------
// Cardinals: 0 – 999 999 999 999, also `1.234.567`, `10 000` (grouped by a single space), `3,5`.

const PLAIN = /^(?:0|[1-9]\d{0,11})$/;
const DOT_GROUPED = /^[1-9]\d{0,2}(?:\.\d{3})+$/;
const DECIMAL = /^((?:0|[1-9]\d{0,2}(?:\.\d{3})+|[1-9]\d{0,11}))(?:,(\d+))$/;
const LEADING_ZERO = /^0\d+$/;
const GROUP_HEAD = /^[1-9]\d{0,2}$/;
const GROUP = /^\d{3}$/;

function integerWords(digits: string): string | undefined {
  const n = Number(digits.replaceAll('.', ''));
  return Number.isSafeInteger(n) && n <= MAX_CARDINAL_DE ? cardinalDe(n) : undefined;
}

/** Plain integer `\d+` in range, or undefined. Used for ranges and hyphen compounds. */
function plainNumber(t: SpeechToken | undefined): number | undefined {
  if (t === undefined || !PLAIN.test(t.text)) return undefined;
  const n = Number(t.text);
  return n <= MAX_CARDINAL_DE ? n : undefined;
}

const cardinal: SpeechRule = {
  id: 'de.cardinal',
  lang: 'de',
  match(tokens, i) {
    const t = tokens[i];
    if (t === undefined) return null;
    if (GROUP_HEAD.test(t.text) && GROUP.test(tokens[i + 1]?.text ?? '')) {
      // `10 000`: groups of three digits, each after exactly one space character.
      let k = i + 1;
      let digits = t.text;
      while (GROUP.test(tokens[k]?.text ?? '') && (tokens[k]?.start ?? 0) - (tokens[k - 1]?.end ?? 0) === 1) {
        digits += tokens[k]?.text ?? '';
        k++;
      }
      const words = k > i + 1 ? integerWords(digits) : undefined;
      if (words !== undefined) return { consume: k - i, speech: words };
    }
    if (PLAIN.test(t.text) || DOT_GROUPED.test(t.text)) {
      const words = integerWords(t.text);
      return words === undefined ? null : { consume: 1, speech: words };
    }
    const decimal = DECIMAL.exec(t.text);
    if (decimal) {
      const words = integerWords(decimal[1] ?? '');
      return words === undefined ? null : { consume: 1, speech: `${words} Komma ${digitsDe(decimal[2] ?? '')}` };
    }
    if (LEADING_ZERO.test(t.text) && t.text.length <= 12) return { consume: 1, speech: digitsDe(t.text) };
    return null;
  },
};

// ---------------------------------------------------------------------------------------------
// Hyphen constructs: `--` pause, number ranges, number-word compounds.

function rangeSpeech(tokens: readonly SpeechToken[], i: number): SpeechMatch | null {
  const a = tokens[i];
  const dash = tokens[i + 1];
  const b = tokens[i + 2];
  const x = plainNumber(a);
  const y = plainNumber(b);
  if (x === undefined || y === undefined || dash === undefined) return null;
  const tight = adjacent(a, dash) && adjacent(dash, b);
  if (!((dash.text === '-' && tight) || dash.text === '–')) return null;
  const years =
    yearValue(a) !== undefined && yearValue(b) !== undefined && !isCapitalized(tokens[i + 3]);
  const speak = (n: number): string => (years ? yearDe(n) : cardinalDe(n));
  return { consume: 3, speech: `${speak(x)} bis ${speak(y)}` };
}

const hyphen: SpeechRule = {
  id: 'de.hyphen',
  lang: 'de',
  match(tokens, i) {
    const t = tokens[i];
    if (t === undefined) return null;
    if (/^-{2,}$/.test(t.text) || (t.text === '-' && isText(tokens[i + 1], '-') && adjacent(t, tokens[i + 1]))) {
      let k = i + 1;
      while (isText(tokens[k], '-') && adjacent(tokens[k - 1], tokens[k])) k++;
      return { consume: k - i, speech: ',' };
    }
    const range = rangeSpeech(tokens, i);
    if (range) return range;
    const n = plainNumber(t);
    const dash = tokens[i + 1];
    const word = tokens[i + 2];
    if (n !== undefined && isText(dash, '-') && adjacent(t, dash) && adjacent(dash, word) && isLetters(word)) {
      const lower = word.text.charAt(0) === word.text.charAt(0).toLowerCase();
      return { consume: 3, speech: `${cardinalDe(n, false)}${lower ? '' : '-'}${word.text}` };
    }
    return null;
  },
};

// ---------------------------------------------------------------------------------------------
// Special characters.

const SPECIAL: Readonly<Record<string, string>> = { '%': 'Prozent', '‰': 'Promille', '&': 'und', '+': 'plus' };

const special: SpeechRule = {
  id: 'de.special',
  lang: 'de',
  match(tokens, i) {
    const t = tokens[i];
    if (t === undefined) return null;
    if (t.text === '§') {
      const double = isText(tokens[i + 1], '§') && adjacent(t, tokens[i + 1]);
      return double ? { consume: 2, speech: 'Paragrafen', spaced: true } : { consume: 1, speech: 'Paragraf', spaced: true };
    }
    if (t.text === '§§') return { consume: 1, speech: 'Paragrafen', spaced: true };
    const word = SPECIAL[t.text];
    return word === undefined ? null : { consume: 1, speech: word, spaced: true };
  },
};

/** German speech rules in priority order (the per-book lexicon comes before them). */
export const GERMAN_SPEECH_RULES: readonly SpeechRule[] = Object.freeze([
  abbreviationRule('de.abbreviation', 'de', GERMAN_ABBREVIATIONS),
  ordinal,
  roman,
  hyphen,
  year,
  special,
  cardinal,
]);
