import { afterEach, describe, expect, test } from 'bun:test';
import { FakeLLM } from '@lesebuehne/core';
import { render } from 'preact';
import { withDom } from '../../../../tests/support/with-dom.ts';
import { EnvContext } from '../../src/app/env.ts';
import { settings } from '../../src/app/store.ts';
import { aiDraft, aiPrefs } from '../../src/ai/connect.ts';
import { BrowserBackend } from '../../src/ai/backends.ts';
import { AiPrefsSchema } from '../../src/ai/prefs.ts';
import { aiBackend, setBackend } from '../../src/ai/state.ts';
import { defaultSettings } from '../../src/settings/settings.ts';
import { SettingsPanel } from '../../src/ui/reader/SettingsPanel.tsx';
import { t } from '../../src/i18n/i18n.ts';
import { bundleOf, flush, makeEnv, openSession } from './support.ts';

describe('settings workspace', () => {
  withDom();
  afterEach(() => { settings.value = defaultSettings(); aiDraft.value = undefined; aiPrefs.value = undefined; setBackend(undefined); });

  test('provider edits stay in a draft; task tabs have keyboard navigation and one visible panel', async () => {
    const env = await makeEnv();
    let requests = 0;
    env.env.http = async () => { requests++; return new Response('', { status: 404 }); };
    aiPrefs.value = AiPrefsSchema.parse({});
    const session = await openSession(env, bundleOf('a.txt', new TextEncoder().encode('Habe Mut beim Lesen.')));
    const host = document.createElement('div'); document.body.appendChild(host);
    render(<EnvContext.Provider value={env.env}><SettingsPanel session={session} /></EnvContext.Provider>, host);
    try {
      await flush();
      expect(host.querySelectorAll('[role="tabpanel"]:not([hidden])')).toHaveLength(1);
      expect(host.querySelector('[role="tabpanel"]:not([hidden])')?.id).toBe('settings-panel-reading');
      expect(host.querySelector('#settings-panel-reading #reading-layout')).toBeNull();
      expect(host.querySelector('#settings-panel-stage #reading-layout')).not.toBeNull();
      expect(host.querySelector('#settings-panel-stage #ai-kinds-label')).not.toBeNull();
      expect(host.querySelector('#settings-panel-ai #ai-kinds-label')).toBeNull();
      const tab = host.querySelector('#settings-tab-reading')!;
      tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await flush();
      expect(session.settingsTab.value).toBe('appearance');
      host.querySelector('#settings-tab-appearance')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await flush();
      expect(session.settingsTab.value).toBe('stage');
      const imageChoice = host.querySelectorAll<HTMLButtonElement>('#settings-panel-stage [aria-labelledby="ai-kinds-label"] button')[1]!;
      imageChoice.click(); await flush();
      expect(settings.value.visualKinds).toBe('images');
      expect(aiDraft.value).toBeUndefined();
      const input = host.querySelector('#ai-server-url') as HTMLInputElement;
      input.value = 'http://127.0.0.1:9191'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
      expect(aiDraft.value?.serverUrl).toBe('http://127.0.0.1:9191');
      expect(aiPrefs.value?.serverUrl).toBe('');
      expect(aiBackend.value).toBeUndefined();
      expect(requests).toBe(0);
      expect(host.textContent).toContain(t('ai.unsaved'));
    } finally { render(null, host); session.dispose(); }
  });

  test('reset starts fresh planning under the mixed preference', async () => {
    settings.value = { ...defaultSettings(), visualKinds: 'images' };
    const model = new FakeLLM({ answers: [JSON.stringify({ mode: 'kinetic', rationale: 'terms', keyTerms: ['Mut'], cues: [], diagram: null, quote: null, image: null, animation: null, fallback: 'none' })] });
    const backend = new BrowserBackend([model]);
    // Style is optional. Keep the test focused on real section planning and cache keys.
    backend.prepare = async () => { throw new Error('no style'); };
    setBackend(backend);
    const env = await makeEnv();
    const session = await openSession(env, bundleOf('a.txt', new TextEncoder().encode('Habe Mut, dich deines eigenen Verstandes zu bedienen und die Welt immer neu zu betrachten.')));
    const host = document.createElement('div'); document.body.appendChild(host);
    render(<EnvContext.Provider value={env.env}><SettingsPanel session={session} /></EnvContext.Provider>, host);
    try {
      const section = session.order[0]!.id;
      session.ai!.schedule(section); await flush();
      expect(model.requests).toHaveLength(1);
      const reset = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === t('settings.reset'))!;
      reset.click(); await flush();
      expect(settings.value.visualKinds).toBe('mixed');
      session.ai!.schedule(section); await flush();
      expect(model.requests).toHaveLength(2);
    } finally { render(null, host); session.dispose(); }
  });
});
