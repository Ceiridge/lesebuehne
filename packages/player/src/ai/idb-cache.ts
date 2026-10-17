import type { CacheEntry, ResultCache } from '@lesebuehne/core';

const DB_NAME = 'lesebuehne-ai';
const STORE = 'results';

const done = <T,>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/** Result cache in IndexedDB (own database, so the library schema stays untouched). */
export class IdbResultCache implements ResultCache {
  private db?: Promise<IDBDatabase>;

  constructor(private readonly factory: IDBFactory) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = this.factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.open()).transaction(STORE, mode).objectStore(STORE);
  }

  async get<V>(key: string): Promise<CacheEntry<V> | undefined> {
    return ((await done((await this.store('readonly')).get(key))) as CacheEntry<V> | undefined) ?? undefined;
  }

  async put<V>(key: string, entry: CacheEntry<V>): Promise<void> {
    await done((await this.store('readwrite')).put(entry, key));
  }

  async delete(key: string): Promise<void> {
    await done((await this.store('readwrite')).delete(key));
  }
}
