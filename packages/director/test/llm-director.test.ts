import { describe, expect, test } from 'bun:test';
import { assembleBook, FakeLLM, type Book, type LLMRequest } from '@lesebuehne/core';
import {
  budgetAfter,
  planCacheKey,
  planSectionLLM,
  planUserPrompt,
  planSectionOrHeuristic,
  prepareBook,
  preferBudget,
  verbatimIn,
  type Complete,
  type LlmPlan,
} from '../src/index.ts';

const book: Book = assembleBook({
  language: 'de',
  title: 'Probe',
  chapters: [
    {
      title: 'Aufklärung',
      blocks: [
        { kind: 'text', text: 'Aufklärung ist der Ausgang des Menschen aus seiner selbstverschuldeten Unmündigkeit. Faulheit und Feigheit sind die Ursachen.' },
        { kind: 'text', text: 'Habe Mut, dich deines eigenen Verstandes zu bedienen!' },
      ],
    },
  ],
});
const section = book.chapters[0]!.sections[0]!;
const sentences = section.paragraphs.flatMap((p) => p.sentences);
const signal = new AbortController().signal;

const completeWith = (fake: FakeLLM): Complete =>
  async <T,>(req: LLMRequest<T>) => {
    const r = await fake.completeJSON(req);
    return { value: r.value, model: r.model, providerId: fake.id };
  };

const basePlan = (over: Partial<LlmPlan>): LlmPlan => ({
  mode: 'diagram',
  rationale: 'two causes',
  keyTerms: [],
  cues: [],
  diagram: null,
  quote: null,
  image: null,
  animation: null,
  fallback: 'kinetic',
  ...over,
});

const diagram: NonNullable<LlmPlan['diagram']> = {
  template: 'causal-chain',
  title: null,
  items: [
    { id: 'faul', label: 'Faulheit', group: null, detail: null },
    { id: 'feig', label: 'Feigheit', group: null, detail: '◉ · #544C83' },
    { id: 'unm', label: 'Unmündigkeit', group: null, detail: null },
  ],
  edges: [
    { from: 'faul', to: 'unm', label: null },
    { from: 'feig', to: 'ghost', label: null },
  ],
};

describe('T4: LLM director', () => {
  test('picture preference reaches the prompt and rejects non-image answers only while budget remains', async () => {
    const ctx = { prefer: 'images' as const, budget: { images: 1, animations: 0 } };
    expect(planUserPrompt(section, book, ctx)).toContain('The reader selected pictures');
    let problems: string[] = [];
    const complete: Complete = async (req) => {
      const answer = basePlan({ diagram });
      problems = req.validate?.(answer as never) ?? [];
      return { value: answer as never, providerId: 'fake' };
    };
    await planSectionLLM(section, book, ctx, complete, signal);
    expect(problems.some((p) => p.includes('selected pictures'))).toBe(true);
    await planSectionLLM(section, book, { ...ctx, budget: { images: 0, animations: 0 } }, complete, signal);
    expect(problems).toEqual([]);
  });

  test('visual preferences transfer budgets and separate caches; mixed keeps the existing key', () => {
    const budget = { images: 2, animations: 3 };
    expect(preferBudget(budget, undefined)).toEqual(budget);
    expect(preferBudget(budget, 'images')).toEqual({ images: 5, animations: 0 });
    expect(preferBudget(budget, 'animations')).toEqual({ images: 0, animations: 5 });
    const mixed = planCacheKey(section, book, undefined, 'a');
    expect(planCacheKey(section, book, undefined, 'a', undefined)).toBe(mixed);
    expect(new Set([mixed, ...(['images', 'animations'] as const).map((p) => planCacheKey(section, book, undefined, 'a', p))]).size).toBe(3);
  });

  test('verbatimIn: exact, case- and whitespace-tolerant, else undefined', () => {
    expect(verbatimIn('Habe  Mut, dich', 'habe mut')).toBe('Habe  Mut');
    expect(verbatimIn('Habe Mut', 'Mut')).toBe('Mut');
    expect(verbatimIn('Habe Mut', 'Courage')).toBeUndefined();
  });

  test('plan: aliases map to IDs, bad cues are dropped, edges filtered, cues in reading order', async () => {
    const answer = basePlan({
      diagram,
      cues: [
        { sentence: 's2', phrase: 'Feigheit', action: 'reveal', target: 'feig' },
        { sentence: 's1', phrase: 'selbstverschuldeten Unmündigkeit', action: 'reveal', target: 'unm' },
        { sentence: 's2', phrase: 'Faulheit', action: 'reveal', target: 'faul' },
        { sentence: 's3', phrase: 'nicht im Text', action: 'highlight', target: 'unm' },
        { sentence: 's9', phrase: 'Mut', action: 'reveal', target: 'faul' },
      ],
    });
    const fake = new FakeLLM({ answers: [JSON.stringify(answer)] });
    const plan = await planSectionLLM(section, book, {}, completeWith(fake), signal);
    expect(plan.mode).toBe('diagram');
    expect(plan.cues.map((c) => c.anchor.sentenceId)).toEqual([sentences[0]!.id, sentences[1]!.id, sentences[1]!.id]);
    expect(plan.cues.map((c) => c.anchor.phrase)).toEqual(['selbstverschuldeten Unmündigkeit', 'Faulheit', 'Feigheit']);
    expect(plan.diagram?.edges).toEqual([{ from: 'faul', to: 'unm' }]);
    expect(plan.diagram?.items.find((i) => i.id === 'feig')?.detail).toBeUndefined(); // echoed glyph/colour dropped
    expect(plan.meta?.dropped).toHaveLength(2);
    expect(plan.meta?.providerId).toBe('fake-llm');
    expect(fake.requests[0]!.user).toContain('[s3] Habe Mut');
    expect(fake.requests[0]!.user).toContain('<book_text>');
  });

  test('duplicate item ids are renamed without a repair round', async () => {
    const dup = basePlan({
      diagram: { ...diagram, items: [...diagram.items, { id: 'faul', label: 'Bequemlichkeit', group: null, detail: null }] },
      cues: [{ sentence: 's2', phrase: 'Faulheit', action: 'reveal', target: 'faul' }],
    });
    const fake = new FakeLLM({ answers: [JSON.stringify(dup)] });
    const plan = await planSectionLLM(section, book, {}, completeWith(fake), signal);
    expect(fake.requests).toHaveLength(1);
    expect(plan.diagram?.items.map((i) => i.id)).toEqual(['faul', 'feig', 'unm', 'faul-2']);
    expect(plan.cues[0]?.action).toEqual({ type: 'reveal', itemId: 'faul' });
  });

  test('a non-verbatim quote triggers one repair; the repaired answer is used', async () => {
    const bad = basePlan({ mode: 'quote', quote: { sentence: 's3', phrase: 'Habe Mut, deinen Verstand zu nutzen!' } });
    const good = basePlan({ mode: 'quote', quote: { sentence: 's3', phrase: 'Habe Mut, dich deines eigenen Verstandes zu bedienen!' } });
    const fake = new FakeLLM({ answers: [JSON.stringify(bad), JSON.stringify(good)] });
    const plan = await planSectionLLM(section, book, {}, completeWith(fake), signal);
    expect(fake.requests).toHaveLength(2);
    expect(plan.mode).toBe('quote');
    expect(plan.quote).toEqual({ sentenceId: sentences[2]!.id, phrase: 'Habe Mut, dich deines eigenen Verstandes zu bedienen!' });
  });

  test('budget: image without budget becomes its diagram; animation without budget becomes diagram', async () => {
    const image = basePlan({
      mode: 'image',
      diagram,
      image: { prompt: 'An eighteenth-century study with a candle and books', aspect: '16:9', focusRegions: [] },
    });
    const fake = new FakeLLM({ answers: [JSON.stringify(image)] });
    const plan = await planSectionLLM(section, book, { budget: { images: 0, animations: 3 } }, completeWith(fake), signal);
    expect(plan.mode).toBe('diagram');
    expect(plan.image).toBeUndefined();
    expect(plan.meta?.downgraded).toContain('image→diagram');

    const anim = basePlan({ mode: 'animation', diagram, animation: { brief: 'A pendulum swinging between the two poles' } });
    const fake2 = new FakeLLM({ answers: [JSON.stringify(anim)] });
    const p2 = await planSectionLLM(section, book, { budget: { images: 2, animations: 0 } }, completeWith(fake2), signal);
    expect(p2.mode).toBe('diagram');
    const p3 = await planSectionLLM(section, book, {}, completeWith(new FakeLLM({ answers: [JSON.stringify(anim)] })), signal);
    expect(p3.mode).toBe('animation');
    expect(p3.animation?.brief).toContain('pendulum');
    expect(budgetAfter([p3, p3, p3, p3]).animations).toBe(0);
  });

  test('kinetic: non-verbatim terms dropped, missing showTerm cues anchored automatically', async () => {
    const answer = basePlan({ mode: 'kinetic', keyTerms: ['unmündigkeit', 'Freiheit', 'Verstandes'], diagram: null });
    const plan = await planSectionLLM(section, book, {}, completeWith(new FakeLLM({ answers: [JSON.stringify(answer)] })), signal);
    expect(plan.mode).toBe('kinetic');
    expect(plan.keyTerms).toEqual(['Unmündigkeit', 'Verstandes']);
    expect(plan.cues.map((c) => c.action)).toEqual([
      { type: 'showTerm', term: 'Unmündigkeit' },
      { type: 'showTerm', term: 'Verstandes' },
    ]);
  });

  test('chain failure → heuristic plan; abort is rethrown', async () => {
    const failing = new FakeLLM({ answers: [{ error: 'server' }] });
    const r = await planSectionOrHeuristic(section, book, {}, completeWith(failing), signal);
    expect(r.fallback).toBe(true);
    expect(r.plan.version).toBe('heuristic-1');
    const ac = new AbortController();
    ac.abort();
    await expect(planSectionOrHeuristic(section, book, {}, completeWith(new FakeLLM({ answers: ['{}'] })), ac.signal)).rejects.toThrow();
  });

  test('Style Bible: glossary labels must be verbatim; chapters map to IDs; concepts tag diagram items', async () => {
    const style = {
      palette: { background: '#f7f1e3', ink: '#2b2b2b', accent: '#b5523b', accent2: '#3b6fb5', muted: '#9a8f7a' },
      illustrationStyle: 'Copperplate engraving, warm sepia, no text',
      diagramStyle: 'Thin ink lines, rounded boxes',
      mood: 'sober, hopeful',
      glossary: [
        { label: 'unmündigkeit', description: 'Unfähigkeit, sich ohne Leitung zu bedienen', glyph: '⛓', color: '#b5523b', aliases: ['Unmuendigkeit'] },
        { label: 'Weltgeist', description: 'not in the text', glyph: '◎', color: '#3b6fb5', aliases: [] },
      ],
      chapterSummaries: [
        { chapter: 1, summary: 'Definition der Aufklärung.' },
        { chapter: 7, summary: 'does not exist' },
      ],
    };
    const fake = new FakeLLM({ answers: [JSON.stringify(style)] });
    const sb = await prepareBook(book, completeWith(fake), signal);
    expect(sb.glossary.map((g) => g.label)).toEqual(['Unmündigkeit']);
    expect(sb.glossary[0]!.aliases).toBeUndefined();
    expect(sb.chapterSummaries).toEqual([{ chapterId: book.chapters[0]!.id, summary: 'Definition der Aufklärung.' }]);

    const plan = await planSectionLLM(
      section,
      book,
      { styleBible: sb },
      completeWith(new FakeLLM({ answers: [JSON.stringify(basePlan({ diagram }))] })),
      signal,
    );
    expect(plan.diagram?.items.find((i) => i.id === 'unm')?.conceptId).toBe(sb.glossary[0]!.id);
    expect(planCacheKey(section, book, sb, 'a')).not.toBe(planCacheKey(section, book, undefined, 'a'));
  });
});

test('T4: LLM schemas convert to strict JSON Schema', async () => {
  const { jsonSchemaOf } = await import('@lesebuehne/core');
  const { LlmPlanSchema, LlmStyleBibleSchema } = await import('../src/index.ts');
  expect(() => jsonSchemaOf(LlmPlanSchema)).not.toThrow();
  expect(() => jsonSchemaOf(LlmStyleBibleSchema)).not.toThrow();
});

describe('M3: animate task', () => {
  const animPlan = async () => {
    const answer = basePlan({ mode: 'animation', diagram, animation: { brief: 'Two causes push towards immaturity, like weights on a scale' } });
    return planSectionLLM(section, book, {}, completeWith(new FakeLLM({ answers: [JSON.stringify(answer)] })), signal);
  };

  test('valid program on the first answer; invalid code triggers the one repair', async () => {
    const { EXAMPLE_PROGRAM, animateSection, DirectorService } = await import('../src/index.ts');
    const { MemoryCache } = await import('@lesebuehne/core');
    const plan = await animPlan();
    expect(plan.mode).toBe('animation');
    const bad = JSON.stringify({ code: 'while (true) {}\nreturn function (t) {};', notes: 'n' });
    const good = JSON.stringify({ code: EXAMPLE_PROGRAM, notes: 'pendulum' });
    const fake = new FakeLLM({ answers: [bad, good] });
    const program = await animateSection(section, book, plan, {}, completeWith(fake), signal);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]!.user).toContain('Animation brief: Two causes');
    expect(fake.requests[0]!.user).toContain('0: faul "Faulheit"');
    expect(program.code).toBe(EXAMPLE_PROGRAM);
    expect(program.meta?.providerId).toBe('fake-llm');

    // Service: cached, regenerate adds a variant, a runtime error asks for a corrected one.
    const svc = new DirectorService({ complete: () => completeWith(new FakeLLM({ answers: [good] })), cache: new MemoryCache(), chainId: 'x' });
    const a1 = await svc.animate(book, section.id, plan, {}, signal);
    const a2 = await svc.animate(book, section.id, plan, {}, signal);
    expect([a1.cached, a2.cached]).toEqual([false, true]);
    const fixer = new FakeLLM({ answers: [good] });
    const svc2 = new DirectorService({ complete: () => completeWith(fixer), cache: new MemoryCache(), chainId: 'x' });
    const a3 = await svc2.animate(book, section.id, plan, { error: 'lb.foo is not a function' }, signal);
    expect(a3.variants).toBe(1);
    expect(fixer.requests[0]!.user).toContain('failed at runtime with: lb.foo is not a function');
    await expect(svc.animate(book, section.id, { ...plan, mode: 'diagram' }, {}, signal)).rejects.toThrow('no animation');
  });

  test('plan schema accepts connect and dim cues', async () => {
    const answer = basePlan({
      diagram,
      cues: [
        { sentence: 's2', phrase: 'Faulheit', action: 'connect', target: 'faul>unm' },
        { sentence: 's2', phrase: 'Feigheit', action: 'dim', target: 'feig' },
        { sentence: 's2', phrase: 'Ursachen', action: 'connect', target: 'faul>nope' },
      ],
    });
    const plan = await planSectionLLM(section, book, {}, completeWith(new FakeLLM({ answers: [JSON.stringify(answer)] })), signal);
    expect(plan.cues.map((c) => c.action)).toEqual([
      { type: 'connect', from: 'faul', to: 'unm' },
      { type: 'dim', itemId: 'feig' },
    ]);
    expect(plan.meta?.dropped?.some((d) => d.includes('faul>nope'))).toBe(true);
  });
});
