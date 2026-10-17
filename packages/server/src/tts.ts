import type { ProviderRegistry } from '@lesebuehne/core';
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

/** Server TTS (spec 004 B3): the shared speech director with clips cached on disk. */
export class TtsService {
  private readonly director: SpeechDirector;

  constructor(registry: ProviderRegistry, dir: string) {
    this.director = new SpeechDirector(registry, new DiskStore(dir));
  }

  speak(text: string, lang: string, voice: string, signal: AbortSignal): Promise<TtsResult> {
    return this.director.speak(text, lang, voice, signal);
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
