import type { BookBundle } from '@lesebuehne/core';
import { ingestFile, toBundle } from '@lesebuehne/ingest';
import type { AppEnv } from '../../src/app/env.ts';
import { ReaderSession } from '../../src/app/session.ts';
import { Highlighter, type HighlightRegistryLike } from '../../src/highlight/highlighter.ts';
import { LibraryService } from '../../src/storage/library.ts';
import { MemoryRepository } from '../../src/storage/repository.ts';
import { SettingsStore, type KeyValueStore } from '../../src/settings/settings.ts';
import type { VoiceInfo } from '../../src/engine/voices.ts';
import { FakeTimers } from '../support/fake-clock.ts';
import { FakeTTS } from '../support/fake-tts.ts';

export const ROOT = new URL('../../../../', import.meta.url);

export class MemoryKv implements KeyValueStore {
  data = new Map<string, string>();
  get(k: string) {
    return this.data.get(k) ?? null;
  }
  set(k: string, v: string) {
    this.data.set(k, v);
  }
}

export class FakeRegistry implements HighlightRegistryLike {
  readonly sets: Array<[string, unknown]> = [];
  readonly map = new Map<string, unknown>();
  set(name: string, h: unknown) {
    this.sets.push([name, h]);
    this.map.set(name, h);
  }
  delete(name: string) {
    this.map.delete(name);
  }
}

export interface TestEnv {
  env: AppEnv;
  tts: FakeTTS;
  timers: FakeTimers;
  library: LibraryService;
  registry: FakeRegistry;
  kv: MemoryKv;
}

export async function makeEnv(o: { voices?: VoiceInfo[]; speech?: boolean; files?: Record<string, string | Uint8Array> } = {}): Promise<TestEnv> {
  const tts = new FakeTTS();
  const timers = new FakeTimers();
  const library = await LibraryService.create(new MemoryRepository());
  const registry = new FakeRegistry();
  const kv = new MemoryKv();
  const files = o.files ?? {};
  const env: AppEnv = {
    library: () => Promise.resolve(library),
    speech: o.speech === false ? undefined : { port: tts, voices: () => Promise.resolve(o.voices ?? []) },
    settings: new SettingsStore(kv),
    kv,
    fetch: async (url) => {
      const path = new URL(url).pathname.replace(/^\//u, '');
      const body = files[path];
      if (body === undefined) return new Response('not found', { status: 404 });
      return new Response(typeof body === 'string' ? body : new Blob([body as BlobPart]));
    },
    baseURI: () => 'http://127.0.0.1/',
    timers,
    highlighter: () => new Highlighter(registry, () => ({ priority: 0 })),
    prefersDark: () => false,
  };
  return { env, tts, timers, library, registry, kv };
}

export async function sampleBytes(file: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(new URL(`samples/${file}`, ROOT)).arrayBuffer());
}

export function bundleOf(fileName: string, bytes: Uint8Array, language = 'de'): BookBundle {
  return toBundle(ingestFile({ fileName, bytes, language }), { fileName, size: bytes.length, importedAt: new Date('2026-10-17T00:00:00Z') });
}

export async function openSession(t: TestEnv, bundle: BookBundle, saved = true, basicLanguage = false): Promise<ReaderSession> {
  await t.library.import(bundle);
  return ReaderSession.open(t.env, t.library, bundle, { saved, basicLanguage });
}

/** Lets pending promises and microtasks run. */
export const flush = async (n = 3): Promise<void> => {
  // Preact runs effects after a frame (requestAnimationFrame), so wait real time.
  for (let k = 0; k < n; k++) await new Promise((r) => setTimeout(r, 20));
};
