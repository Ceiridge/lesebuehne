import { primaryLanguage } from '@lesebuehne/core';
import type { ReaderSession } from '../../app/session.ts';
import { settings } from '../../app/store.ts';
import { matchingVoices, type VoiceInfo } from '../../engine/voices.ts';
import { fontStack } from '../../fonts/fonts.ts';
import { t, type MessageKey } from '../../i18n/i18n.ts';
import { FONT_IDS, LIMITS, type Settings } from '../../settings/settings.ts';
import { IconSpeaker } from '../icons.tsx';
import { setTempo } from './Controls.tsx';
import { Drawer } from './Panels.tsx';

function update(patch: Partial<Settings>): void {
  settings.value = { ...settings.value, ...patch };
}

function Segmented<K extends keyof Settings>({ field, options, label }: { field: K; options: ReadonlyArray<Settings[K]>; label: MessageKey }) {
  const value = settings.value[field];
  return (
    <div class="field">
      <span class="field-label" id={`seg-${String(field)}`}>
        {t(label)}
      </span>
      <div class="segmented" role="radiogroup" aria-labelledby={`seg-${String(field)}`}>
        {options.map((o) => (
          <button key={String(o)} type="button" role="radio" aria-checked={value === o} onClick={() => update({ [field]: o } as Partial<Settings>)}>
            {t(`${label}.${String(o)}` as MessageKey)}
          </button>
        ))}
      </div>
    </div>
  );
}

function Slider({ field, label, unit, format }: { field: 'fontSize' | 'lineHeight' | 'measure' | 'margins' | 'paragraphSpacing'; label: MessageKey; unit?: string; format?: (v: number) => string }) {
  const value = settings.value[field];
  const { min, max, step } = LIMITS[field];
  const id = `slider-${field}`;
  return (
    <div class="field">
      <label class="field-label" for={id}>
        {t(label)}
        <output for={id}>{format ? format(value) : `${value}${unit ?? ''}`}</output>
      </label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onInput={(e) => update({ [field]: Number(e.currentTarget.value) })} />
    </div>
  );
}

/** Settings panel (B8): every change applies live through CSS variables and signals. */
export function SettingsPanel({ session }: { session: ReaderSession }) {
  const s = settings.value;
  const lang = session.book.language;
  const matching = new Set(matchingVoices(session.voices, lang).map((v) => v.voiceURI));
  const voices = [...session.voices].sort(
    (a, b) => Number(matching.has(b.voiceURI)) - Number(matching.has(a.voiceURI)) || Number(b.localService) - Number(a.localService) || a.name.localeCompare(b.name),
  );
  const current = session.engine.currentVoice;

  const preview = (v: VoiceInfo): void => {
    const port = session.env.speech?.port;
    if (!port) return;
    session.engine.pause();
    port.cancel();
    port.speak({
      text: primaryLanguage(v.lang) === 'en' ? CATALOG_PREVIEW.en : CATALOG_PREVIEW.de,
      lang: v.lang,
      voiceURI: v.voiceURI,
      rate: s.tempo,
      onStart: () => undefined,
      onBoundary: () => undefined,
      onEnd: () => undefined,
      onError: () => undefined,
    });
  };

  return (
    <Drawer title={t('settings.title')} onClose={() => (session.panel.value = null)} wide>
      <p class="settings-preview" lang={lang === 'en' ? 'en' : 'de'}>
        {t('settings.sample')}
      </p>

      <h3 class="settings-group">{t('settings.appearance')}</h3>
      <div class="field">
        <span class="field-label" id="theme-label">
          {t('settings.theme')}
        </span>
        <div class="theme-swatches" role="radiogroup" aria-labelledby="theme-label">
          {(['system', 'light', 'sepia', 'dark'] as const).map((theme) => (
            <button key={theme} type="button" role="radio" aria-checked={s.theme === theme} class={`theme-swatch swatch-${theme}`} onClick={() => update({ theme })}>
              <span class="theme-swatch-sample" aria-hidden="true">
                Aa
              </span>
              <span>{t(`settings.theme.${theme}`)}</span>
            </button>
          ))}
        </div>
      </div>
      <div class="field">
        <span class="field-label" id="font-label">
          {t('settings.font')}
        </span>
        <div class="font-list" role="radiogroup" aria-labelledby="font-label">
          {FONT_IDS.map((font) => (
            <button key={font} type="button" role="radio" aria-checked={s.font === font} class="font-option" style={{ fontFamily: fontStack(font) }} onClick={() => update({ font })}>
              {t(`settings.font.${font}`)}
            </button>
          ))}
        </div>
      </div>
      <Slider field="fontSize" label="settings.fontSize" unit=" px" />
      <Slider field="lineHeight" label="settings.lineHeight" format={(v) => v.toFixed(2)} />
      <Slider field="measure" label="settings.measure" unit=" ch" />
      <Slider field="margins" label="settings.margins" unit=" px" />
      <Slider field="paragraphSpacing" label="settings.paragraphSpacing" format={(v) => `${v.toFixed(1)} em`} />
      <Segmented field="align" label="settings.align" options={['left', 'justify']} />
      <Segmented field="highlightStyle" label="settings.highlight" options={['background', 'underline']} />
      <Segmented field="dimming" label="settings.dimming" options={['off', 'light', 'strong']} />
      <Segmented field="motion" label="settings.motion" options={['full', 'reduced', 'none']} />

      <h3 class="settings-group" id="settings-voice">
        {t('settings.reading')}
      </h3>
      <div class="field">
        <span class="field-label">{t('settings.voice')}</span>
        {voices.length === 0 ? (
          <p class="empty">{t('settings.voiceNone')}</p>
        ) : (
          <ul class="voice-list" role="radiogroup" aria-label={t('settings.voice')}>
            {voices.map((v) => (
              <li key={v.voiceURI} class={matching.has(v.voiceURI) ? 'is-matching' : undefined}>
                <button type="button" role="radio" aria-checked={current?.voiceURI === v.voiceURI} class="voice" onClick={() => session.setVoice(v)}>
                  <span class="voice-name">{v.name}</span>
                  <span class="voice-meta">
                    {v.lang} · {v.localService ? t('settings.voiceLocal') : t('settings.voiceOnline')}
                    {matching.has(v.voiceURI) ? ` · ${t('settings.voiceMatching')}` : ''}
                  </span>
                </button>
                <button type="button" class="icon-btn small" aria-label={`${t('settings.voicePreview')}: ${v.name}`} onClick={() => preview(v)}>
                  <IconSpeaker size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div class="field">
        <label class="field-label" for="slider-tempo">
          {t('settings.tempo')}
          <output for="slider-tempo">{s.tempo.toFixed(2).replace(/0$/, '')}×</output>
        </label>
        <input id="slider-tempo" type="range" min={LIMITS.tempo.min} max={LIMITS.tempo.max} step={LIMITS.tempo.step} value={s.tempo} onInput={(e) => setTempo(session, Number(e.currentTarget.value))} />
      </div>
      <div class="field">
        <span class="field-label" id="fn-label">
          {t('settings.footnotes')}
        </span>
        <div class="segmented vertical" role="radiogroup" aria-labelledby="fn-label">
          {(['skip', 'inline', 'section-end'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={s.footnoteMode === m}
              onClick={() => {
                update({ footnoteMode: m });
                session.engine.setFootnoteMode(m);
              }}
            >
              {t(`settings.footnotes.${m}`)}
            </button>
          ))}
        </div>
      </div>

      <h3 class="settings-group">{t('settings.language')}</h3>
      <Segmented field="uiLanguage" label="settings.language" options={['auto', 'de', 'en']} />

      <button
        type="button"
        class="btn btn-ghost btn-block"
        onClick={() => {
          settings.value = session.env.settings.reset();
          session.engine.setTempo(settings.value.tempo);
          session.engine.setFootnoteMode(settings.value.footnoteMode);
        }}
      >
        {t('settings.reset')}
      </button>
    </Drawer>
  );
}

const CATALOG_PREVIEW = {
  de: 'Habe Mut, dich deines eigenen Verstandes zu bedienen.',
  en: 'Have the courage to use your own understanding.',
};
