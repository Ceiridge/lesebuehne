import type { ReaderSession } from '../../app/session.ts';
import { settings, toast } from '../../app/store.ts';
import { t } from '../../i18n/i18n.ts';
import { LIMITS, type Settings } from '../../settings/settings.ts';

const update = (patch: Partial<Settings>) => { settings.value = { ...settings.value, ...patch }; };

/** Everything that changes the stage lives here, independently of provider credentials. */
export function StageSettings({ session }: { session: ReaderSession }) {
  const s = settings.value;
  return <>
    <header class="settings-intro"><h3>{t('settings.tab.stage')}</h3><p>{t('settings.stageHint')}</p></header>
    {!session.stageVisible ? <p class="field-hint">{t('generation.hiddenStage')}</p> : null}
    <div class="field">
      <label class="field-label" for="reading-layout">{t('reader.layout')}</label>
      <select id="reading-layout" value={s.layout} onChange={(e) => update({ layout: e.currentTarget.value as Settings['layout'] })}>
        {(['stage', 'cinema', 'sentence', 'rsvp', 'page', 'focus'] as const).map((layout) => <option key={layout} value={layout}>{t(`reader.layout.${layout}`)}</option>)}
      </select>
    </div>
    <div class="field">
      <span class="field-label" id="ai-kinds-label">{t('ai.visualKinds')}</span>
      <div class="segmented" role="radiogroup" aria-labelledby="ai-kinds-label">
        {(['mixed', 'images', 'animations'] as const).map((kind) => <button key={kind} type="button" role="radio" aria-checked={s.visualKinds === kind} onClick={() => update({ visualKinds: kind })}>{t(`ai.visualKinds.${kind}`)}</button>)}
      </div>
      <p class="field-hint">{t(s.visualKinds === 'mixed' ? 'ai.visualKindsMixedHint' : 'ai.visualKindsHint')}</p>
    </div>
    <fieldset class="settings-task-group"><legend>{t('reader.subtitles')}</legend>
      <label class="check"><input type="checkbox" checked={s.layout === 'cinema' || s.subtitles} disabled={s.layout === 'cinema'} onChange={(e) => update({ subtitles: e.currentTarget.checked })} />{t('reader.subtitlesOn')}</label>
      <div class="segmented" role="radiogroup" aria-label={t('settings.subtitleStyle')}>
        {(['line', 'word'] as const).map((style) => <button key={style} type="button" role="radio" aria-checked={s.subtitleStyle === style} onClick={() => update({ subtitleStyle: style })}>{t(`settings.subtitleStyle.${style}`)}</button>)}
      </div>
    </fieldset>
    <div class="field"><span class="field-label" id="stage-motion-label">{t('settings.motion')}</span>
      <div class="segmented" role="radiogroup" aria-labelledby="stage-motion-label">{(['full', 'reduced', 'none'] as const).map((motion) => <button key={motion} type="button" role="radio" aria-checked={s.motion === motion} onClick={() => update({ motion })}>{t(`settings.motion.${motion}`)}</button>)}</div>
    </div>
    <details class="settings-fold" open={s.layout === 'rsvp'}><summary>{t('settings.rsvpDetails')}</summary><div class="fold-body">
      <div class="field"><label class="field-label" for="slider-rsvp">{t('settings.rsvpWpm')}<output for="slider-rsvp">{t('reader.wpm', { wpm: s.rsvpWpm })}</output></label>
        <input id="slider-rsvp" type="range" min={LIMITS.rsvpWpm.min} max={LIMITS.rsvpWpm.max} step={LIMITS.rsvpWpm.step} value={s.rsvpWpm} onInput={(e) => update({ rsvpWpm: Number(e.currentTarget.value) })} />
        <label class="check"><input type="checkbox" checked={s.rsvpSilent} onChange={(e) => update({ rsvpSilent: e.currentTarget.checked })} />{t('settings.rsvpSilent')}</label>
        <p class="field-hint">{t('settings.rsvpHint')}</p>
      </div>
    </div></details>
    {session.ai ? <details class="settings-fold"><summary>{t('ai.bookStyle')}</summary><div class="fold-body">
      <button type="button" class="btn btn-ghost btn-block" disabled={!session.stageVisible} onClick={() => { toast(t('ai.regeneratingStyle'), 'info', 2400); void session.ai?.regenerateStyle(); }}>{t('ai.regenerateStyle')}</button>
      {session.styleBible.value ? <p class="field-hint">{t('ai.styleSummary', { mood: session.styleBible.value.mood, concepts: session.styleBible.value.glossary.length })}</p> : null}
    </div></details> : null}
    {session.stageCachePaused.value ? <button type="button" class="btn" onClick={() => session.resumeStage()}>{t('storage.resumeStage')}</button> : null}
  </>;
}
