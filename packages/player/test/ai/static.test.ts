import { describe, expect, test } from 'bun:test';
import { encodeWav, type Book, type VisualPlan } from '@lesebuehne/core';
import { IDBFactory } from 'fake-indexeddb';
import { BrowserBackend, browserMedia, detectBackend, type Http } from '../../src/ai/backends.ts';
import { IdbMediaStore, IdbResultCache } from '../../src/ai/idb-cache.ts';
import { AiPrefsSchema } from '../../src/ai/prefs.ts';
import { canUseServiceWorker } from '../../src/app/pwa.ts';
import { showStaticHint } from '../../src/app/static-hint.ts';
import { bundleOf } from '../ui/support.ts';

const book: Book = bundleOf('probe.md', new TextEncoder().encode('# Eins\n\nHabe Mut, dich deines eigenen Verstandes zu bedienen.\n')).book;
const sectionId = book.chapters[0]!.sections[0]!.id;
const signal = () => new AbortController().signal;

const imagePlan = (prompt: string): VisualPlan => ({
  version: 'llm-plan-1',
  mode: 'image',
  rationale: 'test',
  keyTerms: [],
  cues: [],
  fallback: 'none',
  image: { prompt, aspect: '16:9', focus: [] },
} as unknown as VisualPlan);

/** A tiny but valid-looking PNG (signature + padding). */
const png = (seed: number): Uint8Array => {
  const b = new Uint8Array(200).fill(seed);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return b;
};
const dataUrl = (b: Uint8Array) => `data:image/png;base64,${btoa(String.fromCharCode(...b))}`;

/** Two voiced stretches with a pause. */
function speechWav(): Uint8Array {
  const rate = 16000;
  const samples = new Float32Array(rate * 1.6);
  for (let i = 0; i < samples.length; i++) {
    const s = i / rate;
    const voiced = (s > 0.1 && s < 0.7) || (s > 0.9 && s < 1.5);
    samples[i] = voiced ? 0.4 * Math.sin((2 * Math.PI * 180 * i) / rate) : 0.001 * Math.sin(i * 7.1);
  }
  return encodeWav({ samples, sampleRate: rate });
}

describe('M6: browser images (OpenRouter)', () => {
  test('wire format, data URL answer, IndexedDB cache, style reference for the second picture', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    let n = 0;
    const http: Http = async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      n++;
      return Response.json({ model: 'img-model', choices: [{ message: { role: 'assistant', content: '', images: [{ type: 'image_url', image_url: { url: dataUrl(png(n)) } }] } }] });
    };
    const prefs = AiPrefsSchema.parse({ byok: { openrouter: { enabled: false, apiKey: 'sk-or-test', model: '' } }, images: { provider: 'openrouter', model: 'vendor/image-model' } });
    const media = browserMedia(prefs, http);
    expect(media.image?.id).toBe('openrouter-images');
    const idb = new IDBFactory();
    const blobs: Blob[] = [];
    const b = new BrowserBackend([], new IdbResultCache(idb), { ...media, store: new IdbMediaStore(idb), objectUrl: (blob) => (blobs.push(blob), `blob:${blobs.length}`) });
    expect(b.plans).toBe(false);
    expect((await b.status()).budget.images).toBeGreaterThan(0);

    const first = await b.image!(book, sectionId, imagePlan('A lighthouse at dusk'), {}, signal());
    expect(first).toMatchObject({ url: 'blob:1', providerId: 'openrouter-images', variants: 1, selected: 0 });
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0]!.body.model).toBe('vendor/image-model');
    expect(calls[0]!.body.modalities).toEqual(['image', 'text']);
    const content = (calls[0]!.body.messages as Array<{ content: Array<{ type: string; text?: string }> }>)[0]!.content;
    expect(content.map((c) => c.type)).toEqual(['text']);
    expect(content[0]!.text).toContain('A lighthouse at dusk');
    expect(blobs[0]!.type).toBe('image/png');
    expect([...new Uint8Array(await blobs[0]!.arrayBuffer())]).toEqual([...png(1)]);

    // Cached: same plan, no request.
    expect((await b.image!(book, sectionId, imagePlan('A lighthouse at dusk'), {}, signal())).url).toBe('blob:1');
    expect(calls.length).toBe(1);

    // A fresh backend over the same IndexedDB still has it (persisted bytes).
    const again = new BrowserBackend([], new IdbResultCache(idb), { ...browserMedia(prefs, http), store: new IdbMediaStore(idb), objectUrl: () => 'blob:again' });
    expect((await again.image!(book, sectionId, imagePlan('A lighthouse at dusk'), {}, signal())).url).toBe('blob:again');
    expect(calls.length).toBe(1);

    // The next picture carries the first one as style reference.
    await b.image!(book, sectionId, imagePlan('A harbour at night'), {}, signal());
    const second = (calls[1]!.body.messages as Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>)[0]!.content;
    expect(second.map((c) => c.type)).toEqual(['text', 'image_url']);
    expect(second[1]!.image_url!.url).toBe(dataUrl(png(1)));
  });

  test('no provider configured: no image method, budget without pictures; OpenAI-compatible endpoint', async () => {
    const none = new BrowserBackend([]);
    expect(none.image).toBeUndefined();
    expect((await none.status()).budget.images).toBe(0);
    const calls: string[] = [];
    const http: Http = async (url, init) => {
      calls.push(`${url} ${String(init?.body)}`);
      return Response.json({ data: [{ b64_json: btoa(String.fromCharCode(...png(7))) }] });
    };
    const media = browserMedia(AiPrefsSchema.parse({ images: { provider: 'openai-compatible', baseURL: 'https://img.example/v1/', apiKey: 'k', model: 'm' } }), http);
    const r = await media.image!.generate({ prompt: 'p', size: '1536x1024', signal: signal() });
    expect(r.mime).toBe('image/png');
    expect(calls[0]).toStartWith('https://img.example/v1/images/generations ');
    expect(calls[0]).toContain('"size":"1536x1024"');
  });
});

describe('M6: browser voice', () => {
  test('fake speech endpoint → aligned clip, cached in IndexedDB, voices in the status', async () => {
    let calls = 0;
    const http: Http = async (url, init) => {
      if (url === 'http://127.0.0.1:8080/') return new Response('ok'); // availability probe
      calls++;
      expect(url).toBe('http://127.0.0.1:8080/v1/audio/speech');
      expect(JSON.parse(String(init?.body))).toMatchObject({ input: 'Habe Mut, bitte.', voice: 'serena', response_format: 'wav', language: 'German' });
      return new Response(speechWav() as BodyInit, { headers: { 'content-type': 'audio/wav' } });
    };
    const prefs = AiPrefsSchema.parse({ voice: { enabled: true, preset: 'qwentts', voices: 'serena, vivian' } });
    const idb = new IDBFactory();
    const b = new BrowserBackend([], new IdbResultCache(idb), { ...browserMedia(prefs, http), store: new IdbMediaStore(idb) });
    const status = await b.status();
    const tts = status.providers.find((p) => p.kind === 'tts');
    expect(tts?.voices?.map((v) => v.id)).toEqual(['serena', 'vivian']);

    const clip = await b.tts!('Habe Mut, bitte.', 'de', 'qwentts:serena', signal());
    expect(clip.audio.type).toBe('audio/wav');
    // Word timings from the audio: speech starts at 0.1 s, the pause before the last word is kept.
    expect(clip.words.map((w) => [w.start, w.end])).toEqual([[0, 4], [5, 8], [10, 15]]);
    expect(clip.words[0]!.t0).toBeCloseTo(0.1, 1);
    expect(clip.words[2]!.t0).toBeCloseTo(0.9, 1);
    expect(clip.words[2]!.t1).toBeCloseTo(1.5, 1);

    const fresh = new BrowserBackend([], new IdbResultCache(idb), { ...browserMedia(prefs, http), store: new IdbMediaStore(idb) });
    const cached = await fresh.tts!('Habe Mut, bitte.', 'de', 'qwentts:serena', signal());
    expect(cached.words).toEqual(clip.words);
    expect(calls).toBe(1);
  });

  test('incomplete voice settings give no voice', () => {
    const http: Http = async () => new Response('');
    expect(browserMedia(AiPrefsSchema.parse({ voice: { enabled: true, preset: 'openai-compatible', voices: 'a' } }), http).tts).toBeUndefined();
    expect(browserMedia(AiPrefsSchema.parse({ voice: { enabled: true, preset: 'openai', voices: 'alloy' } }), http).tts).toBeUndefined();
    expect(browserMedia(AiPrefsSchema.parse({ voice: { enabled: false, preset: 'qwentts', voices: 'a' } }), http).tts).toBeUndefined();
    expect(browserMedia(AiPrefsSchema.parse({ voice: { enabled: true, preset: 'openai', apiKey: 'k' } }), http).tts?.id).toBe('openai-tts');
  });
});

describe('M6: hosted page', () => {
  const caps = (seen: string[]): Http => async (url) => {
    seen.push(url);
    return url.startsWith('http://127.0.0.1:8787/') ? Response.json({ server: 'lesebuehne', chains: { llm: [] }, providers: [] }) : new Response('', { status: 404 });
  };

  test('a hosted page asks the configured local server first; a local page its own origin first', async () => {
    const prefs = AiPrefsSchema.parse({ serverUrl: 'http://127.0.0.1:8787' });
    const hosted: string[] = [];
    expect((await detectBackend({ prefs, http: caps(hosted), baseURI: 'https://example.github.io/lesebuehne/', timeoutMs: 200 }))?.mode).toBe('server');
    expect(hosted).toEqual(['http://127.0.0.1:8787/api/capabilities']);
    const local: string[] = [];
    await detectBackend({ prefs, http: caps(local), baseURI: 'http://127.0.0.1:3000/', timeoutMs: 200 });
    expect(local).toEqual(['http://127.0.0.1:3000/api/capabilities', 'http://127.0.0.1:8787/api/capabilities']);
  });

  test('voice only: a browser backend that keeps the heuristic plans', async () => {
    const prefs = AiPrefsSchema.parse({ voice: { enabled: true, preset: 'qwentts', voices: 'serena' } });
    const b = await detectBackend({ prefs, http: async () => new Response('', { status: 404 }), baseURI: 'https://example.github.io/', timeoutMs: 200 });
    expect(b?.mode).toBe('browser');
    expect(b?.plans).toBe(false);
    expect(b?.tts).toBeDefined();
  });

  test('service worker only on https or loopback', () => {
    expect(canUseServiceWorker({ protocol: 'https:', hostname: 'example.github.io' }, true)).toBe(true);
    expect(canUseServiceWorker({ protocol: 'http:', hostname: '127.0.0.1' }, true)).toBe(true);
    expect(canUseServiceWorker({ protocol: 'http:', hostname: 'localhost' }, true)).toBe(true);
    expect(canUseServiceWorker({ protocol: 'http:', hostname: '192.168.1.5' }, true)).toBe(false);
    expect(canUseServiceWorker({ protocol: 'file:', hostname: '' }, true)).toBe(false);
    expect(canUseServiceWorker({ protocol: 'https:', hostname: 'example.github.io' }, false)).toBe(false);
  });

  test('static-mode hint: only after the lookup found nothing, not when AI is off or dismissed', () => {
    const base = { known: true, connecting: false, mode: 'heuristic' as const, aiOff: false, dismissed: false };
    expect(showStaticHint(base)).toBe(true);
    expect(showStaticHint({ ...base, known: false })).toBe(false);
    expect(showStaticHint({ ...base, connecting: true })).toBe(false);
    expect(showStaticHint({ ...base, mode: 'server' })).toBe(false);
    expect(showStaticHint({ ...base, mode: 'browser' })).toBe(false);
    expect(showStaticHint({ ...base, aiOff: true })).toBe(false);
    expect(showStaticHint({ ...base, dismissed: true })).toBe(false);
  });
});
