import { afterAll, describe, expect, test } from 'bun:test';
import { bookParagraphs, buildTimeline, rebuildDisplayText, type Book } from '@lesebuehne/core';
import { IngestError, ingestFile, toBundle } from '../src/index.ts';
import { EPUB_CASES } from './fixtures/epub-builder.ts';
import { epubSourceText } from './reference/epub-text.ts';
import { words } from './reference/md-strip.ts';
import { writeFixtures } from '../../../scripts/fixtures.ts';

const ingest = (name: string, language?: string) =>
  ingestFile({ fileName: `${name}.epub`, bytes: EPUB_CASES[name]!(), ...(language ? { language } : {}) });
const texts = (book: Book) => bookParagraphs(book).map((p) => [p.kind, p.displayText]);

describe('06-1: EPUB structure', () => {
  test('EPUB 3: spine order, TOC titles (else first heading), headings, lists, quotes, emphasis', () => {
    const { book } = ingest('epub3-nav');
    expect(book.title).toBe('Drei Kapitel');
    expect(book.author).toBe('Test Autor');
    expect(book.chapters.map((c) => c.title)).toEqual(['Kapitel Eins', 'Zweites', 'Kapitel Drei']);
    expect(texts(book)).toEqual([
      ['heading', 'Erstes'],
      ['text', 'Habe Mut, dich deines eigenen Verstandes zu bedienen!'],
      ['list', 'Faulheit Feigheit'],
      ['heading', 'Zweites'],
      ['quote', 'Sapere aude!'],
      ['text', 'Es ist so bequem, unmündig zu sein.'],
      ['text', 'Ohne Überschrift.'],
      ['list', 'Eins. Zwei.'],
    ]);
    const p = bookParagraphs(book);
    expect(p[1]!.marks?.map((m) => [m.kind, p[1]!.displayText.slice(m.start, m.end)])).toEqual([
      ['em', 'Mut'],
      ['strong', 'eigenen'],
    ]);
    expect(p[7]!.ordered).toBe(true);
    expect(p[7]!.items).toEqual([
      [0, 5],
      [6, 11],
    ]);
  });

  test('EPUB 2: NCX titles, HTML entities decoded', () => {
    const { book } = ingest('epub2-ncx-entities');
    expect(book.chapters.map((c) => c.title)).toEqual(['Café', 'Zweites']);
    expect(texts(book)[0]).toEqual(['heading', 'Café & Kuchen']);
    expect(texts(book)[1]![1]).toBe('Mut haben ä ü “so” — gut.');
  });

  test('footnotes: noteref tokens flagged, FootnoteRef, aside → footnote block', () => {
    const { book } = ingest('footnotes');
    const paras = bookParagraphs(book);
    const s = paras[1]!.sentences;
    const ref = s[0]!.footnoteRefs![0]!;
    const token = s[0]!.tokens.find((t) => t.id === ref.tokenId)!;
    expect(token).toMatchObject({ text: '1', noteRef: true });
    expect(ref).toMatchObject({ footnoteId: 'fn:OEBPS/kapitel1.xhtml#fn1', label: '1' });
    expect(s[1]!.footnoteRefs![0]).toMatchObject({ footnoteId: 'fn:OEBPS/notes.xhtml#n2', label: '2' });
    const notes = paras.filter((p) => p.kind === 'footnote');
    expect(notes.map((n) => [n.footnoteId, n.displayText])).toEqual([
      ['fn:OEBPS/kapitel1.xhtml#fn1', 'Die erste Fußnote.'],
      ['fn:OEBPS/notes.xhtml#n2', 'Die zweite Fußnote.'],
    ]);
  });
});

describe('06-2: figures', () => {
  test('image bytes and media type become assets; caption block is outside the speech flow', () => {
    const r = ingest('figure');
    const figures = bookParagraphs(r.book).filter((p) => p.kind === 'figure');
    expect(figures.map((f) => [f.displayText, f.figure])).toEqual([
      ['Ein kleiner Punkt.', { alt: 'Ein Punkt', asset: 'OEBPS/img/punkt.png' }],
      ['', { alt: 'Inline', asset: 'OEBPS/img/punkt.png' }],
    ]);
    expect(r.parsed.assets.map((a) => [a.path, a.mediaType, a.bytes.length > 0])).toEqual([['OEBPS/img/punkt.png', 'image/png', true]]);
    expect(texts(r.book).map(([k]) => k)).toEqual(['heading', 'text', 'figure', 'text', 'figure']);
    const flow = buildTimeline(r.book).entries.map((e) => e.sentence.text);
    expect(flow).toEqual(['Bild', 'Vor dem Bild.', 'Nach dem Bild.']);
    const bundle = toBundle(r, { fileName: 'figure.epub', size: 1, importedAt: new Date(0) });
    expect(bundle.manifest.assets).toEqual([{ path: 'OEBPS/img/punkt.png', mediaType: 'image/png' }]);
  });
});

describe('06-3: DRM', () => {
  const code = (name: string): string | undefined => {
    try {
      ingest(name);
    } catch (e) {
      return e instanceof IngestError ? e.code : 'other';
    }
    return undefined;
  };
  test('encryption with a non-font algorithm and rights.xml are rejected', () => {
    expect(code('encrypted')).toBe('drm');
    expect(code('rights')).toBe('drm');
  });
  test('font obfuscation only is accepted', () => {
    expect(code('font-obfuscation')).toBeUndefined();
  });
  test('broken archives are unreadable', () => {
    expect(() => ingestFile({ fileName: 'x.epub', bytes: new Uint8Array([1, 2, 3, 4]) })).toThrow(IngestError);
  });
});

describe('06-4: language', () => {
  test('dc:language → book language; full support for de', () => {
    const r = ingest('epub3-nav', 'en');
    expect(r.book.language).toBe('de');
    expect(r.needsLanguage).toBe(false);
    expect(r.languageSupport).toBe('full');
  });
  test('missing dc:language → needsLanguage, chosen language used', () => {
    const r = ingest('no-language', 'en');
    expect(r.needsLanguage).toBe(true);
    expect(r.book.language).toBe('en');
    expect(ingest('no-language').book.language).toBe('de');
  });
  test('fr → basic support, speech = display', () => {
    const r = ingest('lang-fr');
    expect(r.languageSupport).toBe('basic');
    for (const p of bookParagraphs(r.book)) for (const s of p.sentences) expect(s.speechText).toBe(s.text);
  });
});

describe('06-5: EPUB fidelity', () => {
  for (const name of Object.keys(EPUB_CASES).filter((n) => n !== 'encrypted' && n !== 'rights')) {
    test(`${name}: word sequence = reference walk`, () => {
      const bytes = EPUB_CASES[name]!();
      const r = ingestFile({ fileName: `${name}.epub`, bytes });
      expect(words(rebuildDisplayText(r.book), 'de')).toEqual(words(epubSourceText(bytes), 'de'));
    });
  }
  test('no whitespace between blocks still separates words', () => {
    const { book } = ingest('no-whitespace-blocks');
    expect(texts(book)).toEqual([
      ['heading', 'Titel'],
      ['text', 'Text.'],
      ['text', 'Ende.'],
      ['text', 'Anfang'],
      ['text', 'Zeile Umbruch'],
    ]);
  });
  test('the reference walk is independent of the ingest code', async () => {
    const code = await Bun.file(new URL('reference/epub-text.ts', import.meta.url)).text();
    expect(code).not.toMatch(/from ['"][^'"]*src\//);
  });
});

describe('06-6: skip-mode speech has no noteref label', () => {
  test('noteref tokens are silent', () => {
    const { book } = ingest('footnotes');
    const s = bookParagraphs(book)[1]!.sentences;
    expect(s.map((x) => x.speechText)).toEqual(['Ein Wort mit Fußnote.', 'Noch eine hier.']);
  });
});

describe('06-7: bun run fixtures', () => {
  const path = Bun.fileURLToPath(new URL(`../../../out/tmp/${crypto.randomUUID()}`, import.meta.url));
  afterAll(async () => {
    await Bun.$`rm -rf ${path}`.quiet().nothrow();
  });
  test('writes every EPUB case and every MD fixture', async () => {
    const written = await writeFixtures(path);
    const expected = [
      'epub3-nav',
      'epub2-ncx-entities',
      'footnotes',
      'figure',
      'lang-fr',
      'no-language',
      'encrypted',
      'rights',
      'font-obfuscation',
      'no-whitespace-blocks',
    ].map((n) => `${n}.epub`);
    expect(written).toEqual([...expected, 'footnotes.md', 'inline.md', 'structure.md']);
    for (const f of written) expect(await Bun.file(`${path}/${f}`).exists()).toBe(true);
    const back = ingestFile({ fileName: 'figure.epub', bytes: new Uint8Array(await Bun.file(`${path}/figure.epub`).arrayBuffer()) });
    expect(back.book.id).toBe(ingest('figure').book.id);
  });
});
