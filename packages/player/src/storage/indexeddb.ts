import type { Asset, BookBundle, Manifest } from '@lesebuehne/core';
import type { Bookmark, LibraryEntry, LibraryRepository, StoredPosition, VisualOverrides } from './repository.ts';

const DB_NAME = 'lesebuehne';
const DB_VERSION = 1;
const STORES = ['books', 'assets', 'positions', 'bookmarks', 'overrides'] as const;
type Store = (typeof STORES)[number];

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
  });
}

/**
 * IndexedDB repository (B6): `books` holds manifest + book, `assets` the image bytes keyed by
 * `[bookId, path]`, and one record per book in `positions`, `bookmarks` and `overrides`.
 */
export class IndexedDbRepository implements LibraryRepository {
  private db: IDBDatabase | undefined;

  constructor(private readonly factory: IDBFactory, private readonly name = DB_NAME) {}

  async open(): Promise<void> {
    if (this.db) return;
    const r = this.factory.open(this.name, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const store of STORES) {
        if (db.objectStoreNames.contains(store)) continue;
        if (store === 'assets') db.createObjectStore(store, { keyPath: ['bookId', 'path'] }).createIndex('bookId', 'bookId');
        else db.createObjectStore(store);
      }
    };
    this.db = await request(r);
  }

  private tx(stores: Store | Store[], mode: IDBTransactionMode): IDBTransaction {
    if (!this.db) throw new Error('IndexedDbRepository is not open');
    return this.db.transaction(stores, mode);
  }

  private async get<T>(store: Store, key: IDBValidKey): Promise<T | undefined> {
    return (await request(this.tx(store, 'readonly').objectStore(store).get(key))) as T | undefined;
  }

  private async put(store: Store, key: IDBValidKey, value: unknown): Promise<void> {
    const tx = this.tx(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    await done(tx);
  }

  async listBooks(): Promise<LibraryEntry[]> {
    const rows = (await request(this.tx('books', 'readonly').objectStore('books').getAll())) as Array<{ manifest: Manifest }>;
    return rows.map((r) => r.manifest);
  }

  async hasBook(bookId: string): Promise<boolean> {
    return (await request(this.tx('books', 'readonly').objectStore('books').count(bookId))) > 0;
  }

  async getBundle(bookId: string): Promise<BookBundle | undefined> {
    const row = await this.get<{ manifest: Manifest; book: BookBundle['book'] }>('books', bookId);
    if (!row) return undefined;
    const assets = (await request(
      this.tx('assets', 'readonly').objectStore('assets').index('bookId').getAll(bookId),
    )) as Array<Asset & { bookId: string }>;
    return { manifest: row.manifest, book: row.book, assets: assets.map(({ path, mediaType, bytes }) => ({ path, mediaType, bytes })) };
  }

  async putBundle(bundle: BookBundle): Promise<void> {
    const tx = this.tx(['books', 'assets'], 'readwrite');
    tx.objectStore('books').put({ manifest: bundle.manifest, book: bundle.book }, bundle.book.id);
    for (const a of bundle.assets) tx.objectStore('assets').put({ bookId: bundle.book.id, ...a });
    await done(tx);
  }

  async deleteBook(bookId: string): Promise<void> {
    const tx = this.tx([...STORES], 'readwrite');
    for (const store of STORES) {
      if (store === 'assets') {
        // Through the index, so no global IDBKeyRange is needed (the factory is injected).
        const assets = tx.objectStore(store);
        const cursor = assets.index('bookId').openKeyCursor(bookId);
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return;
          assets.delete(c.primaryKey);
          c.continue();
        };
      } else tx.objectStore(store).delete(bookId);
    }
    await done(tx);
  }

  getPosition(bookId: string): Promise<StoredPosition | undefined> {
    return this.get('positions', bookId);
  }
  putPosition(bookId: string, position: StoredPosition): Promise<void> {
    return this.put('positions', bookId, position);
  }
  async getBookmarks(bookId: string): Promise<Bookmark[]> {
    return (await this.get<Bookmark[]>('bookmarks', bookId)) ?? [];
  }
  putBookmarks(bookId: string, bookmarks: Bookmark[]): Promise<void> {
    return this.put('bookmarks', bookId, bookmarks);
  }
  async getOverrides(bookId: string): Promise<VisualOverrides> {
    return (await this.get<VisualOverrides>('overrides', bookId)) ?? {};
  }
  putOverrides(bookId: string, overrides: VisualOverrides): Promise<void> {
    return this.put('overrides', bookId, overrides);
  }
}
