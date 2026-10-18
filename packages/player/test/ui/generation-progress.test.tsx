import { afterEach, describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { withDom } from '../../../../tests/support/with-dom.ts';
import { TtsBuffer, ttsStatus } from '../../src/ai/tts.ts';
import { BrowserBackend } from '../../src/ai/backends.ts';
import type { AiBackend, ImageResult } from '../../src/ai/backends.ts';
import { FakeLLM } from '@lesebuehne/core';
import { t } from '../../src/i18n/i18n.ts';
import { ttsBuffer, setBackend } from '../../src/ai/state.ts';
import { settings } from '../../src/app/store.ts';
import { defaultSettings } from '../../src/settings/settings.ts';
import { GenerationProgress, SectionGeneration } from '../../src/ui/reader/GenerationProgress.tsx';
import { AiIndicator } from '../../src/ui/reader/AiIndicator.tsx';
import { bundleOf, flush, makeEnv, openSession } from './support.ts';

describe('live generation progress', () => {
  withDom();
  afterEach(() => { setBackend(undefined); settings.value = defaultSettings(); ttsStatus.value = { state: 'idle', ahead: 0, limited: false }; });

  test('parallel sentence images keep separate timeline segments and the full section margin scale', async () => {
    settings.value = { ...defaultSettings(), visualKinds: 'images', imageInterval: 'sentence' };
    const session = await openSession(await makeEnv(), bundleOf('sentences.txt', new TextEncoder().encode('Ein Boot fährt. Ein Baum wächst. Ein Vogel singt. Ein Kind lacht.')));
    const requests: Array<{ resolve(r: ImageResult): void; reject(e: Error): void }> = [];
    const backend: AiBackend = { mode: 'server', plans: false,
      prepare: async () => { throw new Error('no text provider'); },
      plan: async () => { throw new Error('unused'); }, animate: async () => { throw new Error('unused'); },
      status: async () => ({ chain: [], providers: [], budget: { images: 2, animations: 3 } }),
      image: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    };
    session.attachAi(backend);
    const host = document.createElement('div'); document.body.appendChild(host);
    render(<><GenerationProgress session={session} /><SectionGeneration session={session} sectionId={session.order[0]!.id} /></>, host);
    const segments = (scope: string) => [...host.querySelectorAll<HTMLElement>(`${scope} .generation-kind-image`)];
    try {
      await flush();
      expect(segments('.generation-row.generation-stage')).toHaveLength(4);
      expect(segments('.generation-row.generation-stage').every(s => s.classList.contains('is-idle'))).toBe(true);
      session.ai!.tick(); await flush();
      expect(requests).toHaveLength(4);
      const ready = { url: 'image', providerId: 'fake', variants: 1, selected: 0 };
      // Later sentences complete first, with the same status on two neighbouring sentences.
      requests[2]!.resolve(ready); requests[3]!.resolve(ready);
      requests[1]!.reject(new Error('temporarily unavailable'));
      await flush();
      const horizontal = segments('.generation-row.generation-stage');
      const vertical = segments('.section-generation');
      expect(horizontal).toHaveLength(4);
      expect(vertical).toHaveLength(4);
      expect(session.generation.peek().stage.map(r => r.state)).toEqual(['working', 'error', 'ready', 'ready']);
      for (let i = 0; i < 4; i++) {
        const entry = session.timeline.entries[i]!;
        expect(horizontal[i]!.dataset.entryIndex).toBe(String(i));
        expect(horizontal[i]!.title).toContain(t('generation.sentence', { number: i + 1 }));
        expect(parseFloat(horizontal[i]!.style.left)).toBeCloseTo(entry.start / session.timeline.duration * 100);
        expect(parseFloat(vertical[i]!.style.top)).toBeCloseTo(entry.start / session.timeline.duration * 100);
        expect(parseFloat(vertical[i]!.style.height)).toBeCloseTo((entry.end - entry.start) / session.timeline.duration * 100);
      }
      requests[0]!.resolve(ready); await flush();
      expect(segments('.section-generation')).toHaveLength(4);
    } finally { render(null, host); session.dispose(); }
  });

  test('header separates voice and stage selection, status and settings links', async () => {
    settings.value = { ...defaultSettings(), layout: 'stage', visualKinds: 'images' };
    const session = await openSession(await makeEnv(), bundleOf('header.txt', new TextEncoder().encode('Ein kurzer Text für die Bühne.')));
    session.attachAi(new BrowserBackend([new FakeLLM({ answers: [] })]));
    const buffer = new TtsBuffer(() => new Promise(() => {}));
    ttsBuffer.value = buffer;
    session.setVoice({ voiceURI: 'tts:fake:s99', name: 'S99 · Deutscher Erzähler', lang: 'de', default: false, localService: true });
    const host = document.createElement('div'); document.body.appendChild(host);
    render(<AiIndicator session={session} />, host);
    try {
      session.stageGeneration.value = new Map([[session.order[0]!.id, 'working']]);
      ttsStatus.value = { ...ttsStatus.peek(), limited: true, lastError: 'speech only' };
      await flush();
      const speech = host.querySelector<HTMLButtonElement>('[data-generator="speech"]')!;
      const stage = host.querySelector<HTMLElement>('[data-generator="stage"]')!;
      expect(speech.textContent).toContain('S99 · Deutscher Erzähler');
      expect(speech.classList.contains('is-limited')).toBe(true);
      expect(stage.textContent).toContain(t('ai.visualKinds.images'));
      expect(stage.classList.contains('is-working')).toBe(true);
      expect(stage.title).not.toContain('speech only');
      speech.click();
      expect(session.settingsTab.value).toBe('reading');
      expect(session.panel.value).toBe('settings');
      stage.querySelector<HTMLButtonElement>('button')!.click();
      expect(session.settingsTab.value).toBe('stage');
      const kinds = stage.querySelector<HTMLSelectElement>('select')!;
      expect(kinds.value).toBe('images');
      kinds.value = 'animations';
      kinds.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
      expect(settings.peek().visualKinds).toBe('animations');
      session.setVoice({ voiceURI: 'browser:en', name: 'English Voice', lang: 'en', default: false, localService: true });
      await flush();
      expect(speech.textContent).toContain('English Voice');
      expect(speech.classList.contains('is-browser')).toBe(true);
      settings.value = { ...settings.peek(), layout: 'rsvp', rsvpSilent: true };
      await flush();
      expect(speech.classList.contains('is-paused')).toBe(true);
      expect(stage.classList.contains('is-paused')).toBe(true);
    } finally { render(null, host); session.dispose(); buffer.dispose(); }
  });

  test('timeline and text margins update without playback; partial audio, voice changes and clearing stay accurate', async () => {
    const env = await makeEnv();
    const session = await openSession(env, bundleOf('progress.txt', new TextEncoder().encode('Habe Mut beim Lesen. Die Welt ist voller Geschichten.')));
    const pending = new Map<string, (value: { audio: Blob; words: [] }) => void>();
    const buffer = new TtsBuffer((text) => new Promise((resolve) => pending.set(text, resolve)), 300, { create: () => 'blob:test', revoke: () => {} });
    buffer.setConcurrency(1);
    ttsBuffer.value = buffer;
    const voice = { voiceURI: 'tts:fake:one', name: 'One', lang: 'de', localService: false, default: false };
    session.setVoice(voice);
    const host = document.createElement('div'); document.body.appendChild(host);
    const sectionId = session.order[0]!.id;
    render(<><GenerationProgress session={session} /><SectionGeneration session={session} sectionId={sectionId} /></>, host);
    try {
      await flush();
      expect(session.engine.playing.value).toBe(false);
      expect(host.querySelectorAll('.generation-speech .is-working').length).toBeGreaterThan(0);
      expect(host.querySelectorAll('.generation-speech .is-queued').length).toBeGreaterThan(0);
      const [text, resolve] = [...pending.entries()][0]!;
      resolve({ audio: new Blob(['audio']), words: [] });
      await flush();
      const percent = Number(host.querySelector('.generation-row.generation-speech [role=progressbar]')!.getAttribute('aria-valuenow'));
      expect(percent).toBeGreaterThan(0);
      expect(percent).toBeLessThan(100);
      expect(host.querySelector('.section-generation .generation-speech .is-ready')).not.toBeNull();
      expect(buffer.stateOf(text, 'de', 'fake:one')).toBe('ready');
      session.attachAi(new BrowserBackend([new FakeLLM({ answers: [] })]));
      session.ai!.generationSpeed.value = 2.1;
      ttsStatus.value = { ...ttsStatus.peek(), generationSpeed: 1.5 };
      session.engine.setTempo(1);
      await flush();
      expect(host.querySelectorAll('.generation-pace-item.is-keepingUp')).toHaveLength(2);
      session.engine.setTempo(2);
      ttsStatus.value = { ...ttsStatus.peek(), generationSpeed: 1.5 };
      await flush();
      expect(host.querySelectorAll('.generation-pace-item.is-behind')).toHaveLength(1);
      expect(host.querySelectorAll('.generation-pace-item.is-tight')).toHaveLength(1);
      expect(host.querySelector('.generation-pace-item.is-behind')!.textContent).toContain('0.75×');
      expect(host.querySelector('.generation-pace-item.is-behind')!.textContent).toContain(t('generation.pace.behind'));
      // A naturally faster cloned voice also raises the stage's required production rate.
      ttsStatus.value = { ...ttsStatus.peek(), contentSpeed: 1.5 };
      await flush();
      expect(host.querySelectorAll('.generation-pace-item.is-behind')).toHaveLength(2);
      expect(host.querySelectorAll('.generation-pace-item')[1]!.textContent).toContain('0.70×');
      session.stageGeneration.value = new Map([[sectionId, 'working']]);
      await flush();
      expect(host.querySelector('.section-generation .generation-stage .is-working')).not.toBeNull();
      expect(host.querySelector('.generation-row.generation-stage .generation-segment')!.className).not.toContain('generation-kind-');
      session.plans.value = new Map(session.plans.peek()).set(sectionId, { ...session.plans.peek().get(sectionId)!, mode: 'animation', animation: { brief: 'A transfer' } });
      session.planInfo.value = new Map([[sectionId, { source: 'ai', variants: 1, selected: 0 }]]);
      await flush();
      expect(host.querySelector('.generation-row.generation-stage .generation-kind-animation.is-working')).not.toBeNull();
      expect(host.querySelector('.section-generation .generation-kind-animation.is-working')).not.toBeNull();
      expect(host.querySelector('.generation-kind-legend')!.textContent).toContain(t('generation.kind.animation'));
      session.stageGeneration.value = new Map([[sectionId, 'ready']]);
      await flush();
      expect(host.querySelector('.generation-row.generation-stage [role=progressbar]')!.getAttribute('aria-valuenow')).toBe('100');
      expect(host.querySelector('.generation-row.generation-stage .generation-kind-animation.is-ready')).not.toBeNull();
      session.plans.value = new Map(session.plans.peek()).set(sectionId, { ...session.plans.peek().get(sectionId)!, mode: 'image' });
      await flush();
      expect(host.querySelector('.generation-row.generation-stage .generation-kind-image.is-ready')).not.toBeNull();
      expect(host.querySelector('.generation-row.generation-speech [class*="generation-kind-"]')).toBeNull();
      session.setVoice({ ...voice, voiceURI: 'tts:fake:two' });
      await flush();
      expect(host.querySelector('.generation-row.generation-speech [role=progressbar]')!.getAttribute('aria-valuenow')).toBe('0');
      expect(host.querySelector('.generation-pace-item.is-behind')).toBeNull();
      buffer.dispose();
      await flush();
      expect(host.querySelector('.generation-speech .is-ready')).toBeNull();
    } finally { render(null, host); session.dispose(); buffer.dispose(); }
  });

  test('aborted and failed synthesis is never marked ready, including late responses', async () => {
    let resolve!: (value: { audio: Blob; words: [] }) => void;
    const buffer = new TtsBuffer(() => new Promise((r) => { resolve = r; }), 1, { create: () => 'blob:test', revoke: () => {} });
    const first = buffer.clip('first', 'de', 'v');
    await flush();
    buffer.prefetch([]);
    resolve({ audio: new Blob(['late']), words: [] });
    await expect(first).rejects.toThrow();
    await flush();
    expect(buffer.stateOf('first', 'de', 'v')).toBe('idle');
    buffer.dispose();
    const failed = new TtsBuffer(async () => { throw new Error('offline'); });
    await expect(failed.clip('fail', 'de', 'v')).rejects.toThrow('offline');
    expect(failed.stateOf('fail', 'de', 'v')).toBe('error');
    failed.dispose();
  });
});
