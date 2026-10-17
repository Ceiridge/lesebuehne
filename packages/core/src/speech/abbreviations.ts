import { atSentenceEnd, compactKey, isDigits, isText, matchKey, startsWithDigit } from './match.ts';
import type { SpeechRule, SpeechToken } from './types.ts';

/**
 * When a table entry applies:
 * - `beforeNumber`: only before a number (`S. 12`);
 * - `afterNumber`: only after a number (`S. 12 ff.`);
 * - `date`: before a number or after an ordinal `\d+.` (`3. Sept. 1784`, `Sept. 1784`).
 * No condition: always.
 */
export type AbbreviationCondition = 'beforeNumber' | 'afterNumber' | 'date';

export interface Abbreviation {
  /** Display form with its periods (`z. B.`); whitespace between the parts is optional. */
  readonly text: string;
  readonly speech: string;
  readonly when?: AbbreviationCondition;
}

interface Compiled {
  key: string;
  speech: string;
  when?: AbbreviationCondition;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function holds(when: AbbreviationCondition | undefined, tokens: readonly SpeechToken[], i: number, k: number): boolean {
  switch (when) {
    case undefined:
      return true;
    case 'beforeNumber':
      return startsWithDigit(tokens[i + k]);
    case 'afterNumber':
      return startsWithDigit(tokens[i - 1]);
    case 'date':
      return startsWithDigit(tokens[i + k]) || (isText(tokens[i - 1], '.') && isDigits(tokens[i - 2]));
  }
}

/**
 * A rule that expands the abbreviations of `table`. Each entry with a lowercase first letter
 * also matches with an uppercase one, with a capitalised speech (`vgl.` → `Vgl.` →
 * `Vergleiche`). The longest matching entry wins. An abbreviation whose final period also ends
 * the sentence keeps that period in the speech text (`usw.` → `und so weiter.`).
 */
export function abbreviationRule(id: string, lang: string, table: readonly Abbreviation[]): SpeechRule {
  const byFirst = new Map<string, Compiled[]>();
  const add = (c: Compiled): void => {
    const first = c.key.charAt(0);
    const list = byFirst.get(first) ?? [];
    if (!list.some((x) => x.key === c.key)) list.push(c);
    byFirst.set(first, list);
  };
  for (const a of table) {
    const key = compactKey(a.text);
    const when = a.when !== undefined ? { when: a.when } : {};
    add({ key, speech: a.speech, ...when });
    const capital = capitalize(key);
    if (capital !== key) add({ key: capital, speech: capitalize(a.speech), ...when });
  }
  for (const list of byFirst.values()) list.sort((a, b) => b.key.length - a.key.length);

  return {
    id,
    lang,
    match(tokens, i) {
      const first = tokens[i]?.text.charAt(0);
      for (const c of (first !== undefined && byFirst.get(first)) || []) {
        const k = matchKey(tokens, i, c.key);
        if (k === 0 || !holds(c.when, tokens, i, k)) continue;
        const final = c.key.endsWith('.') && atSentenceEnd(tokens, i + k);
        return { consume: k, speech: final ? `${c.speech}.` : c.speech };
      }
      return null;
    },
  };
}
