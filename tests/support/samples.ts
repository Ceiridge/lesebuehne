import { test } from 'bun:test';

/**
 * The sample books are generated locally by `bun run samples` and are not part of the repository.
 * Tests that need them use `sampleTest` / `withSamples`, which skip (with a note) when they are missing.
 */
export const SAMPLES_DIR = new URL('../../samples/', import.meta.url);
export const SAMPLE_FILES = ['aufklaerung.txt', 'kybalion-chapter-2.md', 'samples.json'] as const;

export const SAMPLES_PRESENT = (await Promise.all(SAMPLE_FILES.map((f) => Bun.file(new URL(f, SAMPLES_DIR)).exists()))).every(Boolean);

if (!SAMPLES_PRESENT) {
  console.warn('[tests] samples/ is missing — run `bun run samples` to include the sample-book tests.');
}

/** Bytes of a sample file, or an empty array when samples are missing. */
export async function sampleBytes(file: string): Promise<Uint8Array> {
  const f = Bun.file(new URL(file, SAMPLES_DIR));
  return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : new Uint8Array();
}

/** `test` when the samples exist, otherwise `test.skip`. */
export const sampleTest = SAMPLES_PRESENT ? test : test.skip;

/** Runs `make` only when samples exist (for module-level fixtures). */
export function withSamples<T>(make: () => T): T {
  return SAMPLES_PRESENT ? make() : (undefined as T);
}
