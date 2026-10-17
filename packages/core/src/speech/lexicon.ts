import * as z from 'zod';
import { primaryLanguage } from '../text/segmenters.ts';
import { compactKey, matchKey } from './match.ts';
import type { SpeechRule } from './types.ts';

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

const nonBlank = z.string().trim().min(1);

export const LexiconEntrySchema = z.strictObject({
  /** Display form; whitespace between its parts is optional when matching (`z. B.` = `z.B.`). */
  text: nonBlank,
  /** What the voice says instead. */
  speech: nonBlank,
  /** Only for books in this language (primary subtag compared); all languages with rules if absent. */
  lang: z.string().regex(LANGUAGE_TAG).optional(),
  /** Match regardless of letter case. */
  ignoreCase: z.boolean().optional(),
});

function entryKey(e: z.infer<typeof LexiconEntrySchema>): string {
  const key = compactKey(e.text);
  return `${e.lang ? primaryLanguage(e.lang) : '*'}\u0000${e.ignoreCase ? key.toLowerCase() : key}`;
}

/** Per-book pronunciation lexicon. Entries override every rule of the book language. */
export const LexiconSchema = z
  .strictObject({ entries: z.array(LexiconEntrySchema) })
  .superRefine((lexicon, ctx) => {
    const seen = new Set<string>();
    for (const [k, e] of lexicon.entries.entries()) {
      const key = entryKey(e);
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['entries', k, 'text'], message: `duplicate entry "${e.text}"` });
      seen.add(key);
    }
  });

export type Lexicon = z.infer<typeof LexiconSchema>;
export type LexiconEntry = z.infer<typeof LexiconEntrySchema>;

export function parseLexicon(input: unknown): Lexicon {
  return LexiconSchema.parse(input);
}

export function safeParseLexicon(input: unknown): ReturnType<typeof LexiconSchema.safeParse> {
  return LexiconSchema.safeParse(input);
}

const compiled = new WeakMap<Lexicon, Map<string, SpeechRule>>();

/**
 * The lexicon as one rule for `lang` (highest priority). The lexicon is validated first, so an
 * unvalidated invalid object throws. The longest matching entry wins.
 */
export function lexiconRule(lexicon: Lexicon, lang: string): SpeechRule {
  const primary = primaryLanguage(lang);
  let byLang = compiled.get(lexicon);
  if (!byLang) {
    LexiconSchema.parse(lexicon);
    byLang = new Map();
    compiled.set(lexicon, byLang);
  }
  const cached = byLang.get(primary);
  if (cached) return cached;

  const entries = lexicon.entries
    .filter((e) => e.lang === undefined || primaryLanguage(e.lang) === primary)
    .map((e) => ({ key: compactKey(e.text), speech: e.speech, ignoreCase: e.ignoreCase === true }))
    .sort((a, b) => b.key.length - a.key.length);
  const lower = (s: string): string => s.toLowerCase();

  const rule: SpeechRule = {
    id: 'lexicon',
    lang: '*',
    match(tokens, i) {
      for (const e of entries) {
        const k = e.ignoreCase ? matchKey(tokens, i, lower(e.key), lower) : matchKey(tokens, i, e.key);
        if (k > 0) return { consume: k, speech: e.speech };
      }
      return null;
    },
  };
  byLang.set(primary, rule);
  return rule;
}
