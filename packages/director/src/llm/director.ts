import {
  cacheKey,
  conceptFor,
  contentHash,
  glossaryIndex,
  styleBibleVersion,
  VisualPlanSchema,
  type Book,
  type Cue,
  type Diagram,
  type GlossaryConcept,
  type LLMRequest,
  type Section,
  type Sentence,
  type StyleBible,
  type VisualMode,
  type VisualPlan,
} from '@lesebuehne/core';
import { planSection } from '../heuristic.ts';
import { PLAN_PROMPT_VERSION, PLAN_SYSTEM, STYLE_PROMPT_VERSION, STYLE_SYSTEM } from './prompts.ts';
import { LlmPlanSchema, LlmStyleBibleSchema, type LlmPlan, type LlmStyleBible } from './schemas.ts';

/**
 * One structured LLM call through whatever chain the caller set up (registry, BYOK, fake), with
 * the provider that answered.
 */
export type Complete = <T>(req: LLMRequest<T>) => Promise<{ value: T; model?: string; providerId: string }>;

/** Images and animations still allowed in the current chapter (spec 002 budget). */
export interface PlanBudget {
  images: number;
  animations: number;
}
export const DEFAULT_BUDGET: Readonly<PlanBudget> = { images: 2, animations: 3 };

export interface PlanContext {
  styleBible?: StyleBible;
  /** Plan of the previous section, for continuity. */
  previous?: VisualPlan;
  budget?: PlanBudget;
  now?: Date;
}

/** Maximum book characters sent to the Style Bible call. */
const STYLE_SAMPLE_CHARS = 48_000;

// ---------------------------------------------------------------------------------------------
// Text helpers

const flowSentences = (section: Section): Sentence[] =>
  section.paragraphs.filter((p) => p.kind !== 'figure' && p.kind !== 'footnote').flatMap((p) => p.sentences);

const sectionText = (section: Section): string =>
  section.paragraphs
    .filter((p) => p.kind !== 'figure' && p.kind !== 'footnote')
    .map((p) => p.displayText)
    .join('\n\n');

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** Verbatim form of `phrase` in `text`: exact, else case- and whitespace-insensitive (D-T4). */
export function verbatimIn(text: string, phrase: string): string | undefined {
  const p = phrase.trim();
  if (!p) return undefined;
  if (text.includes(p)) return p;
  const pattern = p
    .split(/\s+/u)
    .map(escape)
    .join('\\s+');
  return new RegExp(pattern, 'iu').exec(text)?.[0];
}

/** Sentence aliases s1…sN (short, robust references for the model). */
function aliases(section: Section): { byAlias: Map<string, { sentence: Sentence; order: number }>; text: string } {
  const byAlias = new Map<string, { sentence: Sentence; order: number }>();
  const lines: string[] = [];
  for (const [k, sentence] of flowSentences(section).entries()) {
    byAlias.set(`s${k + 1}`, { sentence, order: k });
    lines.push(`[s${k + 1}] ${sentence.text}`);
  }
  return { byAlias, text: lines.join('\n') };
}

const dataBlock = (text: string): string => `<book_text>\n${text.replaceAll('</book_text>', '</book-text>')}\n</book_text>`;

// ---------------------------------------------------------------------------------------------
// Style Bible

function styleSample(book: Book): string {
  const per = Math.max(800, Math.floor(STYLE_SAMPLE_CHARS / Math.max(1, book.chapters.length)));
  return book.chapters
    .map((chapter, k) => {
      const text = chapter.sections.map(sectionText).join('\n\n');
      return `## Chapter ${k + 1}: ${chapter.title}\n${text.length > per ? `${text.slice(0, per)} …` : text}`;
    })
    .join('\n\n');
}

export function styleUserPrompt(book: Book): string {
  return [
    `Book: ${book.title}${book.author ? ` by ${book.author}` : ''} (language ${book.language}, ${book.chapters.length} chapters).`,
    'Glossary labels must be copied from the text; descriptions and summaries in the book language.',
    dataBlock(styleSample(book)),
  ].join('\n\n');
}

const fullText = (book: Book): string => book.chapters.flatMap((c) => c.sections.map(sectionText)).join('\n\n');

const slug = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 32) || 'concept';

/** LLM answer → StyleBible: glossary labels and aliases must be verbatim in the book. */
export function toStyleBible(book: Book, answer: LlmStyleBible, meta: { providerId: string; model?: string; now?: Date }): StyleBible {
  const text = fullText(book);
  const ids = new Set<string>();
  const glossary: GlossaryConcept[] = [];
  for (const g of answer.glossary) {
    const label = verbatimIn(text, g.label);
    if (!label || glossary.some((c) => c.label.toLowerCase() === label.toLowerCase())) continue;
    let id = slug(label);
    for (let n = 2; ids.has(id); n++) id = `${slug(label)}-${n}`;
    ids.add(id);
    const aliasList = g.aliases.map((a) => verbatimIn(text, a)).filter((a): a is string => !!a && a.toLowerCase() !== label.toLowerCase());
    glossary.push({
      id,
      label,
      description: g.description,
      glyph: [...g.glyph].slice(0, 2).join('').slice(0, 4),
      color: g.color,
      ...(aliasList.length ? { aliases: [...new Set(aliasList)] } : {}),
    });
  }
  const chapterSummaries = answer.chapterSummaries.flatMap((s) => {
    const chapter = book.chapters[s.chapter - 1];
    return chapter ? [{ chapterId: chapter.id, summary: s.summary }] : [];
  });
  return {
    version: STYLE_PROMPT_VERSION,
    bookId: book.id,
    palette: answer.palette,
    illustrationStyle: answer.illustrationStyle,
    diagramStyle: answer.diagramStyle,
    mood: answer.mood,
    glossary,
    chapterSummaries,
    meta: {
      providerId: meta.providerId,
      ...(meta.model ? { model: meta.model } : {}),
      promptVersion: STYLE_PROMPT_VERSION,
      createdAt: (meta.now ?? new Date()).toISOString(),
    },
  };
}

/** Style Bible and glossary for a book (one LLM call). */
export async function prepareBook(book: Book, complete: Complete, signal: AbortSignal, now?: Date): Promise<StyleBible> {
  const r = await complete({
    system: STYLE_SYSTEM,
    user: styleUserPrompt(book),
    schema: LlmStyleBibleSchema,
    schemaName: 'style_bible',
    signal,
  });
  return toStyleBible(book, r.value, { providerId: r.providerId, ...(r.model ? { model: r.model } : {}), ...(now ? { now } : {}) });
}

export const styleCacheKey = (book: Book): string => cacheKey('style', { book: book.id, prompt: STYLE_PROMPT_VERSION });

// ---------------------------------------------------------------------------------------------
// Section plans

function chapterOf(book: Book, section: Section): { index: number; title: string; id: string } | undefined {
  for (const [index, c] of book.chapters.entries()) {
    if (c.sections.some((s) => s.id === section.id)) return { index, title: c.title, id: c.id };
  }
  return undefined;
}

export function planUserPrompt(section: Section, book: Book, ctx: PlanContext): string {
  const { text } = aliases(section);
  const chapter = chapterOf(book, section);
  const sb = ctx.styleBible;
  const budget = ctx.budget ?? DEFAULT_BUDGET;
  const summary = sb?.chapterSummaries.find((s) => s.chapterId === chapter?.id)?.summary;
  const lines = [
    `Book: ${book.title}${book.author ? ` by ${book.author}` : ''} (language ${book.language}).`,
    chapter ? `Chapter ${chapter.index + 1}: ${chapter.title}${summary ? ` — ${summary}` : ''}` : '',
    sb ? `Style: ${sb.mood}. Diagrams: ${sb.diagramStyle}. Illustrations: ${sb.illustrationStyle}` : '',
    sb?.glossary.length ? `Glossary (label · glyph · colour): ${sb.glossary.map((c) => `${c.label} · ${c.glyph} · ${c.color}`).join('; ')}` : '',
    ctx.previous ? `Previous section: mode ${ctx.previous.mode}${ctx.previous.keyTerms.length ? `, terms ${ctx.previous.keyTerms.join(', ')}` : ''}.` : '',
    `Budget left in this chapter: ${budget.images} images, ${budget.animations} animations.`,
    'Section (one sentence per line, alias in brackets; the aliases are not part of the text):',
    dataBlock(text),
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * Fatal problems worth the one repair request: the chosen mode lacks its object, or a quote is not
 * verbatim. Everything else (single bad cues, terms) is dropped silently during conversion.
 */
export function fatalPlanProblems(section: Section, plan: LlmPlan): string[] {
  const { byAlias } = aliases(section);
  const problems: string[] = [];
  if ((plan.mode === 'diagram' || plan.mode === 'animation') && !plan.diagram) problems.push(`mode ${plan.mode} needs "diagram"`);
  if (plan.mode === 'image' && !plan.image) problems.push('mode image needs "image"');
  if (plan.mode === 'animation' && !plan.animation) problems.push('mode animation needs "animation"');
  if (plan.mode === 'quote') {
    const s = plan.quote ? byAlias.get(plan.quote.sentence) : undefined;
    if (!plan.quote) problems.push('mode quote needs "quote"');
    else if (!s) problems.push(`quote: unknown sentence ${plan.quote.sentence}`);
    else if (!verbatimIn(s.sentence.text, plan.quote.phrase)) problems.push(`quote phrase is not verbatim in ${plan.quote.sentence}; copy it exactly`);
  }
  // Duplicate item ids are not fatal: conversion renames them (a repair round costs more than it gains).
  const bad = plan.cues.filter((c) => {
    const s = byAlias.get(c.sentence);
    return !s || !verbatimIn(s.sentence.text, c.phrase);
  });
  if (plan.cues.length >= 2 && bad.length * 2 > plan.cues.length) {
    problems.push(`${bad.length} of ${plan.cues.length} cue phrases are not verbatim in their sentence (e.g. "${bad[0]!.phrase}" in ${bad[0]!.sentence})`);
  }
  return problems;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Item details with words in them (models sometimes echo glossary glyphs or colours there). */
const meaningful = (detail: string | null): boolean =>
  !!detail && !/#[0-9a-f]{3,8}\b/iu.test(detail) && /\p{L}{2}/u.test(detail);

/** LLM answer → VisualPlan v2 (aliases → IDs, verbatim anchors, budget, glossary concepts, meta). */
export function toVisualPlan(
  section: Section,
  book: Book,
  answer: LlmPlan,
  ctx: PlanContext,
  meta: { providerId: string; model?: string },
): VisualPlan {
  const { byAlias } = aliases(section);
  const text = sectionText(section);
  const budget = ctx.budget ?? DEFAULT_BUDGET;
  const index = glossaryIndex(ctx.styleBible);
  const dropped: string[] = [];

  // Mode and budget.
  let mode: VisualMode = answer.mode;
  let downgraded: string | undefined;
  const downgrade = (to: VisualMode, why: string): void => {
    downgraded = `${mode}→${to} (${why})`;
    mode = to;
  };
  if (mode === 'image' && budget.images <= 0) downgrade(answer.diagram ? 'diagram' : 'kinetic', 'image budget');
  if (mode === 'animation' && budget.animations <= 0) downgrade('diagram', 'animation budget');
  if (mode === 'animation' && !answer.animation) downgrade('diagram', 'no brief');

  // Diagram.
  let diagram: Diagram | undefined;
  if (answer.diagram && (mode === 'diagram' || mode === 'animation')) {
    const seen = new Set<string>();
    const items = answer.diagram.items.flatMap((i) => {
      if (answer.diagram!.items.some((o) => o !== i && o.id === i.id && o.label === i.label) && seen.has(i.id)) return []; // exact repeat
      // Same id for a different item: keep the item under a fresh id (cues keep pointing at the first).
      let id = i.id;
      for (let n = 2; seen.has(id); n++) id = `${i.id}-${n}`;
      seen.add(id);
      const concept = conceptFor(i.label, index);
      return [{ id, label: i.label, ...(i.group ? { group: i.group } : {}), ...(meaningful(i.detail) ? { detail: i.detail!.trim() } : {}), ...(concept ? { conceptId: concept.id } : {}) }];
    });
    const edges = answer.diagram.edges
      .filter((e) => seen.has(e.from) && seen.has(e.to))
      .map((e) => ({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}) }));
    diagram = {
      template: answer.diagram.template,
      ...(answer.diagram.title ? { title: answer.diagram.title } : {}),
      items,
      ...(edges.length ? { edges } : {}),
    };
  }
  if ((mode === 'diagram' || mode === 'animation') && !diagram) downgrade('kinetic', 'no diagram');

  // Quote.
  let quote: VisualPlan['quote'];
  if (mode === 'quote' && answer.quote) {
    const s = byAlias.get(answer.quote.sentence);
    const phrase = s ? verbatimIn(s.sentence.text, answer.quote.phrase) : undefined;
    if (s && phrase) quote = { sentenceId: s.sentence.id, phrase };
  }
  if (mode === 'quote' && !quote) downgrade('kinetic', 'quote not verbatim');

  // Image.
  const image =
    mode === 'image' && answer.image
      ? {
          prompt: answer.image.prompt,
          aspect: answer.image.aspect,
          focusRegions: answer.image.focusRegions.map((r) => {
            const x = clamp01(r.x);
            const y = clamp01(r.y);
            return { id: r.id, label: r.label || r.id, x, y, w: clamp01(Math.min(r.w, 1 - x)), h: clamp01(Math.min(r.h, 1 - y)) };
          }),
        }
      : undefined;
  if (mode === 'image' && !image) downgrade('kinetic', 'no image spec');

  // Key terms: verbatim in the section, deduplicated.
  const keyTerms: string[] = [];
  for (const t of answer.keyTerms) {
    const v = verbatimIn(text, t);
    if (!v) dropped.push(`term "${t}"`);
    else if (!keyTerms.some((k) => k.toLowerCase() === v.toLowerCase())) keyTerms.push(v);
  }

  // Cues: known sentence, verbatim phrase, existing target.
  const items = new Set(diagram?.items.map((i) => i.id) ?? []);
  const regions = new Set(image?.focusRegions.map((r) => r.id) ?? []);
  const cues: Array<Cue & { order: number; at: number }> = [];
  for (const c of answer.cues) {
    const s = byAlias.get(c.sentence);
    const phrase = s ? verbatimIn(s.sentence.text, c.phrase) : undefined;
    if (!s || !phrase) {
      dropped.push(`${c.sentence} "${c.phrase}"`);
      continue;
    }
    const anchor = { sentenceId: s.sentence.id, phrase };
    const at = s.sentence.text.indexOf(phrase);
    const [from, to] = c.target.split('>').map((x) => x.trim());
    if ((c.action === 'reveal' || c.action === 'highlight' || c.action === 'dim') && items.has(c.target)) {
      cues.push({ anchor, action: { type: c.action, itemId: c.target }, order: s.order, at });
    } else if (c.action === 'connect' && from && to && items.has(from) && items.has(to)) {
      cues.push({ anchor, action: { type: 'connect', from, to }, order: s.order, at });
    } else if (c.action === 'showTerm') {
      const term = keyTerms.find((k) => k.toLowerCase() === c.target.toLowerCase()) ?? verbatimIn(text, c.target);
      if (!term) {
        dropped.push(`${c.sentence} term "${c.target}"`);
        continue;
      }
      if (!keyTerms.includes(term)) keyTerms.push(term);
      cues.push({ anchor, action: { type: 'showTerm', term }, order: s.order, at });
    } else if (c.action === 'focus' && regions.has(c.target)) {
      cues.push({ anchor, action: { type: 'focus', regionId: c.target }, order: s.order, at });
    } else {
      dropped.push(`${c.sentence} ${c.action} ${c.target}`);
    }
  }

  // Kinetic needs a showTerm cue per term: anchor missing ones at their first occurrence.
  if (mode === 'kinetic') {
    for (const term of keyTerms) {
      if (cues.some((c) => c.action.type === 'showTerm' && c.action.term === term)) continue;
      const hit = [...byAlias.values()].find((s) => s.sentence.text.includes(term));
      if (hit) cues.push({ anchor: { sentenceId: hit.sentence.id, phrase: term }, action: { type: 'showTerm', term }, order: hit.order, at: hit.sentence.text.indexOf(term) });
    }
    if (keyTerms.length === 0) downgrade('none', 'no verbatim terms');
  }
  const kept = cues
    .filter((c) => {
      const t = c.action.type;
      if (t === 'showTerm') return true;
      if (t === 'focus') return mode === 'image';
      return mode === 'diagram' || mode === 'animation';
    })
    .sort((a, b) => a.order - b.order || a.at - b.at)
    .map(({ anchor, action }) => ({ anchor, action }));

  const plan: VisualPlan = {
    version: PLAN_PROMPT_VERSION,
    mode,
    rationale: answer.rationale,
    keyTerms: mode === 'none' ? [] : keyTerms,
    cues: mode === 'none' ? [] : kept,
    ...(diagram && (mode === 'diagram' || mode === 'animation') ? { diagram } : {}),
    ...(quote && mode === 'quote' ? { quote } : {}),
    ...(image && mode === 'image' ? { image } : {}),
    ...(mode === 'animation' && answer.animation ? { animation: { brief: answer.animation.brief } } : {}),
    fallback: answer.fallback,
    meta: {
      providerId: meta.providerId,
      ...(meta.model ? { model: meta.model } : {}),
      promptVersion: PLAN_PROMPT_VERSION,
      createdAt: (ctx.now ?? new Date()).toISOString(),
      ...(dropped.length ? { dropped } : {}),
      ...(downgraded ? { downgraded } : {}),
    },
  };
  return VisualPlanSchema.parse(plan);
}

/** LLM plan for one section. Throws when the chain fails; see `planSectionOrHeuristic`. */
export async function planSectionLLM(section: Section, book: Book, ctx: PlanContext, complete: Complete, signal: AbortSignal): Promise<VisualPlan> {
  const r = await complete({
    system: PLAN_SYSTEM,
    user: planUserPrompt(section, book, ctx),
    schema: LlmPlanSchema,
    schemaName: 'visual_plan',
    validate: (plan) => fatalPlanProblems(section, plan),
    signal,
  });
  return toVisualPlan(section, book, r.value, ctx, { providerId: r.providerId, ...(r.model ? { model: r.model } : {}) });
}

/** LLM plan, or the heuristic plan (with the failure in `meta`) when the chain is exhausted. */
export async function planSectionOrHeuristic(
  section: Section,
  book: Book,
  ctx: PlanContext,
  complete: Complete,
  signal: AbortSignal,
): Promise<{ plan: VisualPlan; fallback: boolean; error?: string }> {
  try {
    return { plan: await planSectionLLM(section, book, ctx, complete, signal), fallback: false };
  } catch (e) {
    if (signal.aborted) throw e;
    return { plan: planSection(section, book), fallback: true, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Budget left after `plans` (the chapter's plans so far). */
export function budgetAfter(plans: Iterable<VisualPlan>, start: PlanBudget = DEFAULT_BUDGET): PlanBudget {
  const b = { ...start };
  for (const p of plans) {
    if (p.mode === 'image') b.images--;
    if (p.mode === 'animation') b.animations--;
  }
  return { images: Math.max(0, b.images), animations: Math.max(0, b.animations) };
}

/** Cache key of an LLM plan: section content, prompt, style and the chain that may answer. */
export function planCacheKey(section: Section, book: Book, styleBible: StyleBible | undefined, chain: string): string {
  return cacheKey('plan', {
    book: book.id,
    section: section.id,
    text: contentHash(sectionText(section)),
    prompt: PLAN_PROMPT_VERSION,
    style: styleBibleVersion(styleBible),
    chain,
  });
}
