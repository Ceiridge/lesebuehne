import { useComputed } from '@preact/signals';
import type { ReaderSession } from '../../app/session.ts';
import { settings } from '../../app/store.ts';
import { clampTempo, MAX_TEMPO, MIN_TEMPO, TEMPO_STEP } from '../../engine/engine.ts';
import { t, type MessageKey } from '../../i18n/i18n.ts';
import { formatDuration, nextSentence, prevSentence } from '../../nav/navigation.ts';
import { IconMinus, IconNext, IconPause, IconPlay, IconPlus, IconPrev } from '../icons.tsx';
import { Timeline } from './Timeline.tsx';

export function setTempo(session: ReaderSession, tempo: number): void {
  const next = clampTempo(tempo);
  settings.value = { ...settings.value, tempo: next };
  session.engine.setTempo(next);
}

/** Transport bar: timeline, previous/next sentence, play/pause, tempo, remaining time, visual mode. */
export function Controls({ session }: { session: ReaderSession }) {
  const playing = session.engine.playing.value;
  const tempo = settings.value.tempo;
  const remaining = useComputed(() => {
    void session.engine.position.value;
    return (session.timeline.duration - session.engine.time()) / settings.value.tempo;
  });
  const sectionId = session.sectionIdAt(session.engine.position.value.entryIndex);
  const mode = sectionId ? session.forcedMode(sectionId) : 'auto';
  const p = session.engine.position.value;

  return (
    <footer class="controls">
      <Timeline session={session} />
      <div class="transport">
        <div class="transport-side">
          <span class="time-remaining" aria-live="off">
            {t('reader.remaining', { time: formatDuration(remaining.value) })}
          </span>
        </div>
        <div class="transport-main">
          <button type="button" class="icon-btn" aria-label={t('reader.prevSentence')} title={`${t('reader.prevSentence')} (←)`} onClick={() => session.navigate(prevSentence(session.timeline, p))}>
            <IconPrev />
          </button>
          <button
            type="button"
            class={playing ? 'play-btn is-playing' : 'play-btn'}
            aria-label={playing ? t('reader.pause') : t('reader.play')}
            title={`${playing ? t('reader.pause') : t('reader.play')} (␣)`}
            aria-pressed={playing}
            disabled={session.engine.silent}
            onClick={() => session.togglePlay()}
          >
            {playing ? <IconPause size={26} /> : <IconPlay size={26} />}
          </button>
          <button type="button" class="icon-btn" aria-label={t('reader.nextSentence')} title={`${t('reader.nextSentence')} (→)`} onClick={() => session.navigate(nextSentence(session.timeline, p))}>
            <IconNext />
          </button>
        </div>
        <div class="transport-side transport-right">
          <div class="tempo" role="group" aria-label={t('settings.tempo')}>
            <button type="button" class="icon-btn small" aria-label={t('reader.tempoDown')} disabled={tempo <= MIN_TEMPO} onClick={() => setTempo(session, tempo - TEMPO_STEP)}>
              <IconMinus size={16} />
            </button>
            <span class="tempo-value" aria-live="polite">
              {tempo.toFixed(2).replace(/0$/, '')}×
            </span>
            <button type="button" class="icon-btn small" aria-label={t('reader.tempoUp')} disabled={tempo >= MAX_TEMPO} onClick={() => setTempo(session, tempo + TEMPO_STEP)}>
              <IconPlus size={16} />
            </button>
          </div>
          <button type="button" class="chip" title={`${t('reader.visual')} (V)`} aria-label={`${t('reader.visual')}: ${t(`reader.visual.${mode}` as MessageKey)}`} onClick={() => session.cycleVisual()}>
            {t(`reader.visual.${mode}` as MessageKey)}
          </button>
        </div>
      </div>
    </footer>
  );
}
