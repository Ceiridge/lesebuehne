import { ALIGNER_VERSION, alignWords, cacheKey, contentHash, decodeWav, type ProviderRegistry, type TTSProvider, type WordTiming } from '@lesebuehne/core';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';

const TtsBody = z.object({
  text: z.string().min(1).max(1200),
  lang: z.string().min(2).max(20),
  /** `<providerId>:<voiceId>`. */
  voice: z.string().min(3).max(120),
});

export interface TtsResult {
  audio: Uint8Array;
  words: WordTiming[];
  providerId: string;
  cached: boolean;
}

/**
 * Server TTS (spec 004 B3): the voice names its provider; synthesis goes through the registry
 * (gate, cooldown, stats), audio is aligned with the energy aligner and cached on disk.
 */
export class TtsService {
  private readonly inflight = new Map<string, Promise<TtsResult>>();

  constructor(private readonly registry: ProviderRegistry, private readonly dir: string) {}

  private async read(key: string): Promise<{ audio: Uint8Array; words: WordTiming[]; providerId: string } | undefined> {
    const wav = Bun.file(join(this.dir, `${key}.wav`));
    const meta = Bun.file(join(this.dir, `${key}.json`));
    if (!(await wav.exists()) || !(await meta.exists())) return undefined;
    try {
      const m = (await meta.json()) as { words: WordTiming[]; providerId: string };
      return { audio: new Uint8Array(await wav.arrayBuffer()), words: m.words, providerId: m.providerId };
    } catch {
      return undefined;
    }
  }

  private async write(key: string, audio: Uint8Array, words: WordTiming[], providerId: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const [ext, data] of [
      ['json', JSON.stringify({ words, providerId })],
      ['wav', audio],
    ] as const) {
      const target = join(this.dir, `${key}.${ext}`);
      const tmp = `${target}.${crypto.randomUUID()}.tmp`;
      await Bun.write(tmp, data);
      await rename(tmp, target);
    }
  }

  async speak(text: string, lang: string, voice: string, signal: AbortSignal): Promise<TtsResult> {
    const sep = voice.indexOf(':');
    const providerId = voice.slice(0, sep);
    const voiceId = voice.slice(sep + 1);
    if (sep <= 0 || !voiceId || !this.registry.get(providerId, 'tts')) throw new Error(`unknown voice ${voice}`);
    const key = cacheKey('tts', { provider: providerId, voice: voiceId, lang, text: contentHash(text), aligner: ALIGNER_VERSION });
    const hit = await this.read(key);
    if (hit) return { ...hit, cached: true };
    let p = this.inflight.get(key);
    if (!p) {
      p = (async () => {
        const r = await this.registry.run('tts', [providerId], (provider: TTSProvider, s) => provider.synthesize({ text, lang, voice: voiceId, signal: s }), signal);
        const words = r.value.words ?? alignWords(decodeWav(r.value.audio), text, lang);
        await this.write(key, r.value.audio, words, r.providerId);
        return { audio: r.value.audio, words, providerId: r.providerId, cached: false };
      })().finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  /** `POST /api/tts` handler. */
  async handle(req: Request): Promise<Response> {
    const body = TtsBody.safeParse(await req.json().catch(() => undefined));
    if (!body.success) return Response.json({ error: 'bad-request', message: body.error.message }, { status: 400 });
    try {
      const r = await this.speak(body.data.text, body.data.lang, body.data.voice, req.signal);
      return new Response(r.audio as BodyInit, {
        headers: {
          'content-type': 'audio/wav',
          'cache-control': 'no-store',
          'x-lb-words': encodeURIComponent(JSON.stringify(r.words)),
          'x-lb-provider': r.providerId,
          'x-lb-cached': String(r.cached),
        },
      });
    } catch (e) {
      if (req.signal.aborted) return Response.json({ error: 'aborted' }, { status: 499 });
      const message = e instanceof Error ? e.message : String(e);
      return Response.json({ error: message.startsWith('unknown voice') ? 'unknown-voice' : 'unavailable', message }, { status: message.startsWith('unknown voice') ? 404 : 503 });
    }
  }
}
