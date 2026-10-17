import { describe, expect, test } from 'bun:test';
import { buildTimeline, type BookBundle } from '@lesebuehne/core';
import { ingestFile, toBundle } from '@lesebuehne/ingest';
import { IDBFactory } from 'fake-indexeddb';
import { EPUB_CASES } from '../../../ingest/test/fixtures/epub-builder.ts';
import { IndexedDbRepository } from '../../src/storage/indexeddb.ts';
import { LibraryService, restorePosition } from '../../src/storage/library.ts';
import { MemoryRepository, type LibraryRepository } from '../../src/storage/repository.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const bundleOf = (fileName: string, bytes: Uint8Array, importedAt = new Date('2026-10-17T10:00:00Z')): BookBundle =>
  toBundle(ingestFile({ fileName, bytes }), { fileName, size: bytes.length, importedAt });
const textBook = bundleOf('a.txt', enc('Titel\n\nErster Satz. Zweiter Satz.\n\n\nKapitel 2\n\nDritter Satz.'));
const figureBook = bundleOf('figure.epub', EPUB_CASES.figure!());

const repos: Array<[string, () => LibraryRepository]> = [
  ['MemoryRepository', () => new MemoryRepository()],
  ['IndexedDbRepository', () => new IndexedDbRepository(new IDBFactory())],
];

describe('10-1: repository contract', () => {
  for (const [name, make] of repos) {
    test(`${name}: books, assets, positions, bookmarks, overrides`, async () => {
      const r = make();
      await r.open();
      expect(await r.listBooks()).toEqual([]);
      await r.putBundle(textBook);
      await r.putBundle(figureBook);
      expect((await r.listBooks()).map((m) => m.bookId).sort()).toEqual([textBook.book.id, figureBook.book.id].sort());
      expect(await r.hasBook(textBook.book.id)).toBe(true);
      expect(await r.hasBook('b:none')).toBe(false);
      const back = await r.getBundle(figureBook.book.id);
      expect(back?.book).toEqual(figureBook.book);
      expect(back?.assets.map((a) => [a.path, a.mediaType, [...a.bytes]])).toEqual(figureBook.assets.map((a) => [a.path, a.mediaType, [...a.bytes]]));
      const pos = { sentenceId: 's', tokenIndex: 2, chapterId: 'c', updatedAt: 'x' };
      await r.putPosition(textBook.book.id, pos);
      expect(await r.getPosition(textBook.book.id)).toEqual(pos);
      const marks = [{ id: 'm1', sentenceId: 's', chapterId: 'c', excerpt: 'Erster', createdAt: 'x' }];
      await r.putBookmarks(textBook.book.id, marks);
      expect(await r.getBookmarks(textBook.book.id)).toEqual(marks);
      await r.putOverrides(textBook.book.id, { 'x:1': 'kinetic' });
      expect(await r.getOverrides(textBook.book.id)).toEqual({ 'x:1': 'kinetic' });
      expect(await r.getBookmarks('b:none')).toEqual([]);
      expect(await r.getOverrides('b:none')).toEqual({});
      expect(await r.getPosition('b:none')).toBeUndefined();
    });
  }
});

describe('10-2: same book reopens, modified book is a new entry', () => {
  test('re-import of the same text (other name) → existing entry, no duplicate', async () => {
    const lib = await LibraryService.create(new IndexedDbRepository(new IDBFactory()));
    expect(await lib.import(textBook)).toEqual({ bookId: textBook.book.id, existing: false, saved: true });
    const again = bundleOf('kopie.txt', enc('Titel\n\nErster Satz. Zweiter Satz.\n\n\nKapitel 2\n\nDritter Satz.'), new Date('2026-10-18T00:00:00Z'));
    expect(await lib.import(again)).toEqual({ bookId: textBook.book.id, existing: true, saved: true });
    expect((await lib.list()).length).toBe(1);
    await lib.setBookmarks(textBook.book.id, [{ id: 'm', sentenceId: 's', chapterId: 'c', excerpt: 'e', createdAt: 'x' }]);
    const modified = bundleOf('a.txt', enc('Titel\n\nErster Satz. Geänderter Satz.\n\n\nKapitel 2\n\nDritter Satz.'));
    const outcome = await lib.import(modified);
    expect(outcome.existing).toBe(false);
    expect(outcome.bookId).not.toBe(textBook.book.id);
    expect((await lib.list()).length).toBe(2);
    expect((await lib.bookmarks(textBook.book.id)).length).toBe(1);
    expect(await lib.bookmarks(outcome.bookId)).toEqual([]);
  });
});

describe('10-3: delete cascades', () => {
  test('book, assets, position, bookmarks, overrides', async () => {
    const repo = new IndexedDbRepository(new IDBFactory());
    const lib = await LibraryService.create(repo);
    const id = figureBook.book.id;
    await lib.import(figureBook);
    await lib.savePosition(id, buildTimeline(figureBook.book), { entryIndex: 1, tokenIndex: 0 });
    await lib.setBookmarks(id, [{ id: 'm', sentenceId: 's', chapterId: 'c', excerpt: 'e', createdAt: 'x' }]);
    await lib.setOverrides(id, { a: 'text' });
    await lib.delete(id);
    expect(await repo.getBundle(id)).toBeUndefined();
    expect(await repo.getPosition(id)).toBeUndefined();
    expect(await repo.getBookmarks(id)).toEqual([]);
    expect(await repo.getOverrides(id)).toEqual({});
    expect(await lib.list()).toEqual([]);
  });
});

describe('10-4: restore with fallback', () => {
  const timeline = buildTimeline(textBook.book);
  test('existing sentence → that sentence; missing → its chapter start; else book start', async () => {
    const lib = await LibraryService.create(new MemoryRepository());
    await lib.import(textBook);
    await lib.savePosition(textBook.book.id, timeline, { entryIndex: 2, tokenIndex: 1 });
    expect(await lib.loadPosition(textBook.book.id, timeline)).toEqual({ entryIndex: 2, tokenIndex: 1 });
    const chapter2 = timeline.entries.findIndex((e) => e.chapterId === textBook.book.chapters[1]!.id);
    expect(restorePosition(timeline, { sentenceId: 'gone', tokenIndex: 3, chapterId: textBook.book.chapters[1]!.id })).toEqual({ entryIndex: chapter2, tokenIndex: 0 });
    expect(restorePosition(timeline, { sentenceId: 'gone', tokenIndex: 3, chapterId: 'c:gone' })).toEqual({ entryIndex: 0, tokenIndex: 0 });
    expect(restorePosition(timeline, undefined)).toEqual({ entryIndex: 0, tokenIndex: 0 });
  });
});

describe('10-5: session-only mode', () => {
  test('open failure → memory for the session, not saved', async () => {
    const broken: LibraryRepository = Object.assign(new MemoryRepository(), { open: () => Promise.reject(new Error('blocked')) });
    const lib = await LibraryService.create(broken);
    expect(lib.persistent).toBe(false);
    expect(await lib.import(textBook)).toEqual({ bookId: textBook.book.id, existing: false, saved: false });
    expect((await lib.get(textBook.book.id))?.book.id).toBe(textBook.book.id);
    expect((await LibraryService.create(undefined)).persistent).toBe(false);
  });
  test('QuotaExceededError on write → the book stays open for the session', async () => {
    const full = new MemoryRepository();
    full.putBundle = () => Promise.reject(new DOMException('full', 'QuotaExceededError'));
    const lib = await LibraryService.create(full);
    expect(lib.persistent).toBe(true);
    const outcome = await lib.import(figureBook);
    expect(outcome).toEqual({ bookId: figureBook.book.id, existing: false, saved: false });
    expect((await lib.get(figureBook.book.id))?.assets.length).toBe(1);
    expect((await lib.list()).map((m) => m.bookId)).toEqual([figureBook.book.id]);
  });
});
