import { keyTerms } from './terms.ts';
import {
  primaryLanguage,
  VISUAL_PLAN_VERSION,
  VisualPlanSchema,
  type Book,
  type Cue,
  type Paragraph,
  type Section,
  type Sentence,
  type VisualPlan,
} from '@lesebuehne/core';

/** Enumeration markers (B9): ordinal adverbs and paired "on the one hand … on the other". */
const ENUMERATION: Readonly<Record<string, readonly string[]>> = {
  de: [
    'erstens', 'zweitens', 'drittens', 'viertens', 'fünftens', 'sechstens', 'siebtens', 'achtens', 'neuntens', 'zehntens',
    'zum einen', 'zum anderen', 'zum andern', 'einerseits', 'andererseits', 'anderseits',
  ],
  en: [
    'firstly', 'secondly', 'thirdly', 'fourthly', 'fifthly', 'first', 'second', 'third', 'fourth', 'fifth',
    'on the one hand', 'on the other hand',
  ],
};

const MAX_TERMS = 4;
const MAX_TERM_LENGTH = 60;
const MAX_LABEL_LENGTH = 72;

/** Verbatim occurrence of `word` (case-insensitive, whole words) in `text`, or undefined. */
function findWord(text: string, word: string): { index: number; phrase: string } | undefined {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/ /gu, '\\s+');
  const m = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').exec(text);
  return m ? { index: m.index, phrase: m[0] } : undefined;
}

/** The first one to three tokens of a sentence, verbatim. */
function leadPhrase(sentence: Sentence): string {
  const words = sentence.tokens.filter((t) => t.wordLike).slice(0, 3);
  const last = words.at(-1);
  if (!last) return sentence.text;
  return sentence.text.slice(0, last.end - sentence.start);
}

function shorten(text: string): string {
  if (text.length <= MAX_LABEL_LENGTH) return text;
  const cut = text.slice(0, MAX_LABEL_LENGTH);
  const space = cut.lastIndexOf(' ');
  return `${(space > 20 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/u, '')} …`;
}

const flowParagraphs = (section: Section): Paragraph[] =>
  section.paragraphs.filter((p) => p.kind !== 'figure' && p.kind !== 'footnote');

function listPlan(section: Section): VisualPlan | undefined {
  const list = flowParagraphs(section).find((p) => p.kind === 'list' && (p.items?.length ?? 0) >= 2);
  if (!list?.items) return undefined;
  const items: Array<{ id: string; label: string }> = [];
  const cues: Cue[] = [];
  for (const [k, [start, end]] of list.items.entries()) {
    const sentence = list.sentences.find((s) => s.start >= start && s.start < end);
    if (!sentence) continue;
    const id = `item-${k + 1}`;
    items.push({ id, label: shorten(list.displayText.slice(start, end)) });
    cues.push({ anchor: { sentenceId: sentence.id, phrase: leadPhrase(sentence) }, action: { type: 'reveal', itemId: id } });
  }
  if (items.length < 2) return undefined;
  return {
    version: VISUAL_PLAN_VERSION,
    mode: 'diagram',
    rationale: `list block with ${items.length} items`,
    keyTerms: [],
    cues,
    diagram: { template: 'list', items },
    fallback: 'kinetic',
  };
}

function enumerationPlan(section: Section, lang: string): VisualPlan | undefined {
  const markers = ENUMERATION[lang] ?? [];
  if (markers.length === 0) return undefined;
  const found: Array<{ sentence: Sentence; phrase: string }> = [];
  for (const p of flowParagraphs(section)) {
    if (p.kind === 'heading') continue;
    for (const s of p.sentences) {
      // Longest marker first, so "on the other hand" wins over "other".
      const hit = [...markers].sort((a, b) => b.length - a.length).map((m) => findWord(s.text, m)).find((h) => h !== undefined);
      if (hit) found.push({ sentence: s, phrase: hit.phrase });
    }
  }
  if (found.length < 2) return undefined;
  const items = found.map((f, k) => ({ id: `item-${k + 1}`, label: shorten(f.sentence.text) }));
  return {
    version: VISUAL_PLAN_VERSION,
    mode: 'diagram',
    rationale: `${found.length} enumeration markers (${found.map((f) => f.phrase.toLowerCase()).join(', ')})`,
    keyTerms: [],
    cues: found.map((f, k) => ({ anchor: { sentenceId: f.sentence.id, phrase: f.phrase }, action: { type: 'reveal', itemId: `item-${k + 1}` } })),
    diagram: { template: 'list', items },
    fallback: 'kinetic',
  };
}

function kineticPlan(section: Section, book: Book): VisualPlan | undefined {
  const terms: Array<{ term: string; sentence: Sentence; order: number }> = [];
  const seen = new Set<string>();
  const add = (term: string, sentence: Sentence, order: number): void => {
    const t = term.trim();
    const key = t.toLowerCase();
    if (t.length < 2 || t.length > MAX_TERM_LENGTH || seen.has(key) || !sentence.text.includes(t)) return;
    seen.add(key);
    terms.push({ term: t, sentence, order });
  };
  const reasons = new Set<string>();
  // Emphasised phrases first: the author marked them.
  let offset = 0;
  for (const p of flowParagraphs(section)) {
    if (p.kind !== 'heading') {
      for (const m of p.marks ?? []) {
        if (m.kind !== 'em' && m.kind !== 'strong') continue;
        const sentence = p.sentences.find((x) => x.start <= m.start && m.end <= x.end);
        const phrase = p.displayText.slice(m.start, m.end);
        if (!sentence || phrase.split(/\s+/u).length > 4) continue;
        add(phrase, sentence, offset + m.start);
        reasons.add('emphasis');
      }
    }
    offset += p.displayText.length + 2;
  }
  // Then the section's characteristic words (frequent here, rare elsewhere).
  const orderOf = (s: Sentence): number => {
    let o = 0;
    for (const p of flowParagraphs(section)) {
      if (p.sentences.includes(s)) return o + s.start;
      o += p.displayText.length + 2;
    }
    return o;
  };
  for (const k of keyTerms(section, book)) {
    if (terms.length >= MAX_TERMS) break;
    add(k.term, k.sentence, orderOf(k.sentence) + Math.max(0, k.sentence.text.indexOf(k.term)));
    reasons.add('key words');
  }
  if (terms.length === 0) return undefined;
  const chosen = terms.sort((a, b) => a.order - b.order).slice(0, MAX_TERMS);
  return {
    version: VISUAL_PLAN_VERSION,
    mode: 'kinetic',
    rationale: `key terms from ${[...reasons].join(', ')}`,
    keyTerms: chosen.map((t) => t.term),
    cues: chosen.map((t) => ({ anchor: { sentenceId: t.sentence.id, phrase: t.term }, action: { type: 'showTerm', term: t.term } })),
    fallback: 'none',
  };
}

function nonePlan(): VisualPlan {
  return { version: VISUAL_PLAN_VERSION, mode: 'none', rationale: 'no structure, emphasis or contrast found', keyTerms: [], cues: [], fallback: 'none' };
}

/** Forced visual mode per section (B9, key V). */
export type ForcedMode = 'auto' | 'list' | 'kinetic' | 'text';

/**
 * The heuristic director (B9, brief §6.3): deterministic, no LLM. Priority: list block → list
 * diagram; ≥ 2 enumeration markers → list diagram; emphasised phrases and the section's key
 * words (frequent here, rare elsewhere) → kinetic; otherwise none. `forced` restricts the choice ("text" = none).
 */
export function planSection(section: Section, book: Book, forced: ForcedMode = 'auto'): VisualPlan {
  const lang = primaryLanguage(book.language);
  let plan: VisualPlan | undefined;
  if (forced === 'text') plan = nonePlan();
  else if (forced === 'kinetic') plan = kineticPlan(section, book);
  else if (forced === 'list') plan = listPlan(section) ?? enumerationPlan(section, lang);
  else plan = listPlan(section) ?? enumerationPlan(section, lang) ?? kineticPlan(section, book);
  return VisualPlanSchema.parse(plan ?? nonePlan());
}

/** Plans for every section of the book, by section ID. */
export function planBook(book: Book, forced: (sectionId: string) => ForcedMode = () => 'auto'): Map<string, VisualPlan> {
  const plans = new Map<string, VisualPlan>();
  for (const chapter of book.chapters) {
    for (const section of chapter.sections) plans.set(section.id, planSection(section, book, forced(section.id)));
  }
  return plans;
}
