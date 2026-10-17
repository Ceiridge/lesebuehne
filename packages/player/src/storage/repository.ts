import type { Asset, BookBundle, Manifest } from '@lesebuehne/core';
import type { ForcedMode } from '@lesebuehne/director';

/** A library entry (the manifest without the book). */
export type LibraryEntry = Manifest;

export interface StoredPosition {
  sentenceId: string;
  tokenIndex: number;
  /** Chapter of the sentence, for the fallback when the sentence no longer exists (B6). */
  chapterId: string;
  updatedAt: string;
}

export interface Bookmark {
  id: string;
  sentenceId: string;
  chapterId: string;
  excerpt: string;
  createdAt: string;
}

export type VisualOverrides = Record<string, ForcedMode>;

/** Persistence of the library (B6). One implementation per backend, one contract suite for all. */
export interface LibraryRepository {
  open(): Promise<void>;
  listBooks(): Promise<LibraryEntry[]>;
  hasBook(bookId: string): Promise<boolean>;
  getBundle(bookId: string): Promise<BookBundle | undefined>;
  putBundle(bundle: BookBundle): Promise<void>;
  /** Removes the book with its assets, position, bookmarks and overrides. */
  deleteBook(bookId: string): Promise<void>;
  getPosition(bookId: string): Promise<StoredPosition | undefined>;
  putPosition(bookId: string, position: StoredPosition): Promise<void>;
  getBookmarks(bookId: string): Promise<Bookmark[]>;
  putBookmarks(bookId: string, bookmarks: Bookmark[]): Promise<void>;
  getOverrides(bookId: string): Promise<VisualOverrides>;
  putOverrides(bookId: string, overrides: VisualOverrides): Promise<void>;
}

/** In-memory repository: tests and the session-only mode (B6). */
export class MemoryRepository implements LibraryRepository {
  private readonly books = new Map<string, { manifest: Manifest; book: BookBundle['book'] }>();
  private readonly assets = new Map<string, Asset[]>();
  private readonly positions = new Map<string, StoredPosition>();
  private readonly bookmarks = new Map<string, Bookmark[]>();
  private readonly overrides = new Map<string, VisualOverrides>();

  async open(): Promise<void> {}
  async listBooks(): Promise<LibraryEntry[]> {
    return [...this.books.values()].map((b) => structuredClone(b.manifest));
  }
  async hasBook(bookId: string): Promise<boolean> {
    return this.books.has(bookId);
  }
  async getBundle(bookId: string): Promise<BookBundle | undefined> {
    const b = this.books.get(bookId);
    return b ? structuredClone({ manifest: b.manifest, book: b.book, assets: this.assets.get(bookId) ?? [] }) : undefined;
  }
  async putBundle(bundle: BookBundle): Promise<void> {
    const copy = structuredClone(bundle);
    this.books.set(copy.book.id, { manifest: copy.manifest, book: copy.book });
    this.assets.set(copy.book.id, copy.assets);
  }
  async deleteBook(bookId: string): Promise<void> {
    for (const m of [this.books, this.assets, this.positions, this.bookmarks, this.overrides]) m.delete(bookId);
  }
  async getPosition(bookId: string): Promise<StoredPosition | undefined> {
    const p = this.positions.get(bookId);
    return p ? { ...p } : undefined;
  }
  async putPosition(bookId: string, position: StoredPosition): Promise<void> {
    this.positions.set(bookId, { ...position });
  }
  async getBookmarks(bookId: string): Promise<Bookmark[]> {
    return structuredClone(this.bookmarks.get(bookId) ?? []);
  }
  async putBookmarks(bookId: string, bookmarks: Bookmark[]): Promise<void> {
    this.bookmarks.set(bookId, structuredClone(bookmarks));
  }
  async getOverrides(bookId: string): Promise<VisualOverrides> {
    return { ...(this.overrides.get(bookId) ?? {}) };
  }
  async putOverrides(bookId: string, overrides: VisualOverrides): Promise<void> {
    this.overrides.set(bookId, { ...overrides });
  }
}
