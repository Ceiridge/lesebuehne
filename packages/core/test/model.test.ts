import { describe, expect, test } from 'bun:test';
import {
  assembleBook,
  bookParagraphs,
  BookBundleSchema,
  BookSchema,
  buildTimeline,
  entryIndexAt,
  estimateSeconds,
  packSections,
  planTextProblems,
  rebuildDisplayText,
  tokenTime,
  VisualPlanSchema,
  type AssembleInput,
  type BlockInput,
  type Book,
  type PackItem,
} from '../src/index.ts';

const text = (t: string): BlockInput => ({ kind: 'text', text: t });
const heading = (t: string, level = 1): BlockInput => ({ kind: 'heading', level, text: t });

function sample(): AssembleInput {
  return {
    language: 'de',
    title: 'Probe',
    chapters: [
      {
        blocks: [
          heading('Erstes Kapitel'),
          text('Habe Mut, dich deines eigenen Verstandes zu bedienen! Das ist der Wahlspruch.'),
          text('Faulheit und Feigheit sind die Ursachen.'),
          text('Faulheit und Feigheit sind die Ursachen.'),
          { kind: 'figure', text: 'Ein Bild', figure: { alt: 'Ein Bild' } },
        ],
      },
      { blocks: [heading('Zweites Kapitel'), text('Es ist so bequem, unmündig zu sein.'), text('Ein Buch, das für mich Verstand hat.')] },
      { blocks: [heading('Erstes Kapitel'), text('Wiederholung des Titels.')] },
    ],
  };
}

/** Every ID in the book, keyed by a stable path for comparison. */
function ids(book: Book): Map<string, string> {
  const out = new Map<string, string>([['book', book.id]]);
  for (const [c, ch] of book.chapters.entries()) {
    out.set(`c${c}`, ch.id);
    for (const [s, sec] of ch.sections.entries()) {
      out.set(`c${c}/x${s}`, sec.id);
      for (const p of sec.paragraphs) {
        out.set(`para:${p.id}`, p.id);
        for (const sen of p.sentences) {
          out.set(`sent:${sen.id}`, sen.id);
          for (const t of sen.tokens) out.set(`tok:${t.id}`, t.id);
        }
      }
    }
  }
  return out;
}

describe('04-1: schemas', () => {
  const book = assembleBook(sample());

  test('an assembled book is valid; unknown keys are rejected', () => {
    expect(BookSchema.safeParse(book).success).toBe(true);
    expect(BookSchema.safeParse({ ...book, apiKey: 'sk-x' }).success).toBe(false);
    const bad = structuredClone(book);
    (bad.chapters[0]!.sections[0]!.paragraphs[0]!.sentences[0]!.tokens[0] as Record<string, unknown>).secret = 1;
    expect(BookSchema.safeParse(bad).success).toBe(false);
  });

  test('tokens: noteRef flag, src list of ranges; footnote refs', () => {
    const md = assembleBook({
      language: 'de',
      title: 'x',
      chapters: [
        {
          blocks: [
            {
              kind: 'text',
              text: 'Das Wortteil hier.',
              // source "Das *Wort*teil hier." → display offsets map around the `*`
              charSources: [...'Das Wortteil hier.'].map((_, k): [number, number] =>
                k < 4 ? [k, k + 1] : k < 8 ? [k + 1, k + 2] : [k + 2, k + 3],
              ),
              noteRefs: [{ at: 12, length: 0, footnoteId: 'fn1', label: '1' }],
            },
            { kind: 'footnote', footnoteId: 'fn1', text: 'Die Fußnote.' },
          ],
        },
      ],
    });
    expect(BookSchema.safeParse(md).success).toBe(true);
    const sentence = md.chapters[0]!.sections[0]!.paragraphs[0]!.sentences[0]!;
    const word = sentence.tokens.find((t) => t.text === 'Wortteil')!;
    expect(word.src).toEqual([
      [5, 9],
      [10, 14],
    ]);
    expect(sentence.footnoteRefs).toEqual([{ tokenId: word.id, footnoteId: 'fn1', label: '1' }]);

    const epub = assembleBook({
      language: 'de',
      title: 'x',
      chapters: [{ blocks: [{ kind: 'text', text: 'Ein Wort1 hier.', noteRefs: [{ at: 8, length: 1, footnoteId: 'n', label: '1' }] }] }],
    });
    const s2 = epub.chapters[0]!.sections[0]!.paragraphs[0]!.sentences[0]!;
    const label = s2.tokens.find((t) => t.noteRef)!;
    expect(label.text).toBe('1');
    expect(s2.tokens.map((t) => t.text)).toEqual(['Ein', 'Wort', '1', 'hier', '.']);
    expect(s2.speechText).toBe('Ein Wort hier.');
    expect(s2.footnoteRefs?.[0]?.tokenId).toBe(label.id);
  });

  const manifest = {
    schemaVersion: 1,
    bookId: book.id,
    title: 'Probe',
    language: 'de',
    languageSupport: 'full',
    format: 'txt',
    source: { fileName: 'probe.txt', size: 10 },
    importedAt: '2026-10-17T10:00:00.000Z',
    assets: [{ path: 'img/a.png', mediaType: 'image/png' }],
  };

  test('BookBundle is strict and consistent', () => {
    const bundle = { manifest, book, assets: [{ path: 'img/a.png', mediaType: 'image/png', bytes: new Uint8Array([1]) }] };
    expect(BookBundleSchema.safeParse(bundle).success).toBe(true);
    expect(BookBundleSchema.safeParse({ ...bundle, manifest: { ...manifest, apiKey: 'sk' } }).success).toBe(false);
    expect(BookBundleSchema.safeParse({ ...bundle, apiKey: 'sk' }).success).toBe(false);
    expect(BookBundleSchema.safeParse({ ...bundle, manifest: { ...manifest, bookId: 'b:other' } }).success).toBe(false);
    expect(BookBundleSchema.safeParse({ ...bundle, manifest: { ...manifest, schemaVersion: 2 } }).success).toBe(false);
    expect(
      BookBundleSchema.safeParse({ ...bundle, assets: [{ path: 'x.png', mediaType: 'image/png', bytes: new Uint8Array() }] })
        .success,
    ).toBe(false);
  });

  test('VisualPlan: modes, list diagram, cues', () => {
    const list = {
      version: 'v',
      mode: 'diagram',
      rationale: 'list',
      keyTerms: ['Mut'],
      cues: [
        { anchor: { sentenceId: 's1', phrase: 'Mut' }, action: { type: 'reveal', itemId: 'i1' } },
        { anchor: { sentenceId: 's1', phrase: 'Mut' }, action: { type: 'showTerm', term: 'Mut' } },
      ],
      diagram: { template: 'list', items: [{ id: 'i1', label: 'Mut' }] },
      fallback: 'kinetic',
    };
    expect(VisualPlanSchema.safeParse(list).success).toBe(true);
    const quote = { sentenceId: 's1', phrase: 'Mut' };
    const image = { prompt: 'p', aspect: '16:9' as const, focusRegions: [{ id: 'r', label: 'x', x: 0, y: 0, w: 1, h: 1 }] };
    expect(VisualPlanSchema.safeParse({ ...list, mode: 'quote', diagram: undefined, cues: [], quote }).success).toBe(true);
    expect(VisualPlanSchema.safeParse({ ...list, mode: 'quote', diagram: undefined, cues: [] }).success).toBe(false);
    expect(VisualPlanSchema.safeParse({ ...list, mode: 'image', diagram: undefined, cues: [], image }).success).toBe(true);
    expect(VisualPlanSchema.safeParse({ ...list, mode: 'animation', animation: { brief: 'b' } }).success).toBe(true);
    expect(
      VisualPlanSchema.safeParse({ ...list, mode: 'image', diagram: undefined, image, cues: [{ anchor: { sentenceId: 's', phrase: 'x' }, action: { type: 'focus', regionId: 'zz' } }] }).success,
    ).toBe(false);
    for (const mode of ['kinetic', 'none', 'figure']) {
      expect(VisualPlanSchema.safeParse({ ...list, mode, diagram: undefined, cues: [] }).success).toBe(true);
    }
    expect(VisualPlanSchema.safeParse({ ...list, mode: 'video' }).success).toBe(false);
    expect(VisualPlanSchema.safeParse({ ...list, diagram: undefined }).success).toBe(false);
    expect(VisualPlanSchema.safeParse({ ...list, diagram: { template: 'cycle', items: [] } }).success).toBe(false);
    expect(
      VisualPlanSchema.safeParse({ ...list, cues: [{ anchor: { sentenceId: 's', phrase: 'x' }, action: { type: 'reveal', itemId: 'zz' } }] })
        .success,
    ).toBe(false);
    expect(VisualPlanSchema.safeParse({ ...list, fallback: 'image' }).success).toBe(false);
    expect(VisualPlanSchema.safeParse({ ...list, extra: 1 }).success).toBe(false);
    const plan = VisualPlanSchema.parse(list);
    expect(planTextProblems(plan, { sentenceText: () => 'Habe Mut!', sectionText: 'Habe Mut!' })).toEqual([]);
    expect(planTextProblems(plan, { sentenceText: () => 'Habe Angst!', sectionText: 'Habe Angst!' }).length).toBe(3);
  });
});

describe('04-2: assembleBook IDs and edit scope', () => {
  test('ID formulas and re-assembly', () => {
    const a = assembleBook(sample());
    const b = assembleBook(sample());
    expect(b).toEqual(a);
    expect(a.id).toMatch(/^b:[0-9a-f]{28}$/);
    const [c0, , c2] = a.chapters;
    expect(c0!.id).toMatch(/^c:[0-9a-f]{28}:0$/);
    // same heading text → same hash, next occurrence
    expect(c2!.id).toBe(c0!.id.replace(/:0$/, ':1'));
    const paras = bookParagraphs(a);
    const dup = paras.filter((p) => p.displayText === 'Faulheit und Feigheit sind die Ursachen.');
    expect(dup.map((p) => p.id.split(':')[2])).toEqual(['0', '1']);
    const s = paras[1]!.sentences[1]!;
    expect(s.id.startsWith(`${paras[1]!.id}/`)).toBe(true);
    expect(s.tokens[2]!.id).toBe(`${s.id}#2`);
    expect(c0!.sections[0]!.id).toMatch(/^x:[0-9a-f]{28}$/);
  });

  test('metadata and title do not change IDs except through text; language does', () => {
    const a = assembleBook(sample());
    const b = assembleBook({ ...sample(), title: 'Anders', author: 'Kant' });
    expect([...ids(b)]).toEqual([...ids(a)]);
    expect(assembleBook({ ...sample(), language: 'de-AT' }).id).not.toBe(a.id);
  });

  test('editing one paragraph changes only the allowed set', () => {
    const before = assembleBook(sample());
    const input = sample();
    // P = the first duplicate paragraph of chapter 0
    input.chapters[0]!.blocks[2] = text('Faulheit ist die Ursache.');
    const after = assembleBook(input);
    const pBefore = bookParagraphs(before);
    const pAfter = bookParagraphs(after);
    const changed = pAfter.filter((p, k) => p.id !== pBefore[k]!.id).map((p) => p.displayText);
    // P itself and the later duplicate of P's old text (its occurrence index shifts)
    expect(changed).toEqual(['Faulheit ist die Ursache.', 'Faulheit und Feigheit sind die Ursachen.']);
    expect(after.id).not.toBe(before.id);
    // other chapters keep every ID
    for (const c of [1, 2]) expect(after.chapters[c]).toEqual(before.chapters[c]!);
    expect(after.chapters[0]!.id).toBe(before.chapters[0]!.id);
  });

  test('a longer paragraph repacks only from its section to the chapter end', () => {
    const long = 'Wort '.repeat(300).trim() + '.';
    const blocks = (mid: string): BlockInput[] => [
      heading('Kapitel'),
      text('Erster Absatz.'),
      text('Zweiter Absatz.'),
      text(mid),
      text('Vierter Absatz.'),
      text('Fünfter Absatz.'),
      heading('Unterkapitel', 2),
      text('Sechster Absatz.'),
    ];
    const a = assembleBook({ language: 'de', title: 't', chapters: [{ blocks: blocks('Dritter Absatz.') }] });
    const b = assembleBook({ language: 'de', title: 't', chapters: [{ blocks: blocks(long) }] });
    const secA = a.chapters[0]!.sections;
    const secB = b.chapters[0]!.sections;
    expect(secA.map((s) => s.paragraphs.length)).toEqual([5, 1, 2]);
    expect(secB.map((s) => s.paragraphs.length)).toEqual([3, 1, 2, 2]);
    // the section after the next heading keeps its ID
    expect(secB.at(-1)!.id).toBe(secA.at(-1)!.id);
  });
});

describe('04-3: section packing', () => {
  const t = (duration = 10): PackItem => ({ kind: 'text', duration });
  test('heading starts a section and does not count toward the cap', () => {
    expect(packSections([t(), { kind: 'heading', duration: 1 }, t(), t(), t(), t(), t()])).toEqual([[0], [1, 2, 3, 4, 5], [6]]);
  });
  test('fewer than 4 counted paragraphs', () => {
    expect(packSections([t(), t(), t(), t(), t()])).toEqual([[0, 1, 2, 3], [4]]);
  });
  test('≤ 90 s including the next paragraph', () => {
    expect(packSections([t(40), t(50), t(1)])).toEqual([[0, 1], [2]]);
    expect(packSections([t(40), t(51)])).toEqual([[0], [1]]);
  });
  test('an oversized paragraph forms its own section', () => {
    expect(packSections([t(10), t(200), t(10)])).toEqual([[0], [1], [2]]);
  });
  test('list and quote count as one paragraph each', () => {
    const list: PackItem = { kind: 'list', duration: 10 };
    const quote: PackItem = { kind: 'quote', duration: 10 };
    expect(packSections([list, quote, quote, t(), t()])).toEqual([[0, 1, 2, 3], [4]]);
  });
  test('figures and footnotes are members with 0 s outside the cap', () => {
    const fig: PackItem = { kind: 'figure', duration: 500 };
    const fn: PackItem = { kind: 'footnote', duration: 500 };
    expect(packSections([fig, t(), fn, t(), fig, t(), t(), fn, t()])).toEqual([[0, 1, 2, 3, 4, 5, 6, 7], [8]]);
  });
  test('a footnote is attached to the section of its first reference', () => {
    const ref = (k: number): BlockInput => ({
      kind: 'text',
      text: `Absatz ${k} mit Verweis.`,
      noteRefs: [{ at: 10, length: 0, footnoteId: 'f', label: '1' }],
    });
    const book = assembleBook({
      language: 'de',
      title: 't',
      chapters: [
        {
          blocks: [
            text('A.'),
            text('B.'),
            text('C.'),
            text('D.'),
            ref(5),
            ref(6),
            heading('H'),
            { kind: 'footnote', footnoteId: 'f', text: 'Fußnote.' },
          ],
        },
      ],
    });
    const sections = book.chapters[0]!.sections;
    expect(sections.map((s) => s.footnoteIds ?? [])).toEqual([[], ['f'], []]);
    expect(sections[2]!.paragraphs.map((p) => p.kind)).toEqual(['heading', 'footnote']);
    expect(sections[2]!.duration).toBe(sections[2]!.paragraphs[0]!.sentences[0]!.duration);
  });
});

describe('04-4: duration and time axis', () => {
  test('rates and tempo', () => {
    expect(estimateSeconds('x'.repeat(140), 'de')).toBe(10);
    expect(estimateSeconds('x'.repeat(150), 'en-GB')).toBe(10);
    expect(estimateSeconds('x'.repeat(140), 'fr')).toBe(10);
    expect(estimateSeconds('x'.repeat(140), 'de', 2)).toBe(5);
    expect(() => estimateSeconds('x', 'de', 0)).toThrow();
  });

  test('time axis: flow sentences only, monotonic, tokens inside their span', () => {
    const book = assembleBook({
      language: 'de',
      title: 't',
      chapters: [
        {
          blocks: [
            heading('Titel'),
            text('Am 3. Mai 1784 kam er. Dann ging er.'),
            { kind: 'figure', text: 'Bildunterschrift.', figure: { alt: '' } },
            { kind: 'footnote', footnoteId: 'f', text: 'Fußnote hier.' },
            text('Ende.'),
          ],
        },
      ],
    });
    const tl = buildTimeline(book);
    expect(tl.entries.map((e) => e.sentence.text)).toEqual(['Titel', 'Am 3. Mai 1784 kam er.', 'Dann ging er.', 'Ende.']);
    let last = 0;
    for (const e of tl.entries) {
      expect(e.start).toBe(last);
      expect(e.end).toBeGreaterThan(e.start);
      last = e.end;
      let prev = e.start;
      for (const [k] of e.sentence.tokens.entries()) {
        const time = tokenTime(e, k);
        expect(time).toBeGreaterThanOrEqual(prev);
        expect(time).toBeLessThanOrEqual(e.end);
        prev = time;
      }
    }
    expect(tl.duration).toBe(last);
    expect(entryIndexAt(tl, 0)).toBe(0);
    expect(entryIndexAt(tl, tl.entries[2]!.start + 0.01)).toBe(2);
    expect(entryIndexAt(tl, 1e9)).toBe(3);
    expect(tl.indexOf.get(tl.entries[1]!.sentence.id)).toBe(1);
  });
});

describe('04-5: rebuildDisplayText', () => {
  test('blocks joined by a blank line; whitespace normalised per block', () => {
    const book = assembleBook({
      language: 'de',
      title: 't',
      chapters: [{ blocks: [heading('  Titel '), text('Zeile eins\nZeile  zwei.')] }, { blocks: [text('Drei.')] }],
    });
    expect(rebuildDisplayText(book)).toBe('Titel\n\nZeile eins Zeile zwei.\n\nDrei.');
  });
});
