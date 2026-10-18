import { VisualPlanSchema, type Book, type ProviderRegistry, type ResultCache, type StyleBible, type VisualPlan } from '@lesebuehne/core';
import { ImageDirector, type ImageOptions } from '@lesebuehne/director';
import { join } from 'node:path';
import * as z from 'zod';
import { DiskStore } from './disk-store.ts';
import { splitImageGrid } from './image-grid.ts';

export { imagePrompt } from '@lesebuehne/director';

export interface ImageResponse {
  url: string;
  providerId: string;
  cached: boolean;
  variants: number;
  selected: number;
  tiles?: Array<{ url: string }>;
}

const FILE = /^[a-z0-9-]{1,90}\.(png|jpg|webp)$/u;
const MIME: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

const ImageBody = z.object({
  bookId: z.string().min(1),
  sectionId: z.string().min(1),
  plan: VisualPlanSchema,
  regenerate: z.boolean().optional(),
  select: z.number().int().min(0).optional(),
  quality: z.enum(['low', 'medium', 'high']).optional(),
  resolution: z.enum(['standard', 'compact', 'square']).optional(),
  styleReference: z.boolean().optional(),
  panels: z.array(z.string().min(1).max(2000)).length(4).optional(),
});

/** Images for `image` plans (spec 005 B2): the shared image director with files on disk. */
export class ImageService {
  private readonly director: ImageDirector;

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
  ) {
    const { dir: _dir, ...rest } = o;
    this.director = new ImageDirector({ ...rest, store: new DiskStore(o.dir), splitGrid: splitImageGrid });
  }

  async generate(book: Book, sectionId: string, plan: VisualPlan, opts: ImageOptions, signal: AbortSignal): Promise<ImageResponse> {
    const r = await this.director.generate(book, sectionId, plan, opts, signal);
    return { url: `api/images/${r.file}`, providerId: r.providerId, cached: r.cached, variants: r.variants, selected: r.selected,
      ...(r.tiles ? { tiles: r.tiles.map(tile => ({ url: `api/images/${tile.file}` })) } : {}) };
  }

  /** `POST /api/images`. */
  async handle(req: Request, getBook: (id: string) => Promise<Book | undefined>): Promise<Response> {
    const body = ImageBody.safeParse(await req.json().catch(() => undefined));
    if (!body.success) return Response.json({ error: 'bad-request', message: body.error.message }, { status: 400 });
    const book = await getBook(body.data.bookId);
    if (!book) return Response.json({ error: 'unknown-book' }, { status: 404 });
    try {
      const { regenerate, select, quality, resolution, styleReference, panels } = body.data;
      return Response.json(await this.generate(book, body.data.sectionId, body.data.plan, {
        ...(regenerate ? { regenerate } : {}), ...(select !== undefined ? { select } : {}),
        ...(quality ? { quality } : {}), ...(styleReference !== undefined ? { styleReference } : {}),
        ...(resolution ? { resolution } : {}),
        ...(panels ? { panels } : {}),
      }, req.signal));
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
    return new Response(f, { headers: { 'content-type': MIME[name.slice(name.lastIndexOf('.') + 1)] ?? 'image/png', 'cache-control': 'private, max-age=31536000, immutable' } });
  }
}
