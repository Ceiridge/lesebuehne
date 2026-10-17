import { primaryLanguage, segmenterFor } from '../text/segmenters.ts';
import { findEnclosures, QUOTE_MARKS, type Enclosure } from './quotes.ts';
import type { SentenceRules } from './rules.ts';
import { RULES_DE } from './rules-de.ts';
import { RULES_EN } from './rules-en.ts';

/** One sentence of a paragraph. `text` includes the whitespace that follows the sentence. */
export interface SentenceSpan {
  /** Start offset in the paragraph (UTF-16, inclusive). */
  start: number;
  /** End offset in the paragraph (UTF-16, exclusive). */
  end: number;
  text: string;
}

const RULES: Readonly<Record<string, SentenceRules>> = { de: RULES_DE, en: RULES_EN };

/** The correction table for a language tag, or `undefined` (segmenter only). */
export function sentenceRulesFor(lang: string): SentenceRules | undefined {
  return RULES[primaryLanguage(lang)];
}

/**
 * Splits a paragraph into sentences. The sentences concatenate back to `text` exactly.
 *
 * German and English: `Intl.Segmenter(lang, {granularity: 'sentence'})`, then a correction
 * pass. Candidate boundaries are the segmenter boundaries plus every position after a
 * terminator (`. ! ? …`), closing marks and whitespace that is followed by an uppercase
 * start, optionally behind opening marks and behind a dash with whitespace
 * (`„Gehst du?“ – „Ja.“`). A candidate is dropped (the sentences merge) when:
 * - the next sentence starts with a lowercase letter or `, ; :` (whatever ends the text
 *   before it: `.`, `!`, `?`, an ellipsis or a closing quotation mark or parenthesis);
 * - it lies inside parentheses or brackets whose closing mark is followed by a lowercase
 *   letter or `, ; :` (`Er kam (wie immer! Wirklich.) zu spät.`). Inside quotation marks the
 *   sentences stay separate whatever follows the closing mark
 *   (`„Habe Mut! ` | `Bediene dich“, rief er.`);
 * - the text before it ends with an abbreviation of the table (`z. B.`, `Dr.`), with a number
 *   abbreviation before a digit (`S. 12`, `Art. 5`, `Jan. 1784`), with an ordinal `\d+.`
 *   before a listed word (`3. Mai`, `3. Auflage`), or with a single-letter initial (`I. Kant`).
 * A boundary right after a line break is always kept.
 *
 * Other languages: the segmenter only, without corrections.
 */
export function segmentSentences(text: string, lang: string): SentenceSpan[] {
  const plain = [...segmenterFor(lang, 'sentence').segment(text)].map((s) => s.index).filter((i) => i > 0);
  const rules = sentenceRulesFor(lang);
  if (!rules) return spans(text, plain);

  const candidates = new Set(plain);
  for (const m of text.matchAll(SPLIT_CANDIDATE)) candidates.add(m.index + m[0].length);

  const matcher = compile(rules);
  const brackets = findEnclosures(text).filter((e) => BRACKET_OPEN.includes(text.charAt(e.open)));
  const kept = [...candidates]
    .filter((b) => b > 0 && b < text.length)
    .sort((a, b) => a - b)
    .filter((b) => !shouldMerge(text, b, matcher, brackets));
  return spans(text, kept);
}

const CLOSE_MARKS = `${QUOTE_MARKS})\\]`;
const OPEN_MARKS = `${QUOTE_MARKS}(\\[`;
const BRACKET_OPEN = '([';
/** – U+2013 and — U+2014 before dialogue (`„Gehst du?“ – „Ja.“`). */
const DASHES = '\\u2013\\u2014';
const SPLIT_CANDIDATE = new RegExp(
  `[.!?\\u2026]+[${CLOSE_MARKS}]*\\s+(?=(?:[${DASHES}]\\s+)?[${OPEN_MARKS}]*\\p{Lu})`,
  'gu',
);
const CONTINUATION = /^[\p{Ll},;:]/u;
const LINE_BREAK_END = /[\n\r\u0085\u2028\u2029]$/;
const TRAILING_SPACE = /\s+$/u;
const LEADING_SPACE = /^\s+/u;
const FIRST_WORD = /^\p{L}+/u;
const ORDINAL_END = /(?<![\p{L}\p{N}])\p{N}+\.$/u;
const INITIAL_END = /(?<![\p{L}\p{N}])(\p{Lu})\.$/u;
const DIGIT_START = /^\p{Nd}/u;

interface Matcher {
  rules: SentenceRules;
  /** Text before the boundary ends with (part of) an abbreviation; `rest` must follow if set. */
  abbreviations: Array<{ end: RegExp; rest?: RegExp }>;
  numberAbbreviation?: RegExp;
}

const compiled = new WeakMap<SentenceRules, Matcher>();

function compile(rules: SentenceRules): Matcher {
  const cached = compiled.get(rules);
  if (cached) return cached;
  const abbreviations: Matcher['abbreviations'] = [];
  for (const abbreviation of withCapitalVariants(rules.abbreviations)) {
    const parts = abbreviationParts(abbreviation);
    for (let k = 1; k <= parts.length; k++) {
      const end = new RegExp(`(?<![\\p{L}\\p{N}])${joinParts(parts.slice(0, k))}$`, 'u');
      const rest = k < parts.length ? new RegExp(`^${joinParts(parts.slice(k))}`, 'u') : undefined;
      abbreviations.push(rest ? { end, rest } : { end });
    }
  }
  const numbered = withCapitalVariants(rules.numberAbbreviations).map((a) => joinParts(abbreviationParts(a)));
  const matcher: Matcher = {
    rules,
    abbreviations,
    ...(numbered.length > 0 ? { numberAbbreviation: new RegExp(`(?<![\\p{L}\\p{N}])(?:${numbered.join('|')})$`, 'u') } : {}),
  };
  compiled.set(rules, matcher);
  return matcher;
}

/** Context length around a boundary; longer than any abbreviation, ordinal or whitespace run in a block. */
const WINDOW = 64;

/** `brackets`: matched parentheses and brackets only (D28); quotations never merge their inner sentences. */
function shouldMerge(text: string, b: number, m: Matcher, brackets: Enclosure[]): boolean {
  const before = text.slice(Math.max(0, b - WINDOW), b);
  if (LINE_BREAK_END.test(before)) return false;
  const left = before.replace(TRAILING_SPACE, '');
  const right = text.slice(b, b + WINDOW);

  if (CONTINUATION.test(right)) return true;
  for (const e of brackets) {
    if (e.open < b && b <= e.close) {
      const after = text.slice(e.close + 1, e.close + 1 + WINDOW).replace(LEADING_SPACE, '');
      if (CONTINUATION.test(after)) return true;
    }
  }
  for (const a of m.abbreviations) {
    if (a.end.test(left) && (!a.rest || a.rest.test(right))) return true;
  }
  if (m.numberAbbreviation?.test(left) && DIGIT_START.test(right)) return true;
  if (m.rules.ordinalWords.size > 0 && ORDINAL_END.test(left)) {
    const word = FIRST_WORD.exec(right)?.[0];
    if (word !== undefined && m.rules.ordinalWords.has(word)) return true;
  }
  if (m.rules.initials) {
    const letter = INITIAL_END.exec(left)?.[1];
    if (letter !== undefined && !m.rules.initialExceptions.includes(letter)) return true;
  }
  return false;
}

function spans(text: string, boundaries: number[]): SentenceSpan[] {
  const result: SentenceSpan[] = [];
  let start = 0;
  for (const end of [...boundaries, text.length]) {
    if (end <= start) continue;
    result.push({ start, end, text: text.slice(start, end) });
    start = end;
  }
  return result;
}

/** `'z. B.'` → `['z', 'B']` */
function abbreviationParts(abbreviation: string): string[] {
  return abbreviation
    .split('.')
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

/** Parts joined by a period and optional whitespace, each part escaped, ending with a period. */
function joinParts(parts: string[]): string {
  return parts.map((p) => `${escape(p)}\\.`).join('\\s*');
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function withCapitalVariants(list: readonly string[]): string[] {
  const out = new Set<string>();
  for (const a of list) {
    out.add(a);
    out.add(a.charAt(0).toUpperCase() + a.slice(1));
  }
  return [...out];
}
