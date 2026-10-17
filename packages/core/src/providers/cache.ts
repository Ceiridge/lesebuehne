import { contentHash } from '../text/hash.ts';

/**
 * Content-addressed cache of generated results (brief §8.4). Each key holds variants: a new
 * "regenerate" appends one, the selected index is remembered. Server (disk) and browser
 * (IndexedDB) implement the same interface.
 */
export interface CacheEntry<V> {
  variants: Array<{ value: V; providerId: string; model?: string; createdAt: string }>;
  selected: number;
}

export interface ResultCache {
  get<V>(key: string): Promise<CacheEntry<V> | undefined>;
  put<V>(key: string, entry: CacheEntry<V>): Promise<void>;
  delete(key: string): Promise<void>;
  stats?(): Promise<CacheUsage>;
  clear?(): Promise<void>;
}

export interface CacheUsage { entries: number; bytes: number }
export type CacheScope = 'stage' | 'speech';
export type CacheStats = Record<CacheScope, CacheUsage>;

/** Cache key from the parts that determine a result (B6). Undefined parts are written as "-". */
export function cacheKey(kind: string, parts: Readonly<Record<string, string | number | undefined>>): string {
  const canonical = Object.keys(parts)
    .sort()
    .map((k) => `${k}=${parts[k] ?? '-'}`)
    .join('\u0001');
  return `${kind}-${contentHash(canonical)}`;
}

export function selectedValue<V>(entry: CacheEntry<V> | undefined): V | undefined {
  return entry ? entry.variants[entry.selected]?.value : undefined;
}

export function addVariant<V>(entry: CacheEntry<V> | undefined, value: V, providerId: string, model?: string, now = new Date()): CacheEntry<V> {
  const variants = [...(entry?.variants ?? []), { value, providerId, createdAt: now.toISOString(), ...(model ? { model } : {}) }];
  return { variants, selected: variants.length - 1 };
}

export class MemoryCache implements ResultCache {
  private readonly map = new Map<string, unknown>();
  async get<V>(key: string): Promise<CacheEntry<V> | undefined> {
    const v = this.map.get(key);
    return v ? (structuredClone(v) as CacheEntry<V>) : undefined;
  }
  async put<V>(key: string, entry: CacheEntry<V>): Promise<void> {
    this.map.set(key, structuredClone(entry));
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async stats(): Promise<CacheUsage> {
    return { entries: this.map.size, bytes: [...this.map.values()].reduce<number>((n, v) => n + new TextEncoder().encode(JSON.stringify(v)).byteLength, 0) };
  }
  async clear(): Promise<void> { this.map.clear(); }
}
