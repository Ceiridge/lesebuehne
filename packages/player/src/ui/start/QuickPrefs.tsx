import { settings } from '../../app/store.ts';
import { t } from '../../i18n/i18n.ts';
import type { Settings } from '../../settings/settings.ts';

const THEMES: Settings['theme'][] = ['system', 'light', 'sepia', 'dark'];

/** Theme and UI-language switch in the start page header. */
export function QuickPrefs() {
  const s = settings.value;
  return (
    <div class="quick-prefs">
      <div class="segmented" role="radiogroup" aria-label={t('settings.theme')}>
        {THEMES.map((theme) => (
          <button
            key={theme}
            type="button"
            role="radio"
            aria-checked={s.theme === theme}
            class={`swatch swatch-${theme}`}
            title={t(`settings.theme.${theme}`)}
            aria-label={t(`settings.theme.${theme}`)}
            onClick={() => (settings.value = { ...settings.value, theme })}
          />
        ))}
      </div>
      <label class="select-inline">
        <span class="visually-hidden">{t('settings.language')}</span>
        <select
          value={s.uiLanguage}
          aria-label={t('settings.language')}
          onChange={(e) => (settings.value = { ...settings.value, uiLanguage: e.currentTarget.value as Settings['uiLanguage'] })}
        >
          <option value="auto">{t('settings.language.auto')}</option>
          <option value="de">{t('settings.language.de')}</option>
          <option value="en">{t('settings.language.en')}</option>
        </select>
      </label>
    </div>
  );
}
