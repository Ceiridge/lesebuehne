import type { BookBundle, Timeline } from '@lesebuehne/core';
import type { Position } from '../engine/engine.ts';
import { MemoryRepository, type Bookmark, type LibraryEntry, type LibraryRepository, type StoredPosition, type VisualOverrides } from './repository.ts';

export interface ImportOutcome {
  bookId: string;
  /** The same book (same book ID, B2) was already in the library: no duplicate was made. */
  existing: boolean;
  /** false → the book is open for this session only; the player says it could not be saved. */
  saved: boolean;
}

/**
 * The library (B6) on top of a repository: same-book reopen, delete cascade, positions and
 * bookmarks with restore fallback. When the repository cannot open, everything runs in memory
 * for the session (`persistent = false`); a write that runs out of space keeps that book in the
 * session cache.
 */
export class LibraryService {
  private repo: LibraryRepository;
  private readonly session = new MemoryRepository();
  private readonly sessionOnly = new Set<string>();
  persistent = true;

  private constructor(repo: LibraryRepository) {
    this.repo = repo;
  }

  static async create(repo: LibraryRepository | undefined): Promise<LibraryService> {
    const service = new LibraryService(repo ?? new MemoryRepository());
    try {
      if (!repo) throw new Error('no storage');
      await repo.open();
    } catch {
      service.repo = service.session;
      service.persistent = false;
    }
    return service;
  }

  private repoFor(bookId: string): LibraryRepository {
    return this.sessionOnly.has(bookId) ? this.session : this.repo;
  }

  async list(): Promise<LibraryEntry[]> {
    const stored = await this.repo.listBooks().catch(() => []);
    const extra = this.repo === this.session ? [] : await this.session.listBooks();
    return [...stored, ...extra].sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  }

  async import(bundle: BookBundle): Promise<ImportOutcome> {
    const bookId = bundle.book.id;
    if (await this.repoFor(bookId).hasBook(bookId).catch(() => false)) return { bookId, existing: true, saved: this.persistent && !this.sessionOnly.has(bookId) };
    try {
      await this.repo.putBundle(bundle);
      return { bookId, existing: false, saved: this.persistent };
    } catch {
      // Out of space (QuotaExceededError) or any other failed write: open for this session only.
      this.sessionOnly.add(bookId);
      await this.session.putBundle(bundle);
      return { bookId, existing: false, saved: false };
    }
  }

  get(bookId: string): Promise<BookBundle | undefined> {
    return this.repoFor(bookId).getBundle(bookId);
  }

  async delete(bookId: string): Promise<void> {
    await this.repoFor(bookId).deleteBook(bookId);
    this.sessionOnly.delete(bookId);
  }

  private async write(bookId: string, fn: (r: LibraryRepository) => Promise<void>): Promise<void> {
    try {
      await fn(this.repoFor(bookId));
    } catch {
      await fn(this.session).catch(() => undefined);
    }
  }

  async savePosition(bookId: string, timeline: Timeline, p: Position): Promise<void> {
    const entry = timeline.entries[p.entryIndex];
    if (!entry) return;
    const position: StoredPosition = {
      sentenceId: entry.sentence.id,
      tokenIndex: p.tokenIndex,
      chapterId: entry.chapterId,
      updatedAt: new Date().toISOString(),
    };
    await this.write(bookId, (r) => r.putPosition(bookId, position));
  }

  async loadPosition(bookId: string, timeline: Timeline): Promise<Position> {
    const stored = await this.repoFor(bookId).getPosition(bookId).catch(() => undefined);
    return restorePosition(timeline, stored);
  }

  bookmarks(bookId: string): Promise<Bookmark[]> {
    return this.repoFor(bookId).getBookmarks(bookId).catch(() => []);
  }

  async setBookmarks(bookId: string, bookmarks: Bookmark[]): Promise<void> {
    await this.write(bookId, (r) => r.putBookmarks(bookId, bookmarks));
  }

  overrides(bookId: string): Promise<VisualOverrides> {
    return this.repoFor(bookId).getOverrides(bookId).catch(() => ({}));
  }

  async setOverrides(bookId: string, overrides: VisualOverrides): Promise<void> {
    await this.write(bookId, (r) => r.putOverrides(bookId, overrides));
  }
}

/**
 * Restores a stored position (B6): the stored sentence if it still exists, else the start of the
 * chapter that contained it, else the start of the book.
 */
export function restorePosition(timeline: Timeline, stored: Pick<StoredPosition, 'sentenceId' | 'tokenIndex' | 'chapterId'> | undefined): Position {
  if (!stored) return { entryIndex: 0, tokenIndex: 0 };
  const index = timeline.indexOf.get(stored.sentenceId);
  if (index !== undefined) {
    const tokens = timeline.entries[index]?.sentence.tokens.length ?? 1;
    return { entryIndex: index, tokenIndex: Math.min(Math.max(0, stored.tokenIndex), Math.max(0, tokens - 1)) };
  }
  const chapterStart = timeline.entries.findIndex((e) => e.chapterId === stored.chapterId);
  return { entryIndex: Math.max(0, chapterStart), tokenIndex: 0 };
}
