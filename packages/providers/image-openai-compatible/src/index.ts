/**
 * @lesebuehne/image-openai-compatible — `POST {baseURL}/images/generations` (OpenAI and
 * compatible endpoints), answer as `b64_json` (or a URL that is downloaded).
 */
import { ProviderError, request, type Availability, type FetchLike, type ImageProvider, type RunsIn } from '@lesebuehne/core';

export interface OpenAICompatibleImageConfig {
  id: string;
  label?: string;
  baseURL: string;
  apiKey?: string;
  model?: string;
  /** Extra body fields (`quality` …). */
  body?: Record<string, unknown>;
  requiresKey?: boolean;
  timeoutMs?: number;
  runsIn?: readonly RunsIn[];
  fetch?: FetchLike;
}

export class OpenAICompatibleImages implements ImageProvider {
  readonly kind = 'image' as const;
  readonly id: string;
  readonly label: string;
  readonly runsIn: readonly RunsIn[];
  readonly capabilities = { styleReference: false };
  readonly limits = { concurrency: 2 };
  readonly costHint: 'metered' | 'free';
  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: OpenAICompatibleImageConfig) {
    this.id = config.id;
    this.label = config.label ?? config.id;
    this.runsIn = config.runsIn ?? ['server'];
    this.costHint = config.requiresKey ? 'metered' : 'free';
    this.fetchImpl = config.fetch ?? ((u, i) => fetch(u, i));
  }

  async isAvailable(): Promise<Availability> {
    if (!this.config.baseURL) return { ok: false, reason: 'no base URL configured' };
    if (this.config.requiresKey && !this.config.apiKey) return { ok: false, reason: 'no API key configured' };
    return { ok: true };
  }

  async generate(req: { prompt: string; size: string; signal: AbortSignal }): Promise<{ image: Uint8Array; mime: string; model?: string }> {
    const res = await request(this.id, this.fetchImpl, `${this.config.baseURL.replace(/\/+$/u, '')}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) },
      body: JSON.stringify({ ...(this.config.model ? { model: this.config.model } : {}), prompt: req.prompt, size: req.size, n: 1, ...this.config.body }),
      timeoutMs: this.config.timeoutMs ?? 300_000,
      signal: req.signal,
    });
    const body = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }>; model?: string };
    const first = body.data?.[0];
    let image: Uint8Array | undefined;
    if (first?.b64_json) image = Uint8Array.from(atob(first.b64_json), (c) => c.charCodeAt(0));
    else if (first?.url) {
      const img = await request(this.id, this.fetchImpl, first.url, { signal: req.signal, timeoutMs: 60_000 });
      image = new Uint8Array(await img.arrayBuffer());
    }
    if (!image || image.byteLength < 100) throw new ProviderError(this.id, 'invalid-output', 'no image in the answer');
    return { image, mime: imageMimeOf(image), ...(body.model ? { model: body.model } : {}) };
  }
}

export default function create(config: OpenAICompatibleImageConfig): OpenAICompatibleImages {
  return new OpenAICompatibleImages(config);
}

const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const fromDataUrl = (url: string): Uint8Array | undefined => {
  const m = /^data:image\/[a-z+.-]+;base64,(.+)$/su.exec(url);
  return m ? Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0)) : undefined;
};

export interface OpenRouterImagesConfig {
  id?: string;
  apiKey?: string;
  /** An image-capable model (no default: names change, the user picks one). */
  model?: string;
  timeoutMs?: number;
  runsIn?: readonly RunsIn[];
  fetch?: FetchLike;
}

/**
 * Image models on OpenRouter (spec 006 B3): `chat/completions` with `modalities: ["image",
 * "text"]`; the answer carries the picture as a data URL. The style reference goes along as an
 * input image.
 */
export class OpenRouterImages implements ImageProvider {
  readonly kind = 'image' as const;
  readonly id: string;
  readonly label = 'OpenRouter images';
  readonly runsIn: readonly RunsIn[];
  readonly capabilities = { styleReference: true };
  readonly limits = { concurrency: 2 };
  readonly costHint = 'metered' as const;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: OpenRouterImagesConfig) {
    this.id = config.id ?? 'openrouter-images';
    this.runsIn = config.runsIn ?? ['server', 'browser'];
    this.fetchImpl = config.fetch ?? ((u, i) => fetch(u, i));
  }

  async isAvailable(): Promise<Availability> {
    if (!this.config.apiKey) return { ok: false, reason: 'no API key configured' };
    if (!this.config.model) return { ok: false, reason: 'no image model configured' };
    return { ok: true };
  }

  async generate(req: { prompt: string; size: string; styleRef?: Uint8Array; signal: AbortSignal }): Promise<{ image: Uint8Array; mime: string; model?: string }> {
    const [w, h] = req.size.split('x').map(Number);
    const aspect = w && h ? (w === h ? '1:1' : w > h ? '3:2' : '2:3') : '3:2';
    const text = req.styleRef ? `${req.prompt}\n\nMatch the visual style of the attached reference image (not its content).` : req.prompt;
    const res = await request(this.id, this.fetchImpl, 'https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey ?? ''}`, 'X-Title': 'Lesebuehne', 'HTTP-Referer': 'https://lesebuehne.local' },
      body: JSON.stringify({
        model: this.config.model,
        modalities: ['image', 'text'],
        image_config: { aspect_ratio: aspect },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text },
              ...(req.styleRef ? [{ type: 'image_url', image_url: { url: `data:${imageMimeOf(req.styleRef)};base64,${toBase64(req.styleRef)}` } }] : []),
            ],
          },
        ],
      }),
      timeoutMs: this.config.timeoutMs ?? 300_000,
      signal: req.signal,
    });
    const body = (await res.json()) as { model?: string; choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }> };
    const url = body.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    let image = url ? fromDataUrl(url) : undefined;
    if (!image && url) {
      const img = await request(this.id, this.fetchImpl, url, { signal: req.signal, timeoutMs: 60_000 });
      image = new Uint8Array(await img.arrayBuffer());
    }
    if (!image || image.byteLength < 100) throw new ProviderError(this.id, 'invalid-output', 'no image in the answer');
    return { image, mime: imageMimeOf(image), ...(body.model ? { model: body.model } : {}) };
  }
}

/** PNG, JPEG or WebP by magic bytes. */
export function imageMimeOf(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return 'image/webp';
  return 'image/png';
}
