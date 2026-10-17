import type { CacheEntry, ResultCache } from '@lesebuehne/core';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const SAFE_KEY = /^[a-z0-9-]{1,80}$/u;

/** Result cache on disk: one JSON file per key (keys are content hashes, never secrets). */
export class DiskCache implements ResultCache {
  constructor(private readonly dir: string) {}

  private path(key: string): string {
    if (!SAFE_KEY.test(key)) throw new Error(`invalid cache key: ${key}`);
    return join(this.dir, `${key}.json`);
  }

  async get<V>(key: string): Promise<CacheEntry<V> | undefined> {
    const f = Bun.file(this.path(key));
    if (!(await f.exists())) return undefined;
    try {
      return (await f.json()) as CacheEntry<V>;
    } catch {
      return undefined; // a torn write: treat as a miss
    }
  }

  async put<V>(key: string, entry: CacheEntry<V>): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.path(key);
    const tmp = `${target}.${crypto.randomUUID()}.tmp`;
    await Bun.write(tmp, JSON.stringify(entry));
    await rename(tmp, target);
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
