import { describe, expect, test } from 'bun:test';
import { TtsBuffer, ttsStatus } from '../../src/ai/tts.ts';
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

  test('streaming: plays the live URL at once with estimated words, then switches to the aligned timings', async () => {
    const audio = new FakeAudio();
    const ticker = new FakeTicker();
    let deliver!: (c: { url: string; words: typeof words }) => void;
    const src: TtsSource = {
      clip: () => new Promise((r) => (deliver = r)),
      live: () => ({ url: 'http://127.0.0.1/api/tts/stream?x', seconds: 2 }),
    };
    const port = new AudioSpeechPort({ source: () => src, createAudio: () => audio, ticker });
    const { r, events } = request();
    port.speak(r);
    await flush();
    expect(audio.src).toBe('http://127.0.0.1/api/tts/stream?x');
    expect(events).toEqual(['start']);
    audio.currentTime = 0.2;
    ticker.tick();
    expect(events).toEqual(['start', 'word@0']);
    deliver({ url: 'blob:x', words });
    await flush();
    audio.currentTime = 0.45;
    ticker.tick();
    expect(events).toEqual(['start', 'word@0', 'word@5']);
    port.cancel();
    expect(audio.src).toBe('');
  });

  test('streaming waits until generation will outrun playback, judged from buffer growth', async () => {
    let loaded = 0;
    let now = 0;
    const audio = Object.assign(new FakeAudio(), { buffered: { get length() { return loaded ? 1 : 0; }, end: () => loaded } });
    const ticker = new FakeTicker();
    const src: TtsSource = { clip: () => new Promise(() => undefined), live: () => ({ url: 'stream', seconds: 10 }) };
    const port = new AudioSpeechPort({ source: () => src, createAudio: () => audio, ticker, now: () => now });
    port.speak(request({ rate: 1 }).r);
    await flush();
    // Half real time: 1 s of audio per 2 s; the element stops loading at 2 s (paused preload).
    for (const [t, l] of [[2000, 1], [3000, 1.5], [4000, 2], [5000, 2], [8000, 2]] as const) {
      now = t;
      loaded = l;
      ticker.tick();
      expect(audio.paused).toBe(true);
    }
    // Extrapolated: 5.5 s generated at t = 11 s; the remaining 4.5 s take 9 s < 10 s of playback.
    now = 11000;
    ticker.tick();
    expect(audio.paused).toBe(false);
  });

  test('streaming is skipped when resuming inside a chunk', async () => {
    const audio = new FakeAudio();
    const src = { ...source(), live: () => ({ url: 'stream', seconds: 2 }) };
    const port = new AudioSpeechPort({ source: () => src, createAudio: () => audio, ticker: new FakeTicker() });
    port.speak(request({ startOffset: 5 }).r);
    await flush();
    expect(audio.src).toBe('blob:x');
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

  test('generation throughput counts overlapping wall time once and excludes cached clips', async () => {
    let now = 0;
    const releases: Array<() => void> = [];
    const buffer = new TtsBuffer(async (text) => {
      await new Promise<void>((r) => releases.push(r));
      return { audio: new Blob(['x']), words: [{ start: 0, end: 1, t0: 0, t1: text === 'cache' ? 100 : 4 }], cached: text === 'cache' };
    }, 300, urls, () => now);
    buffer.prefetch(['a', 'b', 'c', 'd'].map((text) => ({ text, lang: 'de', voice: 'v' })));
    await flush();
    now = 2000;
    releases.splice(0).forEach((r) => r());
    await flush();
    expect(ttsStatus.value.generationSpeed).toBe(8); // 16 seconds of audio / 2 seconds wall time
    expect(ttsStatus.value.aheadSeconds).toBe(12);
    expect(ttsStatus.value.contentSpeed).toBeCloseTo((4 / 14) / 16, 8);
    const hit = buffer.clip('cache', 'de', 'v');
    await flush();
    now = 2010;
    releases.splice(0).forEach((r) => r());
    await hit;
    expect(ttsStatus.value.generationSpeed).toBe(8);
    buffer.dispose();
    expect(ttsStatus.value.generationSpeed).toBeUndefined();
    expect(ttsStatus.value.aheadSeconds).toBe(0);
    expect(ttsStatus.value.contentSpeed).toBeUndefined();
  });

  test('jumping away and back does not reuse the rejected in-flight promise', async () => {
    const pending: Array<{ text: string; resolve: (v: { audio: Blob; words: [] }) => void }> = [];
    const buffer = new TtsBuffer((text) => new Promise((resolve) => pending.push({ text, resolve })), 300, urls);
    const item = { text: 'first', lang: 'de', voice: 'v' };
    buffer.prefetch([item]); await flush();
    buffer.prefetch([]);
    buffer.prefetch([item]);
    const clip = buffer.clip(item.text, item.lang, item.voice);
    await flush();
    expect(pending).toHaveLength(2);
    pending[0]!.resolve({ audio: new Blob(['old']), words: [] });
    pending[1]!.resolve({ audio: new Blob(['new']), words: [] });
    expect((await clip).url).toStartWith('blob:');
    expect(buffer.stateOf(item.text, item.lang, item.voice)).toBe('ready');
    buffer.dispose();
  });

  test('reordered lookahead serves the nearest clip next, even when old priorities were lower', async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const buffer = new TtsBuffer(async (text) => {
      started.push(text);
      await new Promise<void>((r) => releases.push(r));
      return { audio: new Blob(['audio']), words: [] };
    }, 300, urls);
    buffer.setConcurrency(1);
    const items = (texts: string[]) => texts.map((text) => ({ text, lang: 'en', voice: 'v' }));
    buffer.prefetch(items(['current', 'farther', 'nearer'])); await flush();
    buffer.prefetch(items(['current', 'nearer', 'farther']));
    releases.shift()!(); await flush();
    expect(started).toEqual(['current', 'nearer']);
    buffer.dispose();
    releases.forEach((r) => r());
  });

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
    b.prefetch(['a', 'b', 'c', 'd', 'e', 'f'].map((text) => ({ text, lang: 'de', voice: 'q:v' })));
    await flush();
    expect(started).toEqual(['a', 'b', 'c', 'd']); // concurrency 4 (batching servers), in order
    b.prefetch(['x', 'y'].map((text) => ({ text, lang: 'de', voice: 'q:v' })));
    await new Promise((r) => setTimeout(r, 40));
    expect(aborted).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd']));
    expect(started).not.toContain('e');
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
