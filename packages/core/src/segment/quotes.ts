/**
 * Quotation marks and brackets known to sentence segmentation (C14 code points).
 *
 * Each opening mark maps to the marks that can close it. Several marks both open and close
 * (for example “ closes „ in German and opens a quotation in English); pairing decides by the
 * marks that are open at that point.
 */
export const PAIRS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ['„', ['“', '”']], // „ closed by “ (German) or ”
  ['“', ['”']], // “ … ” (English)
  ['"', ['"']], // " … "
  ['»', ['«']], // » … « (German)
  ['«', ['»']], // « … » (Swiss, French)
  ['›', ['‹']], // › … ‹
  ['‹', ['›']], // ‹ … ›
  ['‚', ['‘', '’']], // ‚ closed by ‘ (German) or ’
  ['‘', ['’']], // ‘ … ’ (English)
  ['(', [')']],
  ['[', [']']],
]);

/** All C14 quotation marks: „ “ ” " » « › ‹ ‚ ‘ ’ */
export const QUOTE_MARKS = '„“”"»«›‹‚‘’';

const APOSTROPHE = '’';
const LETTER = /\p{L}/u;

/** A matched opening and closing mark: UTF-16 offsets of both marks. */
export interface Enclosure {
  open: number;
  close: number;
}

/**
 * Finds matched quotation and bracket pairs in `text`. ’ between two letters (`geht’s`)
 * is an apostrophe, never a quote. Marks that never find a partner are ignored.
 */
export function findEnclosures(text: string): Enclosure[] {
  const stack: Array<{ mark: string; at: number }> = [];
  const pairs: Enclosure[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (!PAIRS.has(c) && !QUOTE_MARKS.includes(c) && c !== ')' && c !== ']') continue;
    if (c === APOSTROPHE && LETTER.test(text.charAt(i - 1)) && LETTER.test(text.charAt(i + 1))) continue;
    let j = stack.length - 1;
    while (j >= 0 && !(PAIRS.get(stack[j]?.mark ?? '') ?? []).includes(c)) j--;
    if (j >= 0) {
      pairs.push({ open: stack[j]?.at ?? 0, close: i });
      stack.length = j;
    } else if (PAIRS.has(c)) {
      stack.push({ mark: c, at: i });
    }
  }
  return pairs;
}
