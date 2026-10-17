import { afterEach, expect, test } from 'bun:test';
import { FakeLLM, MemoryCache, type TTSProvider } from '@lesebuehne/core';
import { BrowserBackend, browserMedia, detectBackend } from '../../src/ai/backends.ts';
import { AiPrefsSchema } from '../../src/ai/prefs.ts';
import { refreshDetails, setBackend, ttsBuffer } from '../../src/ai/state.ts';
import { settings } from '../../src/app/store.ts';
import { AudioSpeechPort, RoutingSpeechPort, type AudioLike } from '../../src/engine/audio-port.ts';
import { nextWord, rsvpWord, wordTokenAt } from '../../src/engine/rsvp.ts';
import { defaultSettings } from '../../src/settings/settings.ts';
import { bundleOf, makeEnv, openSession } from '../ui/support.ts';

const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); await Bun.sleep(5); };
const bundle = (text: string) => bundleOf('test.txt', new TextEncoder().encode(text));
afterEach(() => { settings.value = defaultSettings(); setBackend(undefined); });

test('changing tempo at the same position immediately expands the TTS window without restarting existing requests', async () => {
  const calls: string[] = [];
  const provider = voiceProvider(calls, 4);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const original = provider.synthesize;
  provider.synthesize = async (request) => { calls.push(request.text); await gate; return original(request); };
  setBackend(new BrowserBackend([], undefined, { tts: provider }));
  await refreshDetails();
  const env = await makeEnv();
  const session = await openSession(env, bundle(Array.from({ length: 100 }, (_, i) => `Dieser ausführliche Satz mit der Nummer ${i} beschreibt einen neuen Gedanken und lässt uns die Welt mit anderen Augen betrachten.`).join(' ')));
  try {
    await settle();
    const before = ttsBuffer.value!.generation.value.size;
    expect(before).toBeGreaterThan(4);
    expect(calls).toHaveLength(4);
    const position = session.engine.position.peek();
    session.engine.setTempo(2);
    await settle();
    expect(session.engine.position.peek()).toEqual(position);
    expect(ttsBuffer.value!.generation.value.size).toBeGreaterThan(before * 1.5);
    expect(calls).toHaveLength(4);
  } finally { session.dispose(); setBackend(undefined); release(); await settle(); }
});

test('RSVP preserves source symbols, including punctuation-only display units', async () => {
  const s = await openSession(await makeEnv(), bundle('−5 Grad. €50 sind teuer. Es gilt 2 + 2 = 4. A → B. (−3,5 %) ≠ +2.'));
  try {
    for (const [entryIndex, entry] of s.timeline.entries.entries()) {
      let p: { entryIndex: number; tokenIndex: number } | undefined = { entryIndex, tokenIndex: wordTokenAt(entry.sentence, 0)! };
      const display: string[] = [];
      while (p?.entryIndex === entryIndex) {
        const word = rsvpWord(entry.sentence, p.tokenIndex)!;
        display.push(word.before + word.pivot + word.after);
        p = nextWord(s.timeline, p);
      }
      expect(display.join('').replace(/\s/gu, '')).toBe(entry.sentence.text.replace(/\s/gu, ''));
    }
  } finally { s.dispose(); }
});

test('a running RSVP navigation gives the destination its full word delay', async () => {
  settings.value = { ...defaultSettings(), layout: 'rsvp', rsvpWpm: 300 };
  const t = await makeEnv();
  const s = await openSession(t, bundle('Habe Mut. Jeder Satz zählt.'));
  try {
    s.togglePlay();
    t.timers.advance(199);
    s.navigate({ entryIndex: 1, tokenIndex: 0 });
    t.timers.advance(199);
    expect(s.engine.position.value).toEqual({ entryIndex: 1, tokenIndex: 0 });
    t.timers.advance(1);
    expect(rsvpWord(s.timeline.entries[1]!.sentence, s.engine.position.value.tokenIndex)?.pivot).toBe('a');
  } finally { s.dispose(); }
});

function voiceProvider(calls: string[], concurrency = 8): TTSProvider {
  return {
    id: 'local', kind: 'tts', label: 'Local', runsIn: ['browser'], capabilities: {}, limits: { concurrency },
    voices: [{ id: 's99', name: 'S99', languages: ['de', 'en'] }],
    isAvailable: async () => ({ ok: true }),
    synthesize: async ({ text }) => {
      calls.push(text);
      return { audio: new Uint8Array([1, 2, 3]), mime: 'audio/wav', words: [...text.matchAll(/\S+/gu)].map((m, i) => ({ start: m.index!, end: m.index! + m[0].length, t0: i, t1: i + 0.8 })) };
    },
  };
}

test('pause, seek and tempo changes reuse canonical generated audio with aligned resume and live volume', async () => {
  const calls: string[] = [];
  setBackend(new BrowserBackend([], new MemoryCache(), { tts: voiceProvider(calls) }));
  await refreshDetails();
  const audios: Array<AudioLike & { volume: number }> = [];
  const ticks = new Set<() => void>();
  const audio = new AudioSpeechPort({ source: () => ttsBuffer.value, ticker: { every: (_ms, fn) => { ticks.add(fn); return () => void ticks.delete(fn); } }, createAudio: () => {
    const a: AudioLike & { volume: number } = { src: '', playbackRate: 1, preservesPitch: false, currentTime: 0, volume: 1, onplaying: null, onended: null, onerror: null, play: async () => { a.onplaying?.(); }, pause: () => {} };
    audios.push(a); return a;
  } });
  const t = await makeEnv();
  t.env.speech = { voices: async () => [], port: new RoutingSpeechPort(undefined, audio, () => undefined) };
  const s = await openSession(t, bundle('Habe Mut und vertraue deinem eigenen Verstand beim Lesen dieser langen Geschichte.'));
  try {
    await settle();
    const generated = calls.length;
    expect(generated).toBeGreaterThan(0);
    s.togglePlay(); await settle();
    audios.at(-1)!.currentTime = 3;
    for (const tick of ticks) tick();
    const atPause = s.engine.position.value;
    expect(atPause.tokenIndex).toBeGreaterThan(0);
    s.togglePlay(); s.togglePlay(); await settle();
    expect(audios.at(-1)!.currentTime).toBe(3);
    expect(s.engine.position.value).toEqual(atPause);
    s.engine.setTempo(2); await settle();
    expect(audios.at(-1)!.playbackRate).toBe(2);
    settings.value = { ...settings.value, volume: 0.37 };
    expect(audios.at(-1)!.volume).toBe(0.37);
    s.navigate({ entryIndex: 0, tokenIndex: 2 }); await settle();
    expect(calls).toHaveLength(generated);
    expect(new Set(calls).size).toBe(calls.length);
  } finally { s.dispose(); }
});

test('silent RSVP never prefetches generated speech and resumes prefetch when voice mode returns', async () => {
  const calls: string[] = [];
  settings.value = { ...defaultSettings(), layout: 'rsvp', rsvpSilent: true, rsvpWpm: 900 };
  setBackend(new BrowserBackend([], undefined, { tts: voiceProvider(calls) }));
  await refreshDetails();
  const t = await makeEnv();
  const s = await openSession(t, bundle(Array.from({ length: 40 }, (_, i) => `Dieser Satz hat die Nummer ${i}.`).join(' ')));
  try {
    await settle();
    s.togglePlay(); t.timers.advance(5000); await settle();
    expect(calls).toHaveLength(0);
    settings.value = { ...settings.value, rsvpSilent: false };
    await settle();
    expect(calls.length).toBeGreaterThan(0);
    expect(s.rsvp.running.value).toBe(false);
  } finally { s.dispose(); }
});

test('provider concurrency reaches the playback buffer through backend status', async () => {
  const calls: string[] = [];
  const p = voiceProvider(calls, 8);
  const original = p.synthesize;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  p.synthesize = async (r) => { calls.push(r.text); await gate; return original(r); };
  setBackend(new BrowserBackend([], undefined, { tts: p }));
  await refreshDetails();
  ttsBuffer.value!.prefetch(Array.from({ length: 8 }, (_, i) => ({ text: `Satz ${i}`, lang: 'de', voice: 'local:s99' })));
  await settle();
  expect(calls).toHaveLength(8);
  release(); await settle();
});

test('a newly available multilingual voice becomes selectable without reopening the book', async () => {
  settings.value = { ...defaultSettings(), layout: 'rsvp' };
  const t = await makeEnv();
  const s = await openSession(t, bundle('Habe Mut beim Lesen.'));
  try {
    expect(s.engine.silent).toBe(true);
    s.togglePlay();
    expect(s.rsvp.running.value).toBe(true);
    setBackend(new BrowserBackend([], undefined, { tts: voiceProvider([]) }));
    await refreshDetails(); await s.refreshVoices();
    expect(s.voices.map((v) => v.name)).toContain('S99 (local)');
    expect(s.engine.silent).toBe(false);
    expect(s.rsvp.running.value).toBe(false);
    s.togglePlay();
    expect(s.engine.playing.value).toBe(true);
  } finally { s.dispose(); }
});

test('legacy compatible voices keep two slots; explicit provider source does not silently fall back', async () => {
  const compatible = AiPrefsSchema.parse({ voice: { enabled: true, baseURL: 'http://local/v1', voices: 'v' } });
  const qwen = AiPrefsSchema.parse({ voice: { preset: 'qwentts' } });
  expect(browserMedia(compatible, async () => new Response('')).tts?.limits?.concurrency).toBe(2);
  expect(qwen.voice.parallel).toBe(1);
  let serverCalls = 0;
  const http = async () => { serverCalls++; return new Response('', { status: 404 }); };
  expect((await detectBackend({ prefs: { ...compatible, connection: 'browser' }, http, baseURI: 'http://local/' }))?.mode).toBe('browser');
  expect(serverCalls).toBe(0);
  expect(await detectBackend({ prefs: { ...compatible, connection: 'server' }, http, baseURI: 'http://local/' })).toBeUndefined();
});

test('images-only cannot restore a missing image provider, even on a cached request', async () => {
  const b = bundle('Habe Mut, dich deines eigenen Verstandes zu bedienen und die Welt immer neu zu betrachten.').book;
  const fake = new FakeLLM({ id: 'text', answers: [JSON.stringify({ mode: 'image', rationale: 'picture', keyTerms: ['Mut'], cues: [], diagram: null, quote: null, image: { prompt: 'A quiet study with many books', aspect: '16:9', focusRegions: [] }, animation: null, fallback: 'none' })] });
  const backend = new BrowserBackend([fake]);
  for (let i = 0; i < 2; i++) {
    const r = await backend.plan(b, b.chapters[0]!.sections[0]!.id, { prefer: 'images' }, new AbortController().signal);
    expect(r.plan.mode).not.toBe('image');
    expect(r.fallback).toBe(false);
  }
  expect(fake.requests).toHaveLength(1);
});
