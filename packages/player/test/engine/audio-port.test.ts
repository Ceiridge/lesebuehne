import { describe, expect, test } from 'bun:test';
import { TtsBuffer } from '../../src/ai/tts.ts';
import { AudioSpeechPort, RoutingSpeechPort, type AudioLike, type Ticker, type TtsSource } from '../../src/engine/audio-port.ts';
import type { SpeechPort, UtteranceRequest } from '../../src/engine/speech-port.ts';

class FakeAudio implements AudioLike {
  src = '';
  playbackRate = 1;
  preservesPitch = false;
  currentTime = 0;
  paused = true;
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  async play(): Promise<void> {
    this.paused = false;
    queueMicrotask(() => this.onplaying?.());
  }
  pause(): void {
    this.paused = true;
  }
}

class FakeTicker implements Ticker {
  fns = new Set<() => void>();
  every(_ms: number, fn: () => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  tick(): void {
    for (const f of this.fns) f();
  }
}

const flush = () => new Promise((r) => setTimeout(r, 5));

function request(over: Partial<UtteranceRequest> = {}) {
  const events: string[] = [];
  const r: UtteranceRequest = {
    text: 'Habe Mut, dich zu bedienen.',
    lang: 'de',
    voiceURI: 'tts:qwentts:vivian',
    rate: 1.5,
    onStart: () => events.push('start'),
    onBoundary: (i, name) => events.push(`${name}@${i}`),
    onEnd: () => events.push('end'),
    onError: (e) => events.push(`error:${e}`),
    ...over,
  };
  return { r, events };
}

const words = [
  { start: 0, end: 4, t0: 0.1, t1: 0.4 },
  { start: 5, end: 8, t0: 0.4, t1: 0.7 },
  { start: 10, end: 14, t0: 0.9, t1: 1.2 },
];
const source = (fail = false): TtsSource & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    clip: async (text, lang, voice) => {
      calls.push(`${voice}|${lang}|${text}`);
      if (fail) throw new Error('server down');
      return { url: 'blob:x', words };
    },
  };
};

describe('M4: audio speech port', () => {
  test('plays with preserved pitch at the tempo; boundaries follow currentTime; end flushes the rest', async () => {
    const audio = new FakeAudio();
    const ticker = new FakeTicker();
    const src = source();
    const port = new AudioSpeechPort({ source: () => src, createAudio: () => audio, ticker });
    const { r, events } = request();
    port.speak(r);
    await flush();
    expect(src.calls).toEqual(['qwentts:vivian|de|Habe Mut, dich zu bedienen.']);
    expect(audio).toMatchObject({ src: 'blob:x', playbackRate: 1.5, preservesPitch: true });
    expect(events).toEqual(['start']);
    audio.currentTime = 0.45;
    ticker.tick();
    expect(events).toEqual(['start', 'word@0', 'word@5']);
    audio.onended?.();
    expect(events).toEqual(['start', 'word@0', 'word@5', 'word@10', 'end']);
    expect(ticker.fns.size).toBe(0);
  });

  test('cancel stops at once and silences late events', async () => {
    const audio = new FakeAudio();
    const port = new AudioSpeechPort({ source: () => source(), createAudio: () => audio, ticker: new FakeTicker() });
    const { r, events } = request();
    port.speak(r);
    port.cancel();
    await flush();
    expect(events).toEqual([]);
    port.speak(r);
    await flush();
    port.cancel();
    expect(audio.paused).toBe(true);
    audio.onended?.();
    expect(events).toEqual(['start']);
  });

  test('routing: TTS voices to audio, others to Web Speech; failed TTS falls back to a browser voice', async () => {
    const webCalls: UtteranceRequest[] = [];
    const web: SpeechPort = { speak: (r) => void webCalls.push(r), cancel: () => undefined };
    const fallbacks: string[] = [];
    const audio = new AudioSpeechPort({ source: () => source(true), createAudio: () => new FakeAudio(), ticker: new FakeTicker() });
    const port = new RoutingSpeechPort(web, audio, () => 'web-de', (e) => fallbacks.push(e));
    port.speak(request({ voiceURI: 'Microsoft Katja' }).r);
    expect(webCalls.map((c) => c.voiceURI)).toEqual(['Microsoft Katja']);
    port.speak(request().r);
    await flush();
    expect(fallbacks).toEqual(['tts']);
    expect(webCalls.map((c) => c.voiceURI)).toEqual(['Microsoft Katja', 'web-de']);
    // Without Web Speech the engine gets the error (and moves on as before).
    const lone = new RoutingSpeechPort(undefined, audio, () => undefined);
    const { r, events } = request();
    lone.speak(r);
    await flush();
    expect(events).toEqual(['error:tts']);
  });
});

describe('M4: TTS buffer', () => {
  const urls = { create: () => `blob:${Math.random()}`, revoke: () => undefined };

  test('prefetch loads the window in order; clip reuses it; a new window cancels the rest', async () => {
    const started: string[] = [];
    const aborted: string[] = [];
    const synth = (text: string, _l: string, _v: string, signal: AbortSignal) =>
      new Promise<{ audio: Blob; words: [] }>((resolve, reject) => {
        started.push(text);
        signal.addEventListener('abort', () => {
          aborted.push(text);
          reject(new DOMException('aborted', 'AbortError'));
        });
        setTimeout(() => resolve({ audio: new Blob(['x']), words: [] }), 10);
      });
    const b = new TtsBuffer(synth, 300, urls);
    b.prefetch(['a', 'b', 'c', 'd'].map((text) => ({ text, lang: 'de', voice: 'q:v' })));
    await flush();
    expect(started.slice(0, 2)).toEqual(['a', 'b']); // concurrency 2, in order
    b.prefetch(['x', 'y'].map((text) => ({ text, lang: 'de', voice: 'q:v' })));
    await new Promise((r) => setTimeout(r, 40));
    expect(aborted).toEqual(expect.arrayContaining(['a', 'b']));
    expect(started).not.toContain('c');
    const before = started.length;
    await b.clip('x', 'de', 'q:v');
    expect(started.length).toBe(before); // already loaded by prefetch
  });

  test('LRU evicts and revokes the oldest object URLs', async () => {
    const revoked: string[] = [];
    let n = 0;
    const b = new TtsBuffer(async () => ({ audio: new Blob(['x']), words: [] }), 2, { create: () => `u${++n}`, revoke: (u) => void revoked.push(u) });
    await b.clip('1', 'de', 'v');
    await b.clip('2', 'de', 'v');
    await b.clip('3', 'de', 'v');
    await flush();
    expect(revoked).toEqual(['u1']);
  });
});
