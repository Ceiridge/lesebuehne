import { afterAll, describe, expect, test } from 'bun:test';
import { assembleBook, FakeLLM, MemoryCache, ProviderRegistry, type Book, type LLMRequest } from '@lesebuehne/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi, DEFAULT_CONFIG, DiskCache, envOverrides, mergeConfig, type ApiContext, type ServerConfig } from '../src/index.ts';

const tmp = await mkdtemp(join(tmpdir(), 'lb-server-'));
afterAll(() => rm(tmp, { recursive: true, force: true }));

const book: Book = assembleBook({
  language: 'de',
  title: 'Probe',
  chapters: [{ title: 'Eins', blocks: [{ kind: 'text', text: 'Habe Mut, dich deines eigenen Verstandes zu bedienen! Faulheit und Feigheit sind die Ursachen.' }] }],
});
const sectionId = book.chapters[0]!.sections[0]!.id;

const style = JSON.stringify({
  palette: { background: '#ffffff', ink: '#111111', accent: '#aa3300', accent2: '#0033aa', muted: '#888888' },
  illustrationStyle: 'Ink drawings, sepia, no text',
  diagramStyle: 'Thin lines',
  mood: 'calm',
  glossary: [{ label: 'Verstandes', description: 'reason', glyph: '✦', color: '#aa3300', aliases: [] }],
  chapterSummaries: [{ chapter: 1, summary: 'Mut.' }],
});
const plan = (term: string) =>
  JSON.stringify({
    mode: 'kinetic',
    rationale: 'terms',
    keyTerms: [term],
    cues: [],
    diagram: null,
    quote: null,
    image: null,
    animation: null,
    fallback: 'none',
  });

function setup(fakes: FakeLLM[], config: Partial<ServerConfig> = {}): { api: ReturnType<typeof createApi>; ctx: ApiContext } {
  const registry = new ProviderRegistry();
  for (const f of fakes) registry.register(f);
  const ctx: ApiContext = {
    config: { ...DEFAULT_CONFIG, ...config },
    dataDir: tmp,
    providers: { registry, chain: fakes.map((f) => f.id), imageChain: ['fake-image'], taskModel: () => undefined, files: { codexToken: join(tmp, 'c.json'), planStore: join(tmp, 'p.json') } },
    cache: new MemoryCache(),
  };
  return { api: createApi(ctx), ctx };
}

const BASE = 'http://127.0.0.1:8787';
const call = (api: ReturnType<typeof createApi>, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  api.handle(
    new Request(`${BASE}${path}`, {
      method,
      headers: { host: '127.0.0.1:8787', 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

describe('T5: config', () => {
  test('deep merge (objects merge, arrays replace) and env keys', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { llm: { chain: ['openrouter'] }, providers: { openrouter: { model: 'm' } } });
    expect(merged.llm.chain).toEqual(['openrouter']);
    expect(merged.providers.openrouter).toEqual({ enabled: true, model: 'm' });
    expect(merged.providers['codex-auth'].model).toBe('auto');
    const env = envOverrides({ OPENROUTER_API_KEY: 'k', LESEBUEHNE_LLM_CHAIN: 'a, b' });
    expect(env.llm?.chain).toEqual(['a', 'b']);
    expect(env.providers?.openrouter?.apiKey).toBe('k');
  });

  test('disk cache round trip and key guard', async () => {
    const cache = new DiskCache(join(tmp, 'cache'));
    await cache.put('plan-abc', { variants: [{ value: 1, providerId: 'x', createdAt: 'now' }], selected: 0 });
    expect((await cache.get<number>('plan-abc'))?.variants[0]?.value).toBe(1);
    await cache.delete('plan-abc');
    expect(await cache.get('plan-abc')).toBeUndefined();
    expect(cache.get('../evil')).rejects.toThrow();
  });
});

describe('T5: API', () => {
  test('host and origin guard; CORS only for allowed origins', async () => {
    const { api } = setup([], { server: { port: 8787, origins: ['http://127.0.0.1:3000'] } });
    expect((await call(api, 'GET', '/api/capabilities', undefined, { host: 'evil.example' })).status).toBe(403);
    expect((await call(api, 'GET', '/api/capabilities', undefined, { origin: 'https://evil.example' })).status).toBe(403);
    const ok = await call(api, 'GET', '/api/capabilities', undefined, { origin: 'http://127.0.0.1:3000' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:3000');
    expect((await call(api, 'GET', '/api/capabilities', undefined, { origin: BASE })).status).toBe(200);
  });

  test('capabilities list providers and chain without secrets', async () => {
    const { api } = setup([new FakeLLM({ id: 'a', answers: [] }), new FakeLLM({ id: 'b', answers: [], available: { ok: false, reason: 'no key' } })]);
    const caps = (await (await call(api, 'GET', '/api/capabilities')).json()) as { chains: { llm: string[] }; providers: Array<{ id: string; available: boolean; reason: string | null }> };
    expect(caps.chains.llm).toEqual(['a', 'b', 'heuristic']);
    expect(caps.providers.find((p) => p.id === 'b')).toMatchObject({ available: false, reason: 'no key' });
  });

  test('book upload → style bible → plan (cached, regenerate adds a variant, select switches)', async () => {
    let n = 0;
    const fake = new FakeLLM({
      id: 'fake',
      answers: [style, (req: LLMRequest<unknown>) => (req.user.includes('Glossary') ? plan(n++ === 0 ? 'Mut' : 'Feigheit') : 'bad')],
    });
    const { api } = setup([fake]);
    expect((await call(api, 'POST', '/api/llm/plan', { bookId: book.id, sectionId })).status).toBe(404);
    expect((await call(api, 'PUT', `/api/books/${encodeURIComponent(book.id)}`, book)).status).toBe(200);

    const prep = (await (await call(api, 'POST', '/api/llm/prepare', { bookId: book.id })).json()) as { styleBible: { glossary: unknown[] }; cached: boolean };
    expect(prep.cached).toBe(false);
    expect(prep.styleBible.glossary).toHaveLength(1);
    expect(((await (await call(api, 'POST', '/api/llm/prepare', { bookId: book.id })).json()) as { cached: boolean }).cached).toBe(true);

    type PlanRes = { plan: { keyTerms: string[]; meta?: { providerId: string } }; cached: boolean; fallback: boolean; variants: number; selected: number };
    const p1 = (await (await call(api, 'POST', '/api/llm/plan', { bookId: book.id, sectionId })).json()) as PlanRes;
    expect(p1).toMatchObject({ cached: false, fallback: false, variants: 1 });
    expect(p1.plan.keyTerms).toEqual(['Mut']);
    expect(p1.plan.meta?.providerId).toBe('fake');
    const p2 = (await (await call(api, 'POST', '/api/llm/plan', { bookId: book.id, sectionId })).json()) as PlanRes;
    expect(p2.cached).toBe(true);
    const p3 = (await (await call(api, 'POST', '/api/llm/plan', { bookId: book.id, sectionId, regenerate: true })).json()) as PlanRes;
    expect(p3).toMatchObject({ variants: 2, selected: 1 });
    expect(p3.plan.keyTerms).toEqual(['Feigheit']);
    const p4 = (await (await call(api, 'POST', '/api/llm/plan', { bookId: book.id, sectionId, select: 0 })).json()) as PlanRes;
    expect(p4.plan.keyTerms).toEqual(['Mut']);

    const usage = (await (await call(api, 'GET', '/api/usage')).json()) as { providers: Record<string, { ok: number; inputTokens: number }> };
    expect(usage.providers.fake?.ok).toBe(3);
    expect(usage.providers.fake?.inputTokens).toBeGreaterThan(0);
  });

  test('chain exhausted → heuristic plan with fallback flag (not cached)', async () => {
    const { api } = setup([new FakeLLM({ id: 'down', answers: [{ error: 'server' }] })]);
    await call(api, 'PUT', `/api/books/${encodeURIComponent(book.id)}`, book);
    const r = (await (await call(api, 'POST', '/api/llm/plan', { bookId: book.id, sectionId })).json()) as { fallback: boolean; plan: { version: string }; error: string };
    expect(r.fallback).toBe(true);
    expect(r.plan.version).toBe('heuristic-1');
    expect(r.error).toContain('down');
  });

  test('sign-in returns the URL and emits an auth event when done', async () => {
    const { api, ctx } = setup([new FakeLLM({ id: 'codex-auth', answers: [] })]);
    let finish!: () => void;
    ctx.login = { 'codex-auth': async () => ({ url: 'https://auth.example/authorize', done: new Promise<void>((r) => (finish = r)), cancel() {} }) };
    const events: string[] = [];
    const sse = await call(api, 'GET', '/api/events');
    const reader = sse.body!.getReader();
    const res = (await (await call(api, 'POST', '/api/auth/codex-auth/login')).json()) as { url: string };
    expect(res.url).toBe('https://auth.example/authorize');
    finish();
    const dec = new TextDecoder();
    while (!events.some((e) => e.includes('"auth"'))) events.push(dec.decode((await reader.read()).value));
    expect(events.join('')).toContain('"ok":true');
    await reader.cancel();
    expect((await call(api, 'POST', '/api/auth/unknown/login')).status).toBe(404);
  });
});

describe('M3: animate endpoint', () => {
  test('returns a validated program; plan without animation → 503', async () => {
    const { EXAMPLE_PROGRAM } = await import('@lesebuehne/director');
    const { api } = setup([new FakeLLM({ id: 'fake', answers: [JSON.stringify({ code: EXAMPLE_PROGRAM, notes: 'n' })] })]);
    await call(api, 'PUT', `/api/books/${encodeURIComponent(book.id)}`, book);
    const plan = {
      version: 'llm-plan-4',
      mode: 'animation',
      rationale: 'r',
      keyTerms: [],
      fallback: 'kinetic',
      cues: [],
      diagram: { template: 'cycle', items: [{ id: 'a', label: 'Mut' }, { id: 'b', label: 'Feigheit' }, { id: 'c', label: 'Faulheit' }] },
      animation: { brief: 'A wheel turning' },
    };
    const r = (await (await call(api, 'POST', '/api/llm/animate', { bookId: book.id, sectionId, plan })).json()) as { program: { code: string }; variants: number };
    expect(r.program.code).toBe(EXAMPLE_PROGRAM);
    expect(r.variants).toBe(1);
    const bad = await call(api, 'POST', '/api/llm/animate', { bookId: book.id, sectionId, plan: { ...plan, mode: 'diagram', animation: undefined } });
    expect(bad.status).toBe(503);
  });
});

describe('M4: /api/tts', () => {
  test('synthesizes via the voice provider, aligns, caches; unknown voice → 404', async () => {
    const { encodeWav } = await import('@lesebuehne/core');
    let calls = 0;
    const samples = new Float32Array(24000);
    for (let i = 2400; i < 21600; i++) samples[i] = 0.4 * Math.sin(i / 20);
    const fakeTts = {
      kind: 'tts' as const,
      id: 'qwentts',
      label: 'fake',
      runsIn: ['server'] as const,
      capabilities: {},
      voices: [{ id: 'vivian', name: 'Vivian', languages: [] }],
      isAvailable: async () => ({ ok: true }),
      synthesize: async () => {
        calls++;
        return { audio: encodeWav({ samples, sampleRate: 24000 }), mime: 'audio/wav' };
      },
    };
    const { api, ctx } = setup([]);
    ctx.providers.registry.register(fakeTts);
    const body = { text: 'Habe Mut, dich zu bedienen.', lang: 'de', voice: 'qwentts:vivian' };
    const r1 = await call(api, 'POST', '/api/tts', body);
    expect(r1.status).toBe(200);
    expect(r1.headers.get('content-type')).toBe('audio/wav');
    const words = JSON.parse(decodeURIComponent(r1.headers.get('x-lb-words')!)) as Array<{ t0: number; t1: number }>;
    expect(words).toHaveLength(5);
    expect(words[0]!.t0).toBeCloseTo(0.1, 1);
    expect(r1.headers.get('x-lb-cached')).toBe('false');
    expect((await r1.arrayBuffer()).byteLength).toBeGreaterThan(40000);
    const r2 = await call(api, 'POST', '/api/tts', body);
    expect(r2.headers.get('x-lb-cached')).toBe('true');
    expect(calls).toBe(1);
    expect((await call(api, 'POST', '/api/tts', { ...body, voice: 'nope:x' })).status).toBe(404);
    const caps = (await (await call(api, 'GET', '/api/capabilities')).json()) as { providers: Array<{ id: string; voices?: unknown[] }> };
    expect(caps.providers.find((p) => p.id === 'qwentts')?.voices).toHaveLength(1);
  });
});

describe('M5: images', () => {
  test('generate, cache, variants, style reference from the first image, safe file serving', async () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array(300).fill(7)]);
    const requests: Array<{ prompt: string; size: string; styleRef?: Uint8Array }> = [];
    const fakeImage = {
      kind: 'image' as const,
      id: 'fake-image',
      label: 'fake',
      runsIn: ['server'] as const,
      capabilities: {},
      isAvailable: async () => ({ ok: true }),
      generate: async (req: { prompt: string; size: string; styleRef?: Uint8Array }) => {
        requests.push(req);
        return { image: PNG, mime: 'image/png' };
      },
    };
    const { api, ctx } = setup([]);
    ctx.providers.registry.register(fakeImage);
    await call(api, 'PUT', `/api/books/${encodeURIComponent(book.id)}`, book);
    const plan = {
      version: 'llm-plan-4',
      mode: 'image',
      rationale: 'scene',
      keyTerms: [],
      fallback: 'kinetic',
      cues: [],
      image: { prompt: 'Königsberg street at dawn, a scholar with a book', aspect: '16:9', focusRegions: [{ id: 'scholar', label: 'Scholar', x: 0.1, y: 0.2, w: 0.3, h: 0.6 }] },
    };
    type R = { url: string; cached: boolean; variants: number; selected: number };
    const r1 = (await (await call(api, 'POST', '/api/images', { bookId: book.id, sectionId, plan })).json()) as R;
    expect(r1).toMatchObject({ cached: false, variants: 1 });
    expect(requests[0]!.size).toBe('1536x1024');
    expect(requests[0]!.prompt).toContain('No text');
    expect(requests[0]!.styleRef).toBeUndefined();
    const r2 = (await (await call(api, 'POST', '/api/images', { bookId: book.id, sectionId, plan })).json()) as R;
    expect(r2.cached).toBe(true);
    const r3 = (await (await call(api, 'POST', '/api/images', { bookId: book.id, sectionId, plan, regenerate: true })).json()) as R;
    expect(r3).toMatchObject({ variants: 2, selected: 1 });
    expect(requests[1]!.styleRef?.byteLength).toBe(PNG.byteLength); // the first image is the style reference
    const file = await call(api, 'GET', `/${r3.url}`);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect((await file.arrayBuffer()).byteLength).toBe(PNG.byteLength);
    expect((await call(api, 'GET', '/api/images/..%2F..%2Fsecret.png')).status).toBe(400);
    expect((await call(api, 'POST', '/api/images', { bookId: book.id, sectionId, plan: { ...plan, mode: 'kinetic', image: undefined } })).status).toBe(503);
  });
});

describe('M6: hosted page + local server', () => {
  test('Private Network Access preflight only for allowed origins; origins from env', () => {
    expect(envOverrides({ LESEBUEHNE_ORIGINS: 'https://a.github.io/, https://b.example' }).server?.origins).toEqual(['https://a.github.io', 'https://b.example']);
  });
  test('preflight', async () => {
    const { api } = setup([], { server: { port: 8787, origins: ['https://a.github.io'] } });
    const ok = await call(api, 'OPTIONS', '/api/capabilities', undefined, { origin: 'https://a.github.io', 'access-control-request-private-network': 'true' });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-private-network')).toBe('true');
    expect(ok.headers.get('access-control-expose-headers')).toContain('x-lb-words');
    const bad = await call(api, 'OPTIONS', '/api/capabilities', undefined, { origin: 'https://evil.example', 'access-control-request-private-network': 'true' });
    expect(bad.status).toBe(403);
  });
});
