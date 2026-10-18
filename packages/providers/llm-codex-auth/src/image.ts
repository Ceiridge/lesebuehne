import { ProviderError, readSse, request, type Availability, type FetchLike, type ImageProvider } from '@lesebuehne/core';
import type { CodexAuthLLM } from './index.ts';

export interface CodexImageConfig {
  id?: string;
  /** Driver model that calls the image tool (`auto` = first listed). */
  model?: string;
  /** Image model for the tool (omit for the backend default). */
  imageModel?: string;
  quality?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
}

const b64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/**
 * Images through the ChatGPT Codex backend's `image_generation` tool, with the same token sources
 * as `codex-auth` (OpenCode/Codex CLI read-only, or the own sign-in). The fallback when the
 * `image-use` CLI is not available.
 */
export class CodexImageProvider implements ImageProvider {
  readonly kind = 'image' as const;
  readonly id: string;
  readonly label = 'ChatGPT images via Codex';
  readonly runsIn = ['server'] as const;
  readonly capabilities = { styleReference: true };
  readonly limits = { concurrency: 4 };
  readonly costHint = 'subscription' as const;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly auth: CodexAuthLLM, private readonly config: CodexImageConfig = {}) {
    this.id = config.id ?? 'codex-image';
    this.fetchImpl = config.fetch ?? ((u, i) => fetch(u, i));
  }

  isAvailable(): Promise<Availability> {
    return this.auth.isAvailable();
  }

  private async model(signal: AbortSignal): Promise<string> {
    const wanted = this.config.model ?? 'auto';
    if (wanted !== 'auto') return wanted;
    const first = (await this.auth.catalog(signal))[0]?.slug;
    if (!first) throw new ProviderError(this.id, 'unavailable', 'the Codex backend lists no models for this account');
    return first;
  }

  async generate(req: Parameters<ImageProvider['generate']>[0]): Promise<{ image: Uint8Array; mime: string; model?: string }> {
    const headers = await this.auth.authHeaders(req.signal);
    const model = await this.model(req.signal);
    const text = req.styleRef
      ? `Use the image_generation tool to render the following, matching the visual style of the attached reference image; do not copy its content. Request: ${req.prompt}. Output format: png. Size: ${req.size}. Do not include explanatory text — produce only the image.`
      : `Use the image_generation tool to render the following. Request: ${req.prompt}. Output format: png. Size: ${req.size}. Do not include explanatory text — produce only the image.`;
    const content = [
      ...(req.styleRef ? [{ type: 'input_image', image_url: `data:image/png;base64,${bytesToB64(req.styleRef)}` }] : []),
      { type: 'input_text', text },
    ];
    const tool: Record<string, unknown> = { type: 'image_generation', output_format: 'png', size: req.size };
    if (this.config.imageModel) tool.model = this.config.imageModel;
    if (req.quality ?? this.config.quality) tool.quality = req.quality ?? this.config.quality;
    const res = await request(this.id, this.fetchImpl, this.auth.endpoint('/responses'), {
      method: 'POST',
      signal: req.signal,
      timeoutMs: this.config.timeoutMs ?? 600_000,
      headers: { ...headers, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        model,
        stream: true,
        instructions: 'You are an image generation assistant.',
        input: [{ type: 'message', role: 'user', content }],
        tools: [tool],
        tool_choice: req.styleRef ? 'required' : 'auto',
        parallel_tool_calls: false,
        store: false,
        reasoning: { effort: 'low', summary: 'auto' },
        include: ['reasoning.encrypted_content'],
        text: { verbosity: 'low' },
      }),
    });
    if (!res.body) throw new ProviderError(this.id, 'server', 'empty response');
    let image: string | undefined;
    let failure: string | undefined;
    for await (const ev of readSse(res.body)) {
      if (ev.data === '[DONE]') break;
      let data: { type?: string; item?: { type?: string; result?: string }; response?: { error?: { message?: string; code?: string } }; message?: string };
      try {
        data = JSON.parse(ev.data);
      } catch {
        continue;
      }
      const type = data.type ?? ev.event;
      if (type === 'response.output_item.done' && data.item?.type === 'image_generation_call' && typeof data.item.result === 'string') image = data.item.result;
      if (type === 'error' || type === 'response.failed') failure = data.response?.error?.message ?? data.response?.error?.code ?? data.message ?? type;
    }
    if (!image) {
      const limited = /limit|quota|rate/iu.test(failure ?? '');
      throw new ProviderError(this.id, limited ? 'rate-limit' : 'invalid-output', failure ? `Codex backend: ${failure}` : 'no image in the answer');
    }
    return { image: b64ToBytes(image), mime: 'image/png', model };
  }
}
