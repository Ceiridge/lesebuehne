/** German number words for speech text. */

const ONES = [
  'null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf',
  'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn',
];
const TENS = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];

/** Largest number with German cardinal words here. */
export const MAX_CARDINAL_DE = 999_999_999_999;

/** `1` is `ein` inside a compound (`einhundert`, `einundzwanzig`, `einmal`). */
function one(n: number): string {
  return n === 1 ? 'ein' : (ONES[n] ?? '');
}

/** 1–99. `final`: a final 1 is `eins`, otherwise `ein`. */
function under100(n: number, final: boolean): string {
  if (n < 20) return n === 1 && final ? 'eins' : one(n);
  const units = n % 10;
  const tens = TENS[Math.floor(n / 10)] ?? '';
  return units === 0 ? tens : `${one(units)}und${tens}`;
}

/** 1–999 */
function under1000(n: number, final: boolean): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return (h > 0 ? `${one(h)}hundert` : '') + (r > 0 ? under100(r, final) : '');
}

/** 1–999 999 */
function under1e6(n: number, final: boolean): string {
  const t = Math.floor(n / 1000);
  const r = n % 1000;
  return (t > 0 ? `${under1000(t, false)}tausend` : '') + (r > 0 ? under1000(r, final) : '');
}

/** Count of millions or billions: `zwei Millionen`, `einhunderteine Millionen`. */
function count(n: number, singular: string, plural: string): string {
  if (n === 1) return `eine ${singular}`;
  const words = n % 100 === 1 ? `${under1000(n - 1, false)}eine` : under1000(n, false);
  return `${words} ${plural}`;
}

function checkRange(n: number, min: number, max: number): void {
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new RangeError(`${n} is outside ${min}–${max}`);
}

/**
 * German cardinal words, 0 – 999 999 999 999: `2024` → `zweitausendvierundzwanzig`,
 * `1234567` → `eine Million zweihundertvierunddreißigtausendfünfhundertsiebenundsechzig`.
 * `final = false` gives the form inside a compound (`ein` instead of a final `eins`: `einmal`).
 */
export function cardinalDe(n: number, final = true): string {
  checkRange(n, 0, MAX_CARDINAL_DE);
  if (n === 0) return 'null';
  const billions = Math.floor(n / 1e9);
  const millions = Math.floor(n / 1e6) % 1000;
  const rest = n % 1e6;
  const parts: string[] = [];
  if (billions > 0) parts.push(count(billions, 'Milliarde', 'Milliarden'));
  if (millions > 0) parts.push(count(millions, 'Million', 'Millionen'));
  if (rest > 0) parts.push(under1e6(rest, final));
  return parts.join(' ');
}

/** Year words for 1100–1999: `1784` → `siebzehnhundertvierundachtzig`. */
export function yearDe(n: number): string {
  checkRange(n, 1100, 1999);
  const r = n % 100;
  return `${under100(Math.floor(n / 100), false)}hundert${r > 0 ? under100(r, true) : ''}`;
}

/** Largest ordinal with words here. */
export const MAX_ORDINAL_DE = 999_999;

const IRREGULAR_ORDINALS: Readonly<Record<number, string>> = { 1: 'erst', 3: 'dritt', 7: 'siebt', 8: 'acht' };

function smallOrdinal(n: number): string {
  return IRREGULAR_ORDINALS[n] ?? `${ONES[n] ?? ''}t`;
}

/**
 * Ordinal stem without ending, 1 – 999 999: `3` → `dritt`, `21` → `einundzwanzigst`,
 * `101` → `einhunderterst`. The caller adds the adjective ending (`-e`, `-en`, `-er`, `-es`, `-em`).
 */
export function ordinalDe(n: number): string {
  checkRange(n, 1, MAX_ORDINAL_DE);
  const r = n % 100;
  if (r >= 1 && r <= 19) return (n > r ? under1e6(n - r, false) : '') + smallOrdinal(r);
  return `${under1e6(n, false)}st`;
}

/** Digits one by one: `007` → `null null sieben`. */
export function digitsDe(digits: string): string {
  return [...digits].map((d) => ONES[Number(d)] ?? d).join(' ');
}

const ROMAN = /^M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;
const ROMAN_VALUES: Readonly<Record<string, number>> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

/** Value of a well-formed uppercase Roman numeral (1–3999), or `undefined`. */
export function romanValue(s: string): number | undefined {
  if (s === '' || !ROMAN.test(s)) return undefined;
  let total = 0;
  for (let k = 0; k < s.length; k++) {
    const v = ROMAN_VALUES[s.charAt(k)] ?? 0;
    const next = ROMAN_VALUES[s.charAt(k + 1)] ?? 0;
    total += v < next ? -v : v;
  }
  return total;
}
