import { describe, expect, test } from 'bun:test';
import {
  bookParagraphs,
  normalizeWhitespace,
  rebuildDisplayText,
  segmentSentences,
  tokenize,
  type Book,
} from '@lesebuehne/core';
import { decodeString } from 'micromark-util-decode-string';
import { IngestError, ingestFile, isTxtHeading, parseSamples, toBundle } from '../src/index.ts';
import { mapProblems } from '../../core/test/speech-check.ts';
import { stripMarkdown, words } from './reference/md-strip.ts';
import { sampleBytes, sampleTest, SAMPLES_DIR, withSamples } from '../../../tests/support/samples.ts';

const ROOT = new URL('../../../', import.meta.url);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const kantBytes = await sampleBytes('aufklaerung.txt');
const kybalionBytes = await sampleBytes('kybalion-chapter-2.md');
const fixtures = ['footnotes.md', 'inline.md', 'structure.md'];
const fixtureText = Object.fromEntries(
  await Promise.all(fixtures.map(async (f) => [f, await Bun.file(new URL(`fixtures/${f}`, import.meta.url)).text()] as const)),
);

const kant = withSamples(() => ingestFile({ fileName: 'aufklaerung.txt', bytes: kantBytes, language: 'de' }));
const kybalion = withSamples(() => ingestFile({ fileName: 'kybalion-chapter-2.md', bytes: kybalionBytes, language: 'en' }));
const md = (name: string): Book => ingestFile({ fileName: name, bytes: utf8(fixtureText[name] ?? ''), language: 'de' }).book;

describe('05-1: TXT paragraphs and headings', () => {
  const rows: Array<[string[], number, boolean, boolean]> = [
    [['Kapitel 3'], 1, false, true],
    [['CHAPTER IV'], 1, false, true],
    [['Teil Zwei'], 1, false, true],
    [['XIV'], 1, false, true],
    [['12'], 1, false, true],
    [['IV.'], 1, false, false],
    [['Ein Titel ohne Punkt'], 2, false, true],
    [['Ein Titel ohne Punkt'], 1, true, true],
    [['Ein Titel ohne Punkt'], 1, false, false],
    [['Kapitel drei endet mit Punkt.'], 2, false, false],
    [['Zeile, mit Komma,'], 3, false, false],
    [['Zwei', 'Zeilen'], 3, false, false],
    [['x'.repeat(101)], 3, false, false],
  ];
  for (const [lines, blankBefore, first, expected] of rows) {
    test(`${JSON.stringify(lines)} blank=${blankBefore} first=${first} → ${expected}`, () => {
      expect(isTxtHeading({ lines, blankBefore, first })).toBe(expected);
    });
  }

  test('paragraphs at blank lines; chapters at headings', () => {
    const r = ingestFile({ fileName: 'x.txt', bytes: utf8('Vorwort hier.\n\nKapitel 1\n\nText eins\nweiter.\n\n\n\nZweiter Teil\n\nText zwei.') });
    expect(r.book.chapters.map((c) => c.title)).toEqual(['', 'Kapitel 1', 'Zweiter Teil']);
    expect(bookParagraphs(r.book).map((p) => [p.kind, p.displayText])).toEqual([
      ['text', 'Vorwort hier.'],
      ['heading', 'Kapitel 1'],
      ['text', 'Text eins weiter.'],
      ['heading', 'Zweiter Teil'],
      ['text', 'Text zwei.'],
    ]);
  });

  sampleTest('Kant sample: one chapter with the title heading; [1] stays plain text', () => {
    expect(kant.book.chapters.length).toBe(1);
    const paras = bookParagraphs(kant.book);
    expect(paras[0]).toMatchObject({ kind: 'heading', displayText: 'Beantwortung der Frage: Was ist Aufklärung?' });
    expect(paras.filter((p) => p.kind === 'heading').length).toBe(1);
    expect(paras.some((p) => p.kind === 'footnote')).toBe(false);
    expect(paras.at(-1)!.displayText.startsWith('[1] In den Büschingschen')).toBe(true);
    expect(kant.book.title).toBe('Beantwortung der Frage: Was ist Aufklärung?');
  });
});

describe('05-2: TXT fidelity and stable IDs', () => {
  const cases: Array<[string, Uint8Array]> = [
    ...(kantBytes.length > 0 ? [['Kant sample', kantBytes] as [string, Uint8Array]] : []),
    ['BOM + CRLF', utf8('﻿Titel\r\n\r\nErste Zeile\r\nzweite  Zeile.\r\n\r\n\r\nNoch ein\tAbsatz.\r\n')],
    ['typographic spaces', utf8('Es sind 10 000 Bücher hier.\n\n  \n\nEnde.')],
  ];
  for (const [name, bytes] of cases) {
    test(`${name}: rebuilt text = normalised source`, () => {
      const source = new TextDecoder().decode(bytes).replace(/^﻿/, '');
      const r = ingestFile({ fileName: 'f.txt', bytes });
      expect(rebuildDisplayText(r.book)).toBe(normalizeWhitespace(source));
    });
  }

  sampleTest('same file twice → identical IDs; another file name → same book ID', () => {
    const again = ingestFile({ fileName: 'aufklaerung.txt', bytes: kantBytes, language: 'de' });
    expect(again.book).toEqual(kant.book);
    const renamed = ingestFile({ fileName: 'kant-kopie.txt', bytes: kantBytes, language: 'de' });
    expect(renamed.book.id).toBe(kant.book.id);
    const bundle = toBundle(renamed, { fileName: 'kant-kopie.txt', size: kantBytes.length, importedAt: new Date(0) });
    expect(bundle.manifest.bookId).toBe(kant.book.id);
  });
});

describe('05-3: Markdown structure', () => {
  test('headings, chapters, emphasis marks, lists, quotes', () => {
    const book = md('structure.md');
    expect(book.chapters.map((c) => c.title)).toEqual(['Erstes Kapitel', 'Zweites Kapitel']);
    const paras = bookParagraphs(book);
    expect(paras.map((p) => p.kind)).toEqual(['heading', 'text', 'heading', 'list', 'list', 'quote', 'figure', 'figure', 'figure', 'heading', 'text']);
    const list = paras[3]!;
    expect(list.displayText).toBe('erster Punkt zweiter Punkt mit Betonung dritter Punkt');
    expect(list.items?.map(([s, e]) => list.displayText.slice(s, e))).toEqual(['erster Punkt', 'zweiter Punkt mit Betonung', 'dritter Punkt']);
    expect(list.sentences.map((s) => s.text)).toEqual(['erster Punkt', 'zweiter Punkt mit Betonung', 'dritter Punkt']);
    expect(list.marks).toEqual([{ start: 31, end: 39, kind: 'em' }]);
    expect(paras[4]!.ordered).toBe(true);
    expect(paras[5]!.displayText).toBe('Ein Zitat über zwei Zeilen. Zweiter Zitatabsatz.');
    expect(paras[2]!.level).toBe(2);
    const inline = bookParagraphs(md('inline.md'))[1]!;
    expect(inline.marks?.map((m) => [m.kind, inline.displayText.slice(m.start, m.end)])).toEqual([
      ['em', 'Wort'],
      ['strong', 'starkem'],
      ['em', 'Kursiv'],
    ]);
  });

  test('images: data: kept, relative/remote → placeholder with alt text', () => {
    const figures = bookParagraphs(md('structure.md')).filter((p) => p.kind === 'figure');
    expect(figures.map((f) => f.figure)).toEqual([
      { alt: 'Ein Punkt', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
      { alt: 'Relatives Bild' },
      { alt: 'Fernes Bild' },
    ]);
    expect(figures.map((f) => f.displayText)).toEqual(['Ein Punkt', 'Relatives Bild', 'Fernes Bild']);
  });

  test('footnotes: FootnoteRef on the carrying token, footnote blocks at their position', () => {
    const book = md('footnotes.md');
    const paras = bookParagraphs(book);
    const s = paras[1]!.sentences;
    const carrier = (k: number) => s[k]!.tokens.find((t) => t.id === s[k]!.footnoteRefs?.[0]?.tokenId)?.text;
    expect(s[0]!.footnoteRefs).toEqual([{ tokenId: s[0]!.tokens[3]!.id, footnoteId: 'fn:1', label: '1' }]);
    expect(carrier(0)).toBe('Fußnote');
    expect(carrier(1)).toBe('einer');
    expect(s[0]!.text).toBe('Ein Satz mit Fußnote und weiter.');
    const notes = paras.filter((p) => p.kind === 'footnote');
    expect(notes.map((p) => [p.footnoteId, p.displayText])).toEqual([
      ['fn:1', 'Die erste Fußnote.'],
      ['fn:long', 'Eine längere Fußnote mit zwei Zeilen.'],
    ]);
    expect(book.chapters[0]!.sections[0]!.footnoteIds).toEqual(['fn:1', 'fn:long']);
  });
});

describe('05-4: Markdown fidelity', () => {
  const sources: Array<[string, string, Book, string]> = [
    ...fixtures.map((f): [string, string, Book, string] => [f, fixtureText[f] ?? '', md(f), 'de']),
    ...(kybalion ? [['Kybalion sample', new TextDecoder().decode(kybalionBytes), kybalion.book, 'en'] as [string, string, Book, string]] : []),
  ];
  for (const [name, source, book] of sources) {
    test(`${name}: (a) decoded source pieces = token text`, () => {
      const problems: string[] = [];
      let count = 0;
      for (const p of bookParagraphs(book)) {
        for (const s of p.sentences) {
          for (const t of s.tokens) {
            count++;
            const decoded = (t.src ?? []).map(([a, b]) => decodeString(source.slice(a, b))).join('');
            if (decoded !== t.text) problems.push(`${JSON.stringify(t.text)} ← ${JSON.stringify(decoded)}`);
          }
        }
      }
      expect(count).toBeGreaterThan(5);
      expect(problems).toEqual([]);
    });
  }
  for (const [name, source, book, lang] of sources) {
    test(`${name}: (b) word sequence = reference stripper`, () => {
      expect(words(rebuildDisplayText(book), lang)).toEqual(words(stripMarkdown(source), lang));
    });
  }
  test('mid-word emphasis keeps two source pieces', () => {
    const source = fixtureText['inline.md'] ?? '';
    const token = bookParagraphs(md('inline.md'))[1]!.sentences[0]!.tokens.find((t) => t.text === 'Wortteil')!;
    expect(token.src?.length).toBe(2);
    expect(token.src?.map(([a, b]) => source.slice(a, b))).toEqual(['Wort', 'teil']);
  });
  test('the reference stripper is independent of the ingest code', async () => {
    const code = await Bun.file(new URL('reference/md-strip.ts', import.meta.url)).text();
    expect(code).not.toMatch(/from ['"][^'"]*(src\/|mdast|micromark)/);
  });
});

describe('05-5: samples', () => {
  test('the sample catalog is valid and lists both samples', async () => {
    const samples = parseSamples(await Bun.file(new URL('scripts/samples.catalog.json', ROOT)).json());
    expect(samples.samples.map((s) => [s.file, s.language, s.format])).toEqual([
      ['aufklaerung.txt', 'de', 'txt'],
      ['kybalion-chapter-2.md', 'en', 'md'],
    ]);
    expect(() => parseSamples({ samples: [{ ...samples.samples[0], apiKey: 'x' }] })).toThrow();
  });
  sampleTest('no trademark string in the generated samples', async () => {
    for (const f of ['aufklaerung.txt', 'kybalion-chapter-2.md', 'samples.json']) {
      expect((await Bun.file(new URL(f, SAMPLES_DIR)).text()).toLowerCase()).not.toContain('project gutenberg');
    }
  });
  sampleTest('Kybalion: headings, ordered list, block quotes', () => {
    const paras = bookParagraphs(kybalion.book);
    const headings = paras.filter((p) => p.kind === 'heading').map((p) => p.displayText);
    expect(headings.slice(0, 3)).toEqual(['CHAPTER II', 'THE SEVEN HERMETIC PRINCIPLES', '1. The Principle of Mentalism']);
    expect(headings.length).toBe(9);
    expect(kybalion.book.chapters.length).toBe(1);
    const list = paras.find((p) => p.kind === 'list')!;
    expect(list.ordered).toBe(true);
    expect(list.items?.length).toBe(7);
    expect(paras.filter((p) => p.kind === 'quote').length).toBe(8);
  });
});

describe('05-6: errors', () => {
  const code = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (e) {
      return e instanceof IngestError ? e.code : 'other';
    }
    return undefined;
  };
  test('unsupported, unreadable, empty', () => {
    expect(code(() => ingestFile({ fileName: 'x.pdf', bytes: utf8('x') }))).toBe('unsupported');
    expect(code(() => ingestFile({ fileName: 'noext', bytes: utf8('x') }))).toBe('unsupported');
    expect(code(() => ingestFile({ fileName: 'x.txt', bytes: new Uint8Array([0xff, 0xfe, 0x00, 0xd8]) }))).toBe('unreadable');
    expect(code(() => ingestFile({ fileName: 'x.md', bytes: new Uint8Array([0xc3, 0x28]) }))).toBe('unreadable');
    expect(code(() => ingestFile({ fileName: 'x.txt', bytes: new Uint8Array() }))).toBe('empty');
    expect(code(() => ingestFile({ fileName: 'x.txt', bytes: utf8(' \n\n \t') }))).toBe('empty');
    expect(code(() => ingestFile({ fileName: 'x.md', bytes: utf8('<!-- nur HTML -->\n\n---') }))).toBe('empty');
    expect(new IngestError('drm', 'x').code).toBe('drm');
  });
});

describe('05-7: offset map holds for every sentence of both samples', () => {
  for (const [name, r] of [
    ['Kant', kant],
    ['Kybalion', kybalion],
  ] as const) {
    sampleTest(name, () => {
      const problems: string[] = [];
      let n = 0;
      for (const p of bookParagraphs(r.book)) {
        for (const s of p.sentences) {
          n++;
          for (const x of mapProblems(s.tokens, { speechText: s.speechText, map: s.speechMap })) problems.push(`${s.text}: ${x}`);
          // the sentence tokens are the tokens of its text
          expect(s.tokens.map((t) => t.text)).toEqual(tokenize(s.text, r.book.language).map((t) => t.text));
        }
      }
      expect(n).toBeGreaterThan(30);
      expect(problems).toEqual([]);
      expect(segmentSentences('', 'de')).toEqual([]);
    });
  }
});
