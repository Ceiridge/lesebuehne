import { addVariant, cacheKey, contentHash, selectedValue, styleBibleVersion, VisualPlanSchema, type Book, type CacheEntry, type ImageProvider, type ProviderRegistry, type ResultCache, type StyleBible, type VisualPlan } from '@lesebuehne/core';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';

/** Stored per variant; the file lives in the images cache directory. */
interface ImageVariant {
  file: string;
  mime: string;
}

export interface ImageResponse {
  url: string;
  providerId: string;
  cached: boolean;
  variants: number;
  selected: number;
}

const SIZES: Record<string, string> = { '16:9': '1536x1024', '3:2': '1536x1024', '4:3': '1536x1024', '1:1': '1024x1024' };
const FILE = /^[a-z0-9-]{1,90}\.(png|jpg)$/u;

const ImageBody = z.object({
  bookId: z.string().min(1),
  sectionId: z.string().min(1),
  plan: VisualPlanSchema,
  regenerate: z.boolean().optional(),
  select: z.number().int().min(0).optional(),
});

/** The full prompt: the director's scene in the book's illustration style, without lettering. */
export function imagePrompt(plan: VisualPlan, sb: StyleBible | undefined): string {
  return [plan.image?.prompt ?? '', sb ? `Style: ${sb.illustrationStyle}` : '', 'No text, no letters, no captions, no watermarks.'].filter(Boolean).join('\n\n');
}

/**
 * Images for `image` plans (spec 005 B2): provider chain, disk files, variants, and the book's
 * first image as style reference for the following ones.
 */
export class ImageService {
  private readonly inflight = new Map<string, Promise<CacheEntry<ImageVariant>>>();

  constructor(
    private readonly o: {
      registry: ProviderRegistry;
      chain: string[];
      cache: ResultCache;
      dir: string;
      styleReference: boolean;
      styleBible: (book: Book) => Promise<StyleBible | undefined>;
      log?: (line: string) => void;
    },
  ) {}

  private refKey = (book: Book): string => cacheKey('imgref', { book: book.id });

  private async styleRef(book: Book): Promise<Uint8Array | undefined> {
    if (!this.o.styleReference) return undefined;
    const ref = selectedValue(await this.o.cache.get<ImageVariant>(this.refKey(book)));
    const f = ref ? Bun.file(join(this.o.dir, ref.file)) : undefined;
    return f && (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : undefined;
  }

  async generate(book: Book, sectionId: string, plan: VisualPlan, opts: { regenerate?: boolean; select?: number }, signal: AbortSignal): Promise<ImageResponse> {
    if (plan.mode !== 'image' || !plan.image) throw new Error('plan has no image');
    const sb = await this.o.styleBible(book);
    const key = cacheKey('img', { book: book.id, section: sectionId, spec: contentHash(JSON.stringify(plan.image)), style: styleBibleVersion(sb), chain: this.o.chain.join(',') });
    let entry = await this.o.cache.get<ImageVariant>(key);
    if (entry && opts.select !== undefined && opts.select < entry.variants.length) {
      entry = { ...entry, selected: opts.select };
      await this.o.cache.put(key, entry);
    }
    const respond = (e: CacheEntry<ImageVariant>, cached: boolean): ImageResponse => ({
      url: `api/images/${selectedValue(e)!.file}`,
      providerId: e.variants[e.selected]?.providerId ?? '?',
      cached,
      variants: e.variants.length,
      selected: e.selected,
    });
    if (entry && !opts.regenerate) return respond(entry, true);
    const flight = `${key}:${opts.regenerate ? 'r' : ''}`;
    let p = this.inflight.get(flight);
    if (!p) {
      p = (async () => {
        const styleRef = await this.styleRef(book);
        const size = SIZES[plan.image!.aspect] ?? '1536x1024';
        const r = await this.o.registry.run(
          'image',
          this.o.chain,
          (provider: ImageProvider, s) => provider.generate({ prompt: imagePrompt(plan, sb), size, ...(styleRef ? { styleRef } : {}), signal: s }),
          signal,
        );
        const before = await this.o.cache.get<ImageVariant>(key);
        const file = `${key}-${before?.variants.length ?? 0}.${r.value.mime === 'image/jpeg' ? 'jpg' : 'png'}`;
        await mkdir(this.o.dir, { recursive: true });
        const tmp = join(this.o.dir, `${file}.${crypto.randomUUID()}.tmp`);
        await Bun.write(tmp, r.value.image);
        await rename(tmp, join(this.o.dir, file));
        const next = addVariant(before, { file, mime: r.value.mime }, r.providerId, r.value.model);
        await this.o.cache.put(key, next);
        // The first image of a book sets its visual style for the following ones.
        if (!(await this.o.cache.get(this.refKey(book)))) await this.o.cache.put(this.refKey(book), addVariant(undefined, { file, mime: r.value.mime }, r.providerId));
        this.o.log?.(`image ${sectionId} ← ${r.providerId} (${Math.round(r.value.image.byteLength / 1024)} KB${styleRef ? ', style ref' : ''})`);
        return next;
      })().finally(() => this.inflight.delete(flight));
      this.inflight.set(flight, p);
    }
    return respond(await p, false);
  }

  /** `POST /api/images`. */
  async handle(req: Request, getBook: (id: string) => Promise<Book | undefined>): Promise<Response> {
    const body = ImageBody.safeParse(await req.json().catch(() => undefined));
    if (!body.success) return Response.json({ error: 'bad-request', message: body.error.message }, { status: 400 });
    const book = await getBook(body.data.bookId);
    if (!book) return Response.json({ error: 'unknown-book' }, { status: 404 });
    try {
      const { regenerate, select } = body.data;
      return Response.json(await this.generate(book, body.data.sectionId, body.data.plan, { ...(regenerate ? { regenerate } : {}), ...(select !== undefined ? { select } : {}) }, req.signal));
    } catch (e) {
      if (req.signal.aborted) return Response.json({ error: 'aborted' }, { status: 499 });
      return Response.json({ error: 'unavailable', message: e instanceof Error ? e.message : String(e) }, { status: 503 });
    }
  }

  /** `GET /api/images/<file>`: only names this service writes. */
  async serve(name: string): Promise<Response> {
    if (!FILE.test(name)) return new Response('Bad Request', { status: 400 });
    const f = Bun.file(join(this.o.dir, name));
    if (!(await f.exists())) return new Response('Not Found', { status: 404 });
    return new Response(f, { headers: { 'content-type': name.endsWith('.jpg') ? 'image/jpeg' : 'image/png', 'cache-control': 'private, max-age=31536000, immutable' } });
  }
}
