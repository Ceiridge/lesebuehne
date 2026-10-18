import { WavStreamEncoder, type ProviderRegistry } from '@lesebuehne/core';
import { SpeechDirector, type SpeechOutcome } from '@lesebuehne/director';
import * as z from 'zod';
import { DiskStore } from './disk-store.ts';

const TtsBody = z.object({
  text: z.string().min(1).max(1200),
  lang: z.string().min(2).max(20),
  /** `<providerId>:<voiceId>`. */
  voice: z.string().min(3).max(120),
});

export type TtsResult = SpeechOutcome;

const failure = (e: unknown, signal: AbortSignal): Response => {
  if (signal.aborted) return Response.json({ error: 'aborted' }, { status: 499 });
  const message = e instanceof Error ? e.message : String(e);
  const unknown = message.startsWith('unknown voice');
  return Response.json({ error: unknown ? 'unknown-voice' : 'unavailable', message }, { status: unknown ? 404 : 503 });
};

/**
 * Server TTS (spec 004 B3): the shared speech director with clips cached on disk. Streaming
 * providers (qwentts, OpenAI) are synthesized as PCM streams, so `GET /api/tts/stream` can play an
 * utterance while it is generated; `POST /api/tts` joins the same synthesis for the aligned clip.
 */
export class TtsService {
  private readonly director: SpeechDirector;

  constructor(registry: ProviderRegistry, dir: string) {
    this.director = new SpeechDirector(registry, new DiskStore(dir), { stream: true });
  }

  speak(text: string, lang: string, voice: string, signal: AbortSignal): Promise<TtsResult> {
    return this.director.speak(text, lang, voice, signal);
  }

  /** `POST /api/tts` handler: the whole clip with word timings. */
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
      return failure(e, req.signal);
    }
  }

  /**
   * `GET /api/tts/stream?text=…&lang=…&voice=…` for an `<audio>` element: a WAV that starts with the
   * first generated frames. Cached or already finished clips come back whole.
   */
  async handleStream(req: Request): Promise<Response> {
    const q = new URL(req.url).searchParams;
    const body = TtsBody.safeParse({ text: q.get('text'), lang: q.get('lang'), voice: q.get('voice') });
    if (!body.success) return Response.json({ error: 'bad-request', message: body.error.message }, { status: 400 });
    const headers = { 'content-type': 'audio/wav', 'cache-control': 'no-store' };
    try {
      const r = await this.director.stream(body.data.text, body.data.lang, body.data.voice, req.signal);
      if ('done' in r) return new Response(r.done.audio as BodyInit, { headers });
      const chunks = r.live.read(req.signal);
      const wav = new WavStreamEncoder(r.live.sampleRate);
      let sentHeader = false;
      return new Response(new ReadableStream<Uint8Array>({
        async pull(ctrl) {
          if (!sentHeader) {
            sentHeader = true;
            ctrl.enqueue(wav.header());
            return;
          }
          try {
            const next = await chunks.next();
            if (next.done) ctrl.close();
            else ctrl.enqueue(wav.encode(next.value));
          } catch (e) {
            ctrl.error(e);
          }
        },
        async cancel() {
          await chunks.return(undefined);
        },
      }), { headers: { ...headers, 'x-lb-streaming': 'true' } });
    } catch (e) {
      return failure(e, req.signal);
    }
  }
}
