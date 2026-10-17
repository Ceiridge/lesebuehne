import { describe, expect, test } from 'bun:test';
import { CATALOGS, defaultUiLanguage, t } from '../src/i18n/i18n.ts';
import { mapKey, type KeyContext } from '../src/input/keymap.ts';
import { defaultSettings, SETTINGS_KEY, SettingsStore, type KeyValueStore } from '../src/settings/settings.ts';
import { contrast, contrastPairs, DURATIONS, THEMES } from '../src/theme/tokens.ts';

class FakeKv implements KeyValueStore {
  data = new Map<string, string>();
  get(k: string) {
    return this.data.get(k) ?? null;
  }
  set(k: string, v: string) {
    this.data.set(k, v);
  }
}

describe('11-1: settings', () => {
  test('defaults', () => {
    const d = defaultSettings();
    expect(d).toMatchObject({
      theme: 'system',
      font: 'literata',
      motion: 'full',
      tempo: 1,
      footnoteMode: 'skip',
      uiLanguage: 'auto',
      voiceByLang: {},
      highlightStyle: 'background',
      dimming: 'light',
      align: 'left',
      dismissedHints: [],
    });
    expect(defaultSettings(true).motion).toBe('reduced');
    expect(d.fontSize).toBeGreaterThanOrEqual(14);
    expect(d.fontSize).toBeLessThanOrEqual(32);
  });
  test('round trip, invalid JSON and invalid fields fall back, reset', () => {
    const kv = new FakeKv();
    const store = new SettingsStore(kv);
    expect(store.load()).toEqual(defaultSettings());
    const s = { ...store.load(), theme: 'sepia' as const, tempo: 1.75, voiceByLang: { de: 'hedda' }, fontSize: 24, dismissedHints: ['v'] };
    store.save(s);
    expect(store.load()).toEqual(s);
    kv.set(SETTINGS_KEY, '{not json');
    expect(store.load()).toEqual(defaultSettings());
    kv.set(SETTINGS_KEY, JSON.stringify({ theme: 'neon', tempo: 1.3, fontSize: 99, lineHeight: 1.2, measure: 90, font: 'atkinson' }));
    expect(store.load()).toMatchObject({ theme: 'system', tempo: 1, fontSize: 20, lineHeight: 1.2, measure: 90, font: 'atkinson' });
    kv.set(SETTINGS_KEY, '42');
    expect(store.load()).toEqual(defaultSettings());
    expect(store.reset()).toEqual(defaultSettings());
    expect(JSON.parse(kv.get(SETTINGS_KEY) ?? '')).toEqual(defaultSettings());
  });
});

describe('11-2: i18n', () => {
  test('identical key sets, no empty values', () => {
    expect(Object.keys(CATALOGS.de).sort()).toEqual(Object.keys(CATALOGS.en).sort());
    for (const catalog of Object.values(CATALOGS)) for (const v of Object.values(catalog)) expect(v.trim()).not.toBe('');
  });
  test('placeholders and default language rule', () => {
    expect(t('reader.tempo', { tempo: 1.5 }, 'de')).toBe('Tempo 1.5×');
    expect(t('notice.noVoice', { language: 'Englisch', voice: 'Hedda' }, 'de')).toBe('Keine Stimme für Englisch installiert – es wird Hedda verwendet');
    expect(defaultUiLanguage(['de-AT', 'en'])).toBe('de');
    expect(defaultUiLanguage(['fr', 'de'])).toBe('en');
    expect(defaultUiLanguage([])).toBe('en');
    expect(defaultUiLanguage(undefined)).toBe('en');
  });
});

describe('11-3: contrast', () => {
  for (const [name, colors] of Object.entries(THEMES)) {
    test(name, () => {
      const failures = contrastPairs(colors)
        .map((p) => ({ ...p, ratio: contrast(p.fg, p.bg) }))
        .filter((p) => p.ratio < p.min)
        .map((p) => `${p.name}: ${p.ratio.toFixed(2)} < ${p.min}`);
      expect(failures).toEqual([]);
    });
  }
  test('contrast function', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#777777')).toBe(1);
  });
});

describe('11-4: duration tokens', () => {
  test('150–300 ms for full and reduced, 0 for none', () => {
    for (const level of ['full', 'reduced'] as const) {
      for (const ms of Object.values(DURATIONS[level])) {
        expect(ms).toBeGreaterThanOrEqual(150);
        expect(ms).toBeLessThanOrEqual(300);
      }
    }
    expect(Object.values(DURATIONS.none)).toEqual([0, 0, 0]);
  });
});

describe('11-5: key mapping', () => {
  const other: KeyContext = { focus: 'other', modalOpen: false };
  const rows: Array<[Parameters<typeof mapKey>[0], KeyContext, string | null]> = [
    [{ key: ' ' }, other, 'toggle-play'],
    [{ key: 'ArrowLeft' }, other, 'prev-sentence'],
    [{ key: 'ArrowRight' }, other, 'next-sentence'],
    [{ key: 'ArrowLeft', shiftKey: true }, other, 'prev-section'],
    [{ key: 'ArrowRight', shiftKey: true }, other, 'next-section'],
    [{ key: 'ArrowUp' }, other, 'prev-paragraph'],
    [{ key: 'ArrowDown' }, other, 'next-paragraph'],
    [{ key: 'k' }, other, 'prev-paragraph'],
    [{ key: 'J', shiftKey: true }, other, 'next-paragraph'],
    [{ key: '[' }, other, 'tempo-down'],
    [{ key: ']' }, other, 'tempo-up'],
    [{ key: '-' }, other, 'tempo-down'],
    [{ key: '+', shiftKey: true }, other, 'tempo-up'],
    // QWERTZ: AltGr = Ctrl+Alt producing [ ]
    [{ key: '[', ctrlKey: true, altKey: true }, other, 'tempo-down'],
    [{ key: ']', ctrlKey: true, altKey: true }, other, 'tempo-up'],
    [{ key: '?', shiftKey: true }, other, 'open-help'],
    [{ key: 'v' }, other, 'cycle-visual'],
    [{ key: 'V', shiftKey: true }, other, 'cycle-visual'],
    [{ key: 't' }, other, 'toggle-text-mode'],
    [{ key: 'S', shiftKey: true }, other, 'toggle-subtitles'],
    [{ key: 'm' }, other, 'open-toc'],
    [{ key: 'b' }, other, 'toggle-bookmark'],
    [{ key: 'd' }, other, 'toggle-debug'],
    [{ key: 'Escape' }, other, 'close'],
    // modifiers keep browser shortcuts
    [{ key: 'b', ctrlKey: true }, other, null],
    [{ key: 'ArrowLeft', altKey: true }, other, null],
    [{ key: 'd', metaKey: true }, other, null],
    [{ key: 'x' }, other, null],
    [{ key: 'F5' }, other, null],
    // focus rules
    [{ key: ' ' }, { focus: 'text-input', modalOpen: false }, null],
    [{ key: 'v' }, { focus: 'text-input', modalOpen: false }, null],
    [{ key: 'Escape' }, { focus: 'text-input', modalOpen: true }, null],
    [{ key: ' ' }, { focus: 'button', modalOpen: false }, null],
    [{ key: ' ' }, { focus: 'link', modalOpen: false }, null],
    [{ key: 'Enter' }, { focus: 'button', modalOpen: false }, null],
    [{ key: 'v' }, { focus: 'button', modalOpen: false }, 'cycle-visual'],
    [{ key: 'ArrowLeft' }, { focus: 'slider', modalOpen: false }, null],
    [{ key: 'ArrowUp' }, { focus: 'slider', modalOpen: false }, null],
    [{ key: ' ' }, { focus: 'slider', modalOpen: false }, 'toggle-play'],
    // modal open: only Esc
    [{ key: 'Escape' }, { focus: 'other', modalOpen: true }, 'close'],
    [{ key: ' ' }, { focus: 'other', modalOpen: true }, null],
    [{ key: 'ArrowRight' }, { focus: 'other', modalOpen: true }, null],
    [{ key: '?' }, { focus: 'other', modalOpen: true }, null],
  ];
  for (const [e, ctx, expected] of rows) {
    test(`${JSON.stringify(e)} ${ctx.focus}${ctx.modalOpen ? ' modal' : ''} → ${expected}`, () => {
      expect(mapKey(e, ctx)).toBe(expected as never);
    });
  }
});
