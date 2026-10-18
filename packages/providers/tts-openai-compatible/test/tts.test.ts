import { describe, expect, test } from 'bun:test';
import { decodeWav, encodeWav, ProviderError } from '@lesebuehne/core';
import { openaiTTS, OpenAICompatibleTTS, qwentts } from '../src/index.ts';

const wav = encodeWav({ samples: new Float32Array(2400).fill(0.1), sampleRate: 24000 });
const signal = new AbortController().signal;

function fakeFetch(answer: (url: string, body: Record<string, unknown>) => Response) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    return answer(url, body);
  };
  return { fetch, calls };
}

describe('M4: tts-openai-compatible', () => {
  test('qwentts preset: wav, language by name, seed, no key', async () => {
    const f = fakeFetch(() => new Response(wav as BodyInit));
    const tts = qwentts({ baseURL: 'http://127.0.0.1:8080/v1', voices: ['vivian'], fetch: f.fetch });
    const r = await tts.synthesize({ text: 'Habe Mut.', lang: 'de-DE', voice: 'vivian', signal });
    expect(r.mime).toBe('audio/wav');
    expect(decodeWav(r.audio).sampleRate).toBe(24000);
    expect(f.calls[0]!.url).toBe('http://127.0.0.1:8080/v1/audio/speech');
    expect(f.calls[0]!.body).toEqual({ input: 'Habe Mut.', voice: 'vivian', response_format: 'wav', language: 'German', seed: 42 });
    expect(f.calls[0]!.headers.authorization).toBeUndefined();
    expect(tts.limits.concurrency).toBe(1);
    expect(await tts.isAvailable()).toEqual({ ok: true });
  });

  test('pcm is wrapped as WAV; non-audio answers and HTTP errors become ProviderErrors', async () => {
    const pcm = encodeWav({ samples: new Float32Array(480).fill(0.2), sampleRate: 16000 }).slice(44);
    const p = new OpenAICompatibleTTS({ id: 'p', baseURL: 'http://x/v1', voices: [{ id: 'a', name: 'A', languages: [] }], format: 'pcm', pcmSampleRate: 16000, fetch: fakeFetch(() => new Response(pcm as BodyInit)).fetch });
    expect(decodeWav((await p.synthesize({ text: 'x', lang: 'en', signal })).audio).samples.length).toBe(480);
    const html = new OpenAICompatibleTTS({ id: 'h', baseURL: 'http://x/v1', voices: [{ id: 'a', name: 'A', languages: [] }], fetch: fakeFetch(() => new Response('<html>'.repeat(20))).fetch });
    await expect(html.synthesize({ text: 'x', lang: 'en', signal })).rejects.toMatchObject({ code: 'invalid-output' });
    const limited = new OpenAICompatibleTTS({ id: 'l', baseURL: 'http://x/v1', voices: [{ id: 'a', name: 'A', languages: [] }], fetch: fakeFetch(() => new Response('slow', { status: 429 })).fetch });
    const e = await limited.synthesize({ text: 'x', lang: 'en', signal }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).code).toBe('rate-limit');
  });

  test('availability: key required for cloud, unreachable local server', async () => {
    expect(await openaiTTS({}).isAvailable()).toEqual({ ok: false, reason: 'no API key configured' });
    const down = qwentts({ voices: ['v'], fetch: async () => Promise.reject(new Error('ECONNREFUSED')) });
    expect((await down.isAvailable()).ok).toBe(false);
    const f = fakeFetch(() => new Response(wav as BodyInit));
    await openaiTTS({ apiKey: 'k', fetch: f.fetch }).synthesize({ text: 'Hi', lang: 'en', voice: 'nova', signal });
    expect(f.calls[0]!.headers.authorization).toBe('Bearer k');
    expect(f.calls[0]!.body.language).toBeUndefined();
  });

  test('qwentts streams raw PCM chunks as they arrive', async () => {
    const parts = [new Uint8Array(480).fill(1), new Uint8Array(960).fill(2)];
    const f = fakeFetch(() => new Response(new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(p);
        c.close();
      },
    })));
    const tts = qwentts({ voices: ['vivian'], fetch: f.fetch });
    expect(tts.capabilities.streaming).toBe(true);
    const st = await tts.synthesizeStream!({ text: 'Habe Mut.', lang: 'de', voice: 'vivian', signal });
    const got: number[] = [];
    for await (const c of st.chunks) got.push(c.byteLength);
    expect(got).toEqual([480, 960]);
    expect(st.sampleRate).toBe(24000);
    expect(f.calls[0]!.body.response_format).toBe('pcm');
    expect(new OpenAICompatibleTTS({ id: 'x', baseURL: 'http://x/v1', voices: [] }).synthesizeStream).toBeUndefined();
  });
});
