import { describe, expect, test } from 'bun:test';
import { assembleBook, planTextProblems, VisualPlanSchema, type BlockInput, type Book } from '@lesebuehne/core';
import { ingestFile } from '@lesebuehne/ingest';
import { EPUB_CASES } from '../../ingest/test/fixtures/epub-builder.ts';
import { planBook, planSection } from '../src/index.ts';

const ROOT = new URL('../../../', import.meta.url);
const bytes = async (rel: string) => new Uint8Array(await Bun.file(new URL(rel, ROOT)).arrayBuffer());

const kant = ingestFile({ fileName: 'aufklaerung.txt', bytes: await bytes('samples/aufklaerung.txt'), language: 'de' }).book;
const kybalion = ingestFile({ fileName: 'kybalion-chapter-2.md', bytes: await bytes('samples/kybalion-chapter-2.md'), language: 'en' }).book;
const mdFixtures = await Promise.all(
  ['footnotes.md', 'inline.md', 'structure.md'].map(async (f) =>
    ingestFile({ fileName: f, bytes: await bytes(`packages/ingest/test/fixtures/${f}`) }).book,
  ),
);
const epubFixtures = Object.entries(EPUB_CASES).flatMap(([name, build]) => {
  try {
    return [ingestFile({ fileName: `${name}.epub`, bytes: build() }).book];
  } catch {
    return []; // DRM cases yield no book
  }
});

const one = (blocks: BlockInput[], language = 'de'): Book => assembleBook({ language, title: 't', chapters: [{ blocks }] });
const firstPlan = (book: Book) => planSection(book.chapters[0]!.sections[0]!, book);

describe('07-1: detection and determinism', () => {
  test('list block → list diagram', () => {
    const book = one([{ kind: 'list', text: 'Faulheit Feigheit', items: [[0, 8], [9, 17]] }]);
    const plan = firstPlan(book);
    expect(plan.mode).toBe('diagram');
    expect(plan.diagram?.items.map((i) => i.label)).toEqual(['Faulheit', 'Feigheit']);
  });

  test('German enumeration markers → list diagram', () => {
    const book = one([
      { kind: 'text', text: 'Erstens ist es bequem. Zweitens ist es sicher. Drittens kostet es nichts.' },
    ]);
    const plan = firstPlan(book);
    expect(plan.mode).toBe('diagram');
    expect(plan.cues.map((c) => c.anchor.phrase)).toEqual(['Erstens', 'Zweitens', 'Drittens']);
    const pair = firstPlan(one([{ kind: 'text', text: 'Zum einen fehlt der Mut. Zum anderen fehlt die Freiheit.' }]));
    expect(pair.cues.map((c) => c.anchor.phrase)).toEqual(['Zum einen', 'Zum anderen']);
  });

  test('English enumeration markers', () => {
    const plan = firstPlan(one([{ kind: 'text', text: 'On the one hand it is safe. On the other hand it is dull.' }], 'en'));
    expect(plan.mode).toBe('diagram');
    expect(plan.cues.map((c) => c.anchor.phrase)).toEqual(['On the one hand', 'On the other hand']);
    expect(firstPlan(one([{ kind: 'text', text: 'First, read. Second, think.' }], 'en')).cues.length).toBe(2);
  });

  test('emphasis and characteristic words → kinetic; contrast words alone are not key terms', () => {
    const book = one([
      { kind: 'heading', level: 1, text: 'Freiheit' },
      {
        kind: 'text',
        text: 'Räsonniert nicht, sondern gehorcht! Die Freiheit der Feder ist die Freiheit des Volkes, aber nicht ohne Vernunft.',
        marks: [{ start: 0, end: 10, kind: 'em' }],
      },
    ]);
    const plan = firstPlan(book);
    expect(plan.mode).toBe('kinetic');
    expect(plan.keyTerms).toEqual(['Räsonniert', 'Freiheit']);
    expect(plan.cues.every((c) => c.action.type === 'showTerm')).toBe(true);
    expect(firstPlan(one([{ kind: 'text', text: 'Das ist aber so, sondern anders, jedoch nicht immer.' }])).mode).toBe('none');
  });

  test('key terms skip function words and prefer section-specific nouns', () => {
    const plans = [...planBook(kant).values()].flatMap((p) => p.keyTerms);
    expect(plans).toContain('Unmündigkeit');
    for (const bad of ['aber', 'sondern', 'Aber', 'Teil', 'Daher', 'Nun']) expect(plans).not.toContain(bad);
    const en = [...planBook(kybalion).values()].flatMap((p) => p.keyTerms);
    expect(en).toContain('Principle');
    for (const bad of ['but', 'yet', 'thing', 'everything']) expect(en).not.toContain(bad);
  });

  test('nothing to show → none', () => {
    expect(firstPlan(one([{ kind: 'text', text: 'Es regnet heute im Tal.' }])).mode).toBe('none');
  });

  test('same input → deep-equal plans; forced modes', () => {
    expect([...planBook(kant)]).toEqual([...planBook(kant)]);
    const section = kybalion.chapters[0]!.sections.find((s) => s.paragraphs.some((p) => p.kind === 'list'))!;
    expect(planSection(section, kybalion, 'text').mode).toBe('none');
    expect(planSection(section, kybalion, 'kinetic').mode).toBe('kinetic');
    expect(planSection(section, kybalion, 'list').mode).toBe('diagram');
  });
});

describe('07-2: schema-valid, M1 modes only', () => {
  test('every plan of every book validates; image/quote/figure never produced', () => {
    for (const book of [kant, kybalion, ...mdFixtures, ...epubFixtures]) {
      for (const plan of planBook(book).values()) {
        expect(VisualPlanSchema.safeParse(plan).success).toBe(true);
        expect(['diagram', 'kinetic', 'none']).toContain(plan.mode);
      }
    }
  });
});

describe('07-3: verbatim anchors and key terms', () => {
  test('all samples and fixtures', () => {
    const problems: string[] = [];
    let cues = 0;
    for (const book of [kant, kybalion, ...mdFixtures, ...epubFixtures]) {
      const sentences = new Map(
        book.chapters.flatMap((c) => c.sections.flatMap((s) => s.paragraphs.flatMap((p) => p.sentences.map((x) => [x.id, x.text] as const)))),
      );
      for (const chapter of book.chapters) {
        for (const section of chapter.sections) {
          const plan = planSection(section, book);
          cues += plan.cues.length;
          const sectionText = section.paragraphs.map((p) => p.displayText).join('\n');
          problems.push(...planTextProblems(plan, { sentenceText: (id) => sentences.get(id), sectionText }));
        }
      }
    }
    expect(cues).toBeGreaterThan(20);
    expect(problems).toEqual([]);
  });
});

describe('07-4: Kybalion seven-item list', () => {
  test('list diagram with 7 reveal cues', () => {
    const plans = [...planBook(kybalion).values()];
    const list = plans.find((p) => p.diagram?.items.length === 7)!;
    expect(list.mode).toBe('diagram');
    expect(list.diagram?.template).toBe('list');
    expect(list.cues.filter((c) => c.action.type === 'reveal').length).toBe(7);
    expect(list.diagram?.items[0]?.label).toBe('The Principle of Mentalism.');
  });
});
