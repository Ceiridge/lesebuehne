import { describe, expect, test } from 'bun:test';
import { FakeLLM, MemoryCache, ProviderRegistry, type Book, type StyleBible, type VisualPlan } from '@lesebuehne/core';
import { planSection, type PlanResponse, type StyleResponse } from '@lesebuehne/director';
import { createApi, DEFAULT_CONFIG } from '@lesebuehne/server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserBackend, detectBackend, ServerBackend, type AiBackend, type Http } from '../../src/ai/backends.ts';
import { AiPlanner, LOOKAHEAD_SECONDS, PLAN_DWELL_MS, type PlannerHost } from '../../src/ai/planner.ts';
import { AI_PREFS_KEY, AiPrefsSchema, loadAiPrefs, maskKey } from '../../src/ai/prefs.ts';
import { setBackend } from '../../src/ai/state.ts';
import { stageStep } from '../../src/ui/reader/StagePanel.tsx';
import { bundleOf, makeEnv, openSession } from '../ui/support.ts';

const text = (n: number) => `Kapitel ${n}: Habe Mut, dich deines eigenen Verstandes zu bedienen! Faulheit und Feigheit sind die Ursachen.`;
const markdown = [1, 2, 3, 4].map((n) => `# Kapitel ${n}\n\n${text(n)}\n`).join('\n');
const bundle = bundleOf('probe.md', new TextEncoder().encode(markdown));
const book: Book = bundle.book;
const order = book.chapters.flatMap((c) => c.sections);

const kinetic = (term: string, providerId = 'fake'): VisualPlan => ({
  version: 'llm-plan-1',
  mode: 'kinetic',
  rationale: 'test',
  keyTerms: [term],
  cues: [],
  fallback: 'none',
  meta: { providerId, promptVersion: 'llm-plan-1', createdAt: '2026-10-17T00:00:00Z' },
});
const style: StyleBible = {
  version: 'llm-style-1',
  bookId: book.id,
  palette: { background: '#ffffff', ink: '#111111', accent: '#aa3300', accent2: '#0033aa', muted: '#888888' },
  illustrationStyle: 'ink',
  diagramStyle: 'thin',
  mood: 'calm',
  glossary: [{ id: 'mut', label: 'Mut', description: '', glyph: '✦', color: '#aa3300' }],
  chapterSummaries: [],
};

/** Scriptable backend: records calls, holds jobs until released. */
class FakeBackend implements AiBackend {
  readonly mode = 'server' as const;
  readonly calls: Array<{ kind: 'prepare' | 'plan'; sectionId?: string; opts: unknown; signal: AbortSignal }> = [];
  fallbackFor = new Set<string>();
  variants = new Map<string, number>();
  async prepare(_b: Book, opts: unknown, signal: AbortSignal): Promise<StyleResponse> {
    this.calls.push({ kind: 'prepare', opts, signal });
    return { styleBible: style, cached: false, variants: 1, selected: 0 };
  }
  async plan(b: Book, sectionId: string, opts: { regenerate?: boolean; select?: number }, signal: AbortSignal): Promise<PlanResponse> {
    this.calls.push({ kind: 'plan', sectionId, opts, signal });
    await new Promise((r) => setTimeout(r, 5));
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    if (this.fallbackFor.has(sectionId)) {
      return { plan: planSection(order.find((s) => s.id === sectionId)!, b), fallback: true, error: 'down', cached: false, variants: 0, selected: 0 };
    }
    const n = (this.variants.get(sectionId) ?? 0) + (opts.regenerate ? 1 : this.variants.has(sectionId) ? 0 : 1);
    this.variants.set(sectionId, n);
    const selected = opts.select ?? n - 1;
    return { plan: kinetic(selected === 0 ? 'Mut' : 'Feigheit'), fallback: false, cached: false, variants: n, selected };
  }
  async status() {
    return { chain: ['fake', 'heuristic'], providers: [], budget: { images: 2, animations: 3 } };
  }
}

function host(over: Partial<PlannerHost> = {}): PlannerHost & { applied: Array<[string, VisualPlan]>; current: string; t: number } {
  const h = {
    book,
    order,
    current: order[0]!.id,
    t: 0,
    applied: [] as Array<[string, VisualPlan]>,
    currentSectionId: (): string => h.current,
    planOf: () => undefined,
    applyPlan: (id: string, plan: VisualPlan): void => void h.applied.push([id, plan]),
    applyStyle: () => undefined,
    now: (): number => h.t,
    ...over,
  };
  return h;
}

const settle = () => new Promise((r) => setTimeout(r, 40));

describe('T6: AI planner', () => {
  test('window: current, look-ahead by listening time, previous last', () => {
    const p = new AiPlanner(host(), new FakeBackend());
    const w = p.window(order[1]!.id);
    expect(w[0]).toEqual({ id: order[1]!.id, priority: 0 });
    expect(w.at(-1)).toEqual({ id: order[0]!.id, priority: 1000 });
    expect(w.map((x) => x.id)).toContain(order[2]!.id);
    expect(LOOKAHEAD_SECONDS).toBe(300);
  });

  test('dwell: nothing before 1.5 s on a section; then style first, then plans', async () => {
    const h = host();
    const backend = new FakeBackend();
    const p = new AiPlanner(h, backend);
    p.tick(0);
    h.t = PLAN_DWELL_MS - 1;
    p.tick(h.t);
    await settle();
    expect(backend.calls).toHaveLength(0);
    h.t = PLAN_DWELL_MS;
    p.tick(h.t);
    await settle();
    expect(backend.calls[0]?.kind).toBe('prepare');
    expect(backend.calls.filter((c) => c.kind === 'plan').map((c) => c.sectionId)[0]).toBe(order[0]!.id);
    expect(h.applied.map(([id]) => id)).toContain(order[0]!.id);
    expect(p.infoOf(order[0]!.id)).toMatchObject({ source: 'ai', variants: 1 });
  });

  test('scrubbing costs nothing; a jump aborts jobs outside the new window', async () => {
    const h = host();
    const backend = new FakeBackend();
    const p = new AiPlanner(h, backend);
    for (const [k, s] of order.entries()) {
      h.current = s.id;
      h.t = k * 100;
      p.tick(h.t);
    }
    await settle();
    expect(backend.calls).toHaveLength(0);
    p.schedule(order[0]!.id);
    p.schedule(order[3]!.id); // jump
    await settle();
    const first = backend.calls.find((c) => c.kind === 'plan' && c.sectionId === order[1]!.id);
    if (first) expect(first.signal.aborted).toBe(true);
  });

  test('fallback: heuristic stays, no retry right away; regenerate and variants', async () => {
    const h = host();
    const backend = new FakeBackend();
    backend.fallbackFor.add(order[0]!.id);
    const p = new AiPlanner(h, backend);
    p.schedule(order[0]!.id);
    await settle();
    expect(p.infoOf(order[0]!.id)?.source).toBe('heuristic');
    expect(h.applied.some(([id]) => id === order[0]!.id)).toBe(false);
    const before = backend.calls.length;
    p.schedule(order[0]!.id);
    await settle();
    expect(backend.calls.filter((c) => c.sectionId === order[0]!.id).length).toBe(backend.calls.slice(0, before).filter((c) => c.sectionId === order[0]!.id).length);

    const s1 = order[1]!.id;
    await p.regenerate(s1);
    expect(p.infoOf(s1)).toMatchObject({ variants: 2, selected: 1 });
    expect(h.applied.at(-1)?.[1].keyTerms).toEqual(['Feigheit']);
    await p.selectVariant(s1, -1);
    expect(p.infoOf(s1)?.selected).toBe(0);
    expect(h.applied.at(-1)?.[1].keyTerms).toEqual(['Mut']);
  });
});

describe('T6: session integration', () => {
  test('AI plan replaces the heuristic under a new stage key; the old key keeps its plan for the fade', async () => {
    const backend = new FakeBackend();
    setBackend(backend);
    try {
      const t = await makeEnv();
      const session = await openSession(t, bundle);
      const id = order[0]!.id;
      const oldKey = session.stageKey(id);
      expect(stageStep(session, t.timers.now()).frame.current).toBe(oldKey);
      const heuristic = session.visualFor(oldKey)!.plan;
      expect(session.ai).toBeDefined();
      session.setAiPlan(id, kinetic('Mut'), { source: 'ai', variants: 1, selected: 0 });
      const newKey = session.stageKey(id);
      expect(newKey).not.toBe(oldKey);
      expect(session.sectionOfKey(newKey)).toBe(id);
      expect(session.visualFor(newKey)!.plan.keyTerms).toEqual(['Mut']);
      expect(session.visualFor(oldKey)!.plan).toBe(heuristic);
      // Paused: the new plan crossfades in at once (no dwell); the old one fades out.
      const snap = stageStep(session, t.timers.now());
      expect(snap.frame.current).toBe(newKey);
      expect(snap.frame.previous).toBe(oldKey);
      expect(snap.current?.mode).toBe('kinetic');
      // V forces the heuristic; auto brings the AI plan back.
      for (let k = 0; k < 4; k++) session.cycleVisual();
      expect(session.plans.value.get(id)?.keyTerms).toEqual(['Mut']);
      session.styleBible.value = style;
      expect(session.glossary.value.get('mut')?.color).toBe('#aa3300');
      session.dispose();
    } finally {
      setBackend(undefined);
    }
  });
});

describe('T6: backends', () => {
  const plan = JSON.stringify({ mode: 'kinetic', rationale: 'key terms', keyTerms: ['Mut'], cues: [], diagram: null, quote: null, image: null, animation: null, fallback: 'none' });

  test('server backend against the real API (fake LLM); re-uploads after a server restart', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'lb-player-'));
    try {
      const mk = (dir: string) => {
        const registry = new ProviderRegistry().register(new FakeLLM({ id: 'fake', answers: [plan] }));
        return createApi({
          config: DEFAULT_CONFIG,
          dataDir: dir,
          providers: { registry, chain: ['fake'], taskModel: () => undefined, files: { codexToken: '', planStore: '' } },
          cache: new MemoryCache(),
        });
      };
      let api = mk(join(tmp, 'a'));
      const http: Http = (url, init) => api.handle(new Request(url, { ...init, headers: { host: '127.0.0.1:8787', ...(init?.headers as Record<string, string>) } }));
      const backend = new ServerBackend('http://127.0.0.1:8787/', http);
      const r = await backend.plan(book, order[0]!.id, {}, new AbortController().signal);
      expect(r.error ?? '').toBe('');
      expect(r.fallback).toBe(false);
      expect(r.plan.keyTerms).toEqual(['Mut']);
      api = mk(join(tmp, 'b')); // restarted, empty book store
      const r2 = await backend.plan(book, order[1]!.id, {}, new AbortController().signal);
      expect(r2.plan.keyTerms).toEqual(['Mut']);
      expect((await backend.status()).chain).toEqual(['fake', 'heuristic']);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('browser backend (BYOK) runs the same director service', async () => {
    const b = new BrowserBackend([new FakeLLM({ id: 'byok', answers: [plan] })]);
    const r = await b.plan(book, order[0]!.id, {}, new AbortController().signal);
    expect(r.plan.meta?.providerId).toBe('byok');
    expect((await b.status()).chain).toEqual(['byok', 'heuristic']);
  });

  test('detection: server first, then BYOK, else none; off disables', async () => {
    const prefs = AiPrefsSchema.parse({});
    const server: Http = async (url) =>
      url.endsWith('/api/capabilities') ? Response.json({ server: 'lesebuehne', chains: { llm: [] }, providers: [] }) : new Response('', { status: 404 });
    const none: Http = async () => new Response('nope', { status: 404 });
    const base = { baseURI: 'http://127.0.0.1:3000/x/', timeoutMs: 200 };
    expect((await detectBackend({ prefs, http: server, ...base }))?.mode).toBe('server');
    expect(await detectBackend({ prefs, http: none, ...base })).toBeUndefined();
    const byok = AiPrefsSchema.parse({ byok: { openrouter: { enabled: true, apiKey: 'k', model: 'm' } } });
    expect((await detectBackend({ prefs: byok, http: none, ...base }))?.mode).toBe('browser');
    expect(await detectBackend({ prefs: { ...prefs, mode: 'off' }, http: server, ...base })).toBeUndefined();
  });

  test('prefs: defaults, broken JSON, masking', async () => {
    const t = await makeEnv();
    t.kv.set(AI_PREFS_KEY, '{broken');
    const p = loadAiPrefs(t.kv);
    expect(p.mode).toBe('auto');
    expect(p.order).toEqual(['openrouter', 'openai-compatible', 'anthropic-compatible']);
    expect(maskKey('sk-or-v1-abcdefghijkl')).toBe('sk-or…ijkl');
    expect(maskKey('')).toBe('');
  });
});
