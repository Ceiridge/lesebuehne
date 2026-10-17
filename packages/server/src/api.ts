import { BookSchema, contentHash, VisualPlanSchema, type Book, type ResultCache } from '@lesebuehne/core';
import { DirectorService, PLAN_PROMPT_VERSION, registryComplete, STYLE_PROMPT_VERSION } from '@lesebuehne/director';
import { startPlanLogin } from '@lesebuehne/llm-chatgpt-plan';
import { CodexAuthLLM, startCodexLogin } from '@lesebuehne/llm-codex-auth';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import type { ServerConfig } from './config.ts';
import type { ProviderSetup } from './providers.ts';
import { TtsService } from './tts.ts';
import { ImageService } from './images.ts';

export const SERVER_VERSION = '0.2.0';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface ApiContext {
  config: ServerConfig;
  dataDir: string;
  providers: ProviderSetup;
  cache: ResultCache;
  /** Test hooks for the own sign-in flows. */
  login?: Partial<Record<'codex-auth' | 'chatgpt-plan', () => Promise<{ url: string; done: Promise<unknown>; cancel(): void }>>>;
  log?: (line: string) => void;
}

export type ServerEvent =
  | { type: 'job'; job: 'plan' | 'style' | 'animate'; key: string; state: 'start' | 'done' | 'error'; providerId?: string; fallback?: boolean; sectionId?: string }
  | { type: 'auth'; providerId: string; ok: boolean; reason?: string }
  | { type: 'status' };

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status: number, error: string, message?: string): Response => json({ error, ...(message ? { message } : {}) }, status);

const PlanBody = z.object({
  bookId: z.string().min(1),
  sectionId: z.string().min(1),
  previous: VisualPlanSchema.optional(),
  budget: z.object({ images: z.number().int().min(0), animations: z.number().int().min(0) }).optional(),
  regenerate: z.boolean().optional(),
  select: z.number().int().min(0).optional(),
});
const AnimateBody = z.object({
  bookId: z.string().min(1),
  sectionId: z.string().min(1),
  plan: VisualPlanSchema,
  regenerate: z.boolean().optional(),
  select: z.number().int().min(0).optional(),
  error: z.string().max(500).optional(),
});
const PrepareBody = z.object({ bookId: z.string().min(1), regenerate: z.boolean().optional(), select: z.number().int().min(0).optional() });

/**
 * The local API (B7). Only loopback hosts (DNS-rebinding guard) and allowed origins (same origin
 * plus configured ones); no secret ever leaves the provider objects.
 */
export function createApi(ctx: ApiContext): { handle(req: Request): Promise<Response>; close(): void; emit(e: ServerEvent): void } {
  const { registry, chain } = ctx.providers;
  const books = new Map<string, Book>();
  const listeners = new Set<(e: ServerEvent) => void>();
  const logins = new Map<string, { cancel(): void }>();
  const booksDir = join(ctx.dataDir, 'books');
  const log = ctx.log ?? (() => {});

  const emit = (e: ServerEvent): void => {
    for (const l of listeners) l(e);
  };

  const bookFile = (id: string): string => join(booksDir, `${contentHash(id)}.json`);
  async function getBook(id: string): Promise<Book | undefined> {
    const known = books.get(id);
    if (known) return known;
    const f = Bun.file(bookFile(id));
    if (!(await f.exists())) return undefined;
    const parsed = BookSchema.safeParse(await f.json().catch(() => undefined));
    if (!parsed.success || parsed.data.id !== id) return undefined;
    books.set(id, parsed.data);
    return parsed.data;
  }

  const tts = new TtsService(registry, join(ctx.dataDir, 'cache', 'tts'));
  const images = new ImageService({
    registry,
    chain: ctx.providers.imageChain ?? [],
    cache: ctx.cache,
    dir: join(ctx.dataDir, 'cache', 'images'),
    styleReference: ctx.config.images?.styleReference ?? true,
    styleBible: (book) => director.styleBible(book),
    log,
  });
  const director = new DirectorService({
    complete: registryComplete(registry, chain, ctx.providers.taskModel),
    cache: ctx.cache,
    chainId: chain.join(','),
    budget: ctx.config.director.budget,
    onEvent: (e) => emit({ type: 'job', ...e }),
    log,
  });

  async function prepare(req: Request): Promise<Response> {
    const body = PrepareBody.safeParse(await req.json().catch(() => undefined));
    if (!body.success) return fail(400, 'bad-request', body.error.message);
    const book = await getBook(body.data.bookId);
    if (!book) return fail(404, 'unknown-book');
    try {
      const { regenerate, select } = body.data;
      return json(await director.prepare(book, { ...(regenerate ? { regenerate } : {}), ...(select !== undefined ? { select } : {}) }, req.signal));
    } catch (e) {
      if (req.signal.aborted) return fail(499, 'aborted');
      return fail(503, 'unavailable', e instanceof Error ? e.message : String(e));
    }
  }

  async function animate(req: Request): Promise<Response> {
    const body = AnimateBody.safeParse(await req.json().catch(() => undefined));
    if (!body.success) return fail(400, 'bad-request', body.error.message);
    const book = await getBook(body.data.bookId);
    if (!book) return fail(404, 'unknown-book');
    if (!book.chapters.some((c) => c.sections.some((x) => x.id === body.data.sectionId))) return fail(404, 'unknown-section');
    const { regenerate, select, error } = body.data;
    try {
      return json(
        await director.animate(
          book,
          body.data.sectionId,
          body.data.plan,
          { ...(regenerate ? { regenerate } : {}), ...(select !== undefined ? { select } : {}), ...(error ? { error } : {}) },
          req.signal,
        ),
      );
    } catch (e) {
      if (req.signal.aborted) return fail(499, 'aborted');
      return fail(503, 'unavailable', e instanceof Error ? e.message : String(e));
    }
  }

  async function plan(req: Request): Promise<Response> {
    const body = PlanBody.safeParse(await req.json().catch(() => undefined));
    if (!body.success) return fail(400, 'bad-request', body.error.message);
    const book = await getBook(body.data.bookId);
    if (!book) return fail(404, 'unknown-book');
    if (!book.chapters.some((c) => c.sections.some((x) => x.id === body.data.sectionId))) return fail(404, 'unknown-section');
    const { previous, budget, regenerate, select } = body.data;
    try {
      return json(
        await director.plan(
          book,
          body.data.sectionId,
          { ...(previous ? { previous } : {}), ...(budget ? { budget } : {}), ...(regenerate ? { regenerate } : {}), ...(select !== undefined ? { select } : {}) },
          req.signal,
        ),
      );
    } catch {
      return fail(499, 'aborted');
    }
  }

  async function putBook(req: Request, id: string): Promise<Response> {
    const parsed = BookSchema.safeParse(await req.json().catch(() => undefined));
    if (!parsed.success) return fail(400, 'bad-request', 'invalid book');
    if (parsed.data.id !== id) return fail(400, 'bad-request', 'book id mismatch');
    books.set(id, parsed.data);
    await mkdir(booksDir, { recursive: true });
    await Bun.write(bookFile(id), JSON.stringify(parsed.data));
    return json({ ok: true });
  }

  async function capabilities(): Promise<Response> {
    const providers = await Promise.all(
      registry.list().map(async (p) => {
        const a = await registry.available(p.id);
        const s = registry.statsOf(p.id);
        return {
          id: p.id,
          kind: p.kind,
          label: p.label,
          runsIn: p.runsIn,
          costHint: p.costHint ?? null,
          available: a.ok,
          reason: a.reason ?? null,
          coolingUntil: s?.coolingUntil ?? null,
          source: p instanceof CodexAuthLLM ? (p.lastSource ?? null) : null,
          login: p.id === 'codex-auth' || p.id === 'chatgpt-plan',
          ...(p.kind === 'tts' ? { voices: p.voices } : {}),
        };
      }),
    );
    return json({
      server: 'lesebuehne',
      version: SERVER_VERSION,
      prompts: { plan: PLAN_PROMPT_VERSION, style: STYLE_PROMPT_VERSION },
      chains: { llm: [...chain, 'heuristic'], image: ctx.providers.imageChain ?? [] },
      budget: ctx.config.director.budget,
      providers,
    });
  }

  function usage(): Response {
    return json({ providers: Object.fromEntries(registry.list().map((p) => [p.id, registry.statsOf(p.id)])) });
  }

  function events(req: Request): Response {
    let cleanup = (): void => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        const send = (e: ServerEvent): void => controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        const ping = setInterval(() => controller.enqueue(enc.encode(': ping\n\n')), 25_000);
        listeners.add(send);
        cleanup = () => {
          clearInterval(ping);
          listeners.delete(send);
        };
        req.signal.addEventListener('abort', () => {
          cleanup();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
        controller.enqueue(enc.encode(': connected\n\n'));
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' } });
  }

  async function login(providerId: string): Promise<Response> {
    const start =
      ctx.login?.[providerId as 'codex-auth'] ??
      (providerId === 'codex-auth'
        ? () => startCodexLogin({ tokenFile: ctx.providers.files.codexToken })
        : providerId === 'chatgpt-plan'
          ? () => startPlanLogin({ storeFile: ctx.providers.files.planStore })
          : undefined);
    if (!start || !registry.get(providerId)) return fail(404, 'unknown-provider');
    logins.get(providerId)?.cancel();
    try {
      const session = await start();
      logins.set(providerId, session);
      session.done.then(
        () => {
          registry.invalidate(providerId);
          emit({ type: 'auth', providerId, ok: true });
          log(`sign-in ${providerId}: ok`);
        },
        (e: unknown) => emit({ type: 'auth', providerId, ok: false, reason: e instanceof Error ? e.message : String(e) }),
      ).finally(() => logins.delete(providerId));
      return json({ url: session.url });
    } catch (e) {
      return fail(500, 'login-failed', e instanceof Error ? e.message : String(e));
    }
  }

  function allowed(req: Request): string | null | false {
    const url = new URL(req.url);
    const host = req.headers.get('host') ?? url.host;
    const hostname = host.replace(/:\d+$/u, '');
    if (!LOCAL_HOSTS.has(hostname)) return false;
    const origin = req.headers.get('origin');
    if (!origin) return null;
    if (origin === `${url.protocol}//${host}`) return origin;
    return ctx.config.server.origins.includes(origin) ? origin : false;
  }

  async function handle(req: Request): Promise<Response> {
    const origin = allowed(req);
    if (origin === false) return fail(403, 'forbidden-origin');
    const cors: Record<string, string> = origin
      ? {
          'access-control-allow-origin': origin,
          vary: 'origin',
          'access-control-allow-headers': 'content-type',
          'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
          'access-control-expose-headers': 'x-lb-words, x-lb-provider, x-lb-cached',
        }
      : {};
    if (req.method === 'OPTIONS') {
      // Private Network Access: a hosted (https) page may call this loopback server once allowed.
      const pna: Record<string, string> = origin && req.headers.get('access-control-request-private-network') === 'true' ? { 'access-control-allow-private-network': 'true' } : {};
      return new Response(null, { status: 204, headers: { ...cors, ...pna } });
    }
    const path = new URL(req.url).pathname;
    let res: Response;
    const m = /^\/api\/(?:books\/([^/]+)|auth\/([^/]+)\/login)$/u.exec(path);
    if (req.method === 'GET' && path === '/api/capabilities') res = await capabilities();
    else if (req.method === 'GET' && path === '/api/usage') res = usage();
    else if (req.method === 'GET' && path === '/api/events') res = events(req);
    else if (req.method === 'POST' && path === '/api/llm/plan') res = await plan(req);
    else if (req.method === 'POST' && path === '/api/llm/prepare') res = await prepare(req);
    else if (req.method === 'POST' && path === '/api/llm/animate') res = await animate(req);
    else if (req.method === 'POST' && path === '/api/tts') res = await tts.handle(req);
    else if (req.method === 'POST' && path === '/api/images') res = await images.handle(req, getBook);
    else if (req.method === 'GET' && path.startsWith('/api/images/')) res = await images.serve(decodeURIComponent(path.slice('/api/images/'.length)));
    else if (req.method === 'PUT' && m?.[1]) res = await putBook(req, decodeURIComponent(m[1]));
    else if (req.method === 'POST' && m?.[2]) res = await login(decodeURIComponent(m[2]));
    else res = fail(404, 'not-found');
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  }

  return {
    handle,
    emit,
    close() {
      for (const l of logins.values()) l.cancel();
      logins.clear();
    },
  };
}
