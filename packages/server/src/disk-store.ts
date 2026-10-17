import type { MediaStore } from '@lesebuehne/director';
import { mkdir, rename } from 'node:fs/promises';
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
}
