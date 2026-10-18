import { afterEach, describe, expect, test } from 'bun:test';
import { buildTimeline } from '@lesebuehne/core';
import { ImageSequencePlanner, imageScenes } from '../../src/ai/image-sequence.ts';
import type { AiBackend, ImageResult } from '../../src/ai/backends.ts';
import { TtsBuffer } from '../../src/ai/tts.ts';
import { bundleOf, makeEnv, openSession } from '../ui/support.ts';
import { settings } from '../../src/app/store.ts';
import { defaultSettings } from '../../src/settings/settings.ts';
import { stageStep } from '../../src/ui/reader/StagePanel.tsx';

const book = bundleOf('sequence.txt', new TextEncoder().encode('Die Sonne scheint. Ein Baum wächst. Ein Boot schwimmt. Ein Kind lacht.\n\nDer Regen fällt. Ein Fluss fließt. Ein Vogel singt. Die Wolken ziehen.')).book;
const timeline = buildTimeline(book);
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const backend = (image: NonNullable<AiBackend['image']>): AiBackend => ({ mode: 'server', plans: false, image,
  prepare: async () => { throw new Error('no text provider'); }, plan: async () => { throw new Error('no planning needed'); }, animate: async () => { throw new Error('no animation'); },
  status: async () => ({ chain: [], providers: [], budget: { images: 2, animations: 3 } }) });

afterEach(() => { settings.value = defaultSettings(); });

describe('image intervals and batching', () => {
  test('short sentences do not restart dwell or cancel slow images; passed queued sentences are completed', async () => {
    let entry = 0, now = 0;
    const requests: Array<{ signal: AbortSignal; finish(): void }> = [];
    const planner = new ImageSequencePlanner({ book, timeline, cadence: { interval: 'sentence', seconds: 30, grid: false },
      entryIndex: () => entry, now: () => now, options: () => ({}), applyStyle: () => {} },
      backend((_b, _id, _p, _o, signal) => new Promise(resolve => {
        const url = `image-${requests.length}`;
        requests.push({ signal, finish: () => resolve({ url, providerId: 'fake', variants: 1, selected: 0 }) });
      })));
    try {
      planner.tick(); await flush();
      expect(requests).toHaveLength(4);
      for (entry = 1; entry < timeline.entries.length; entry++) {
        now += 400; planner.tick(); await flush();
      }
      entry = timeline.entries.length - 1;
      expect(requests.every(r => !r.signal.aborted)).toBe(true);
      expect(planner.stateAt(0)).toBe('working');
      expect(planner.stateAt(4)).toBe('queued');
      requests[0]!.finish(); await flush();
      expect(planner.stateAt(entry)).toBe('working'); // Playhead before older queued work.
      for (let i = 0; i < timeline.entries.length; i++) {
        requests.forEach(r => r.finish()); await flush();
      }
      expect(requests).toHaveLength(timeline.entries.length);
      expect(planner.frames.peek().size).toBe(timeline.entries.length);
      expect(planner.scenes.every((_, i) => planner.stateAt(i) === 'ready')).toBe(true);
    } finally { planner.dispose(); requests.forEach(r => r.finish()); await flush(); }
  });

  test('a settled seek discards obsolete jobs and gives the destination the next slot', async () => {
    const longBook = bundleOf('seek.txt', new TextEncoder().encode(Array.from({ length: 40 }, (_, i) => `Ein Vogel singt Nummer ${i}.`).join(' '))).book;
    const longTimeline = buildTimeline(longBook);
    let entry = 0, now = 0;
    const requests: Array<{ prompt: string; signal: AbortSignal; finish(): void }> = [];
    const planner = new ImageSequencePlanner({ book: longBook, timeline: longTimeline, cadence: { interval: 'sentence', seconds: 30, grid: false },
      entryIndex: () => entry, now: () => now, options: () => ({}), applyStyle: () => {} },
      backend((_b, _id, plan, _o, signal) => new Promise(resolve => {
        requests.push({ prompt: plan.image!.prompt, signal, finish: () => resolve({ url: 'test', providerId: 'fake', variants: 1, selected: 0 }) });
      })));
    try {
      planner.tick(); await flush();
      expect(requests).toHaveLength(4);
      entry = 32; planner.seek();
      now = 1000; planner.tick(); await flush();
      expect(requests.every(r => !r.signal.aborted)).toBe(true);
      now = 1600; planner.tick(); await flush();
      expect(requests.every(r => r.signal.aborted)).toBe(true);
      expect(planner.stateAt(4)).toBe('idle');
      requests.slice(0, 4).forEach(r => r.finish()); await flush();
      expect(requests[4]!.prompt).toContain(longTimeline.entries[32]!.sentence.text);
      expect(planner.frames.peek().has(0)).toBe(false);
      expect(planner.stateAt(32)).toBe('working');
    } finally { planner.dispose(); requests.forEach(r => r.finish()); await flush(); }
  });

  test('failed images retry after cooldown while paused on the same sentence', async () => {
    let now = 0, calls = 0;
    const planner = new ImageSequencePlanner({ book, timeline, cadence: { interval: 'section', seconds: 30, grid: false },
      entryIndex: () => 0, now: () => now, options: () => ({}), applyStyle: () => {} }, backend(async () => {
        if (++calls === 1) throw new Error('temporary outage');
        return { url: 'recovered', providerId: 'fake', variants: 1, selected: 0 };
      }));
    try {
      planner.tick(); await flush();
      expect(planner.stateAt(0)).toBe('error');
      now = 119_000; planner.tick(); await flush();
      expect(calls).toBe(1);
      now = 120_000; planner.tick(); await flush();
      expect(calls).toBe(2);
      expect(planner.stateAt(0)).toBe('ready');
    } finally { planner.dispose(); }
  });

  test('sentence, paragraph and timed boundaries cover the book without gaps', () => {
    for (const interval of ['sentence', 'paragraph', 'section', 'timed'] as const) {
      const scenes = imageScenes(timeline, { interval, seconds: 5, grid: false });
      expect(scenes[0]!.first).toBe(0);
      expect(scenes.at(-1)!.last).toBe(timeline.entries.length - 1);
      for (let i = 1; i < scenes.length; i++) expect(scenes[i]!.first).toBe(scenes[i - 1]!.last + 1);
      if (interval === 'sentence') expect(scenes).toHaveLength(timeline.entries.length);
      if (interval === 'paragraph') expect(scenes).toHaveLength(2);
    }
  });

  test('four grid requests run alongside four TTS requests; tiles follow sentences rather than completion order', async () => {
    const book = bundleOf('four-grids.txt', new TextEncoder().encode(Array.from({ length: 16 }, (_, i) => `Ein Vogel singt Nummer ${i}.`).join(' '))).book;
    const timeline = buildTimeline(book);
    const requests: Array<{ panels?: string[]; resolve(r: ImageResult): void; signal: AbortSignal }> = [];
    let entry = 0;
    const planner = new ImageSequencePlanner({ book, timeline, cadence: { interval: 'sentence', seconds: 30, grid: true },
      entryIndex: () => entry, now: () => performance.now(), options: () => ({}), applyStyle: () => {} },
      backend((_b, _id, _p, opts, signal) => new Promise(resolve => requests.push({ ...opts, resolve, signal }))));
    const speechRequests: Array<() => void> = [];
    const speech = new TtsBuffer(async () => new Promise(resolve => speechRequests.push(() => resolve({ audio: new Blob(['test']), words: [] }))), 20, { create: () => 'blob:test', revoke: () => {} });
    speech.setConcurrency(4);
    try {
      planner.schedule();
      speech.prefetch([0, 1, 2, 3].map(i => ({ text: `Satz ${i}`, voice: 'test:de', lang: 'de' })));
      await flush();
      expect(requests).toHaveLength(4);
      expect(requests[0]!.panels).toHaveLength(4);
      expect(speechRequests).toHaveLength(4);
      const result = (prefix: string): ImageResult => ({ url: prefix, tiles: Array.from({ length: 4 }, (_, i) => ({ url: `${prefix}-${i}` })), providerId: 'fake', variants: 1, selected: 0, cached: false });
      requests[1]!.resolve(result('second'));
      await flush();
      expect(planner.imageAt(0)).toBeUndefined();
      entry = 5;
      expect(planner.imageAt(entry)?.image.url).toBe('second-1');
      requests[0]!.resolve(result('first'));
      await flush();
      expect(planner.imageAt(1)?.image.url).toBe('first-1');
      expect(planner.stateAt(7)).toBe('ready');
      requests[2]!.resolve(result('third'));
      requests[3]!.resolve(result('fourth'));
      await flush();
      planner.setActive(false);
      planner.setActive(true);
      planner.schedule(); await flush();
      expect(requests).toHaveLength(4);
    } finally { planner.dispose(); speechRequests.forEach(f => f()); await flush(); speech.dispose(); }
  });

  test('reader changes image concurrency live without restarting requests or losing ready images', async () => {
    settings.value = { ...defaultSettings(), visualKinds: 'images', imageInterval: 'sentence', imageConcurrency: 1 };
    const session = await openSession(await makeEnv(), bundleOf('sequence.txt', new TextEncoder().encode('Ein Boot fährt. Ein Baum wächst. Ein Vogel singt. Ein Kind lacht. Der Regen fällt.')));
    const requests: Array<{ signal: AbortSignal; finish(): void }> = [];
    session.attachAi(backend((_b, _id, _p, _o, signal) => new Promise(resolve => {
      const url = `image-${requests.length}`;
      requests.push({ signal, finish: () => resolve({ url, providerId: 'fake', variants: 1, selected: 0 }) });
    })));
    const planner = session.ai!;
    try {
      planner.schedule(session.order[0]!.id); await flush();
      expect(requests).toHaveLength(1);
      settings.value = { ...settings.peek(), imageConcurrency: 4 }; await flush();
      expect(session.ai).toBe(planner);
      expect(requests).toHaveLength(4);
      settings.value = { ...settings.peek(), imageConcurrency: 1 };
      for (let i = 0; i < 3; i++) requests[i]!.finish();
      await flush();
      expect(requests).toHaveLength(4);
      expect(requests.every(r => !r.signal.aborted)).toBe(true);
      expect(session.imageSequence.peek()!.imageAt(0)?.image.url).toBe('image-0');
      requests[3]!.finish(); await flush();
      expect(requests).toHaveLength(5);
      requests[4]!.finish(); await flush();
      expect(session.imageSequence.peek()!.frames.peek().size).toBe(5);
    } finally { session.dispose(); requests.forEach(r => r.finish()); await flush(); }
  });

  test('hidden or disposed sequences cannot accept a late grid result', async () => {
    let finish!: (r: ImageResult) => void;
    let signal!: AbortSignal;
    const planner = new ImageSequencePlanner({ book, timeline, cadence: { interval: 'section', seconds: 30, grid: true },
      entryIndex: () => 0, now: () => 0, options: () => ({}), applyStyle: () => {} }, backend((_b, _id, _p, _o, s) => { signal = s; return new Promise(r => { finish = r; }); }));
    planner.schedule(); await flush();
    planner.setActive(false);
    expect(signal.aborted).toBe(true);
    finish({ url: 'sheet', tiles: [0, 1, 2, 3].map(i => ({ url: `tile-${i}` })), providerId: 'fake', variants: 1, selected: 0 });
    await flush();
    expect(planner.frames.peek().size).toBe(0);
    expect(planner.stateAt(0)).toBe('idle');
    planner.dispose();
  });

  test('reader uses the correct image immediately on a sentence seek, with per-sentence readiness', async () => {
    settings.value = { ...defaultSettings(), layout: 'overlay', visualKinds: 'images', imageInterval: 'sentence', imageGrid: true };
    const bundle = bundleOf('sequence.txt', new TextEncoder().encode('Ein Boot fährt. Ein Baum wächst. Ein Vogel singt. Ein Kind lacht.'));
    const session = await openSession(await makeEnv(), bundle);
    session.attachAi(backend(async () => ({ url: 'sheet', tiles: [0, 1, 2, 3].map(i => ({ url: `tile-${i}` })), providerId: 'fake', variants: 1, selected: 0 })));
    try {
      session.ai!.schedule(session.order[0]!.id); await flush();
      session.navigate({ entryIndex: 2, tokenIndex: 0 });
      const current = stageStep(session, 0).current;
      expect(current?.mode).toBe('image');
      if (current?.mode === 'image') expect(current.url).toBe('tile-2');
      expect(session.generation.value.stage.every(r => r.state === 'ready' && r.stageKind === 'image')).toBe(true);
    } finally { session.dispose(); }
  });
});
