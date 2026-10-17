import type { MediaStore } from '@lesebuehne/director';
import type { CacheUsage } from '@lesebuehne/core';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Media bytes as files in one directory (atomic writes). */
export class DiskStore implements MediaStore {
  constructor(readonly dir: string) {}

  async get(name: string): Promise<Uint8Array | undefined> {
    const f = Bun.file(join(this.dir, name));
    return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : undefined;
  }

  async put(name: string, bytes: Uint8Array): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = join(this.dir, name);
    const tmp = `${target}.${crypto.randomUUID()}.tmp`;
    await Bun.write(tmp, bytes);
    await rename(tmp, target);
  }

  private async files(prefix: string): Promise<string[]> {
    const files = await readdir(this.dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e; });
    return files.filter((f) => f.isFile() && f.name.startsWith(prefix) && !f.name.endsWith('.tmp')).map((f) => join(this.dir, f.name));
  }
  async stats(prefix: string): Promise<CacheUsage> {
    const files = await this.files(prefix);
    const sizes = await Promise.all(files.map((f) => stat(f).then((s) => s.size).catch(() => 0)));
    return { entries: files.length, bytes: sizes.reduce((a, b) => a + b, 0) };
  }
  async clear(prefix: string): Promise<void> { await Promise.all((await this.files(prefix)).map((f) => rm(f, { force: true }))); }
}
