import type { CacheEntry, CacheUsage, ResultCache } from '@lesebuehne/core';
import type { MediaStore } from '@lesebuehne/director';

const DB_NAME = 'lesebuehne-ai';
const STORE = 'results';
/** Image and speech bytes (spec 006 B3), keyed by file name. */
const MEDIA = 'media';

const done = <T,>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const opened = new WeakMap<IDBFactory, Promise<IDBDatabase>>();

/** The AI database (own database, so the library schema stays untouched); v2 adds media. */
function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  let db = opened.get(factory);
  if (!db) {
    db = new Promise((resolve, reject) => {
      const req = factory.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        for (const name of [STORE, MEDIA]) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.catch(() => opened.delete(factory));
    opened.set(factory, db);
  }
  return db;
}

async function store(factory: IDBFactory, name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await openDb(factory)).transaction(name, mode).objectStore(name);
}

async function inspect(factory: IDBFactory, name: string, prefix: string, clear = false): Promise<CacheUsage> {
  const db = await openDb(factory);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, clear ? 'readwrite' : 'readonly');
    const result = { entries: 0, bytes: 0 };
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('cache transaction failed'));
    const cursor = tx.objectStore(name).openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      if (String(c.key).startsWith(prefix)) {
        result.entries++;
        result.bytes += name === MEDIA ? (c.value.byteLength ?? 0) : new TextEncoder().encode(JSON.stringify(c.value)).byteLength;
        if (clear) c.delete();
      }
      c.continue();
    };
  });
}

/** Result cache in IndexedDB. */
export class IdbResultCache implements ResultCache {
  constructor(private readonly factory: IDBFactory) {}

  async get<V>(key: string): Promise<CacheEntry<V> | undefined> {
    return ((await done((await store(this.factory, STORE, 'readonly')).get(key))) as CacheEntry<V> | undefined) ?? undefined;
  }

  async put<V>(key: string, entry: CacheEntry<V>): Promise<void> {
    await done((await store(this.factory, STORE, 'readwrite')).put(entry, key));
  }

  async delete(key: string): Promise<void> {
    await done((await store(this.factory, STORE, 'readwrite')).delete(key));
  }
  stats(): Promise<CacheUsage> { return inspect(this.factory, STORE, ''); }
  async clear(): Promise<void> { await inspect(this.factory, STORE, '', true); }
}

/** Image and speech bytes in IndexedDB. */
export class IdbMediaStore implements MediaStore {
  constructor(private readonly factory: IDBFactory) {}

  async get(name: string): Promise<Uint8Array | undefined> {
    const v = (await done((await store(this.factory, MEDIA, 'readonly')).get(name))) as Uint8Array | ArrayBuffer | undefined;
    return v === undefined ? undefined : v instanceof Uint8Array ? v : new Uint8Array(v);
  }

  async put(name: string, bytes: Uint8Array): Promise<void> {
    await done((await store(this.factory, MEDIA, 'readwrite')).put(bytes, name));
  }
  stats(prefix: string): Promise<CacheUsage> { return inspect(this.factory, MEDIA, prefix); }
  async clear(prefix: string): Promise<void> { await inspect(this.factory, MEDIA, prefix, true); }
}

/** Media bytes in memory (no IndexedDB). */
export class MemoryMediaStore implements MediaStore {
  private readonly map = new Map<string, Uint8Array>();

  async get(name: string): Promise<Uint8Array | undefined> {
    return this.map.get(name);
  }

  async put(name: string, bytes: Uint8Array): Promise<void> {
    this.map.set(name, bytes);
  }
  async stats(prefix: string): Promise<CacheUsage> {
    const entries = [...this.map].filter(([k]) => k.startsWith(prefix));
    return { entries: entries.length, bytes: entries.reduce((n, [, v]) => n + v.byteLength, 0) };
  }
  async clear(prefix: string): Promise<void> { for (const key of this.map.keys()) if (key.startsWith(prefix)) this.map.delete(key); }
}
