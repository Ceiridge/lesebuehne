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
    const png = image[0] === 0x89 && image[1] === 0x50;
    return { image, mime: png ? 'image/png' : 'image/jpeg', ...(body.model ? { model: body.model } : {}) };
  }
}

export default function create(config: OpenAICompatibleImageConfig): OpenAICompatibleImages {
  return new OpenAICompatibleImages(config);
}
