import { useComputed } from '@preact/signals';
import type { ReaderSession } from '../../app/session.ts';
import { settings } from '../../app/store.ts';
import { clampTempo, MAX_TEMPO, MIN_TEMPO, TEMPO_STEP } from '../../engine/engine.ts';
import { LIMITS } from '../../settings/settings.ts';
import { t, type MessageKey } from '../../i18n/i18n.ts';
import { formatDuration, nextSentence, prevSentence } from '../../nav/navigation.ts';
import { IconMinus, IconNext, IconPause, IconPlay, IconPlus, IconPrev } from '../icons.tsx';
import { Timeline } from './Timeline.tsx';
import { ttsStatus } from '../../ai/tts.ts';
import { isTtsVoice } from '../../engine/audio-port.ts';
import { VolumeControl } from './VolumeControl.tsx';

/** Server voice readiness (spec 004): buffering / ready ahead / limited. */
function TtsChip({ session }: { session: ReaderSession }) {
  if (session.pacerMode || !isTtsVoice(session.engine.currentVoice?.voiceURI)) return null;
  const s = ttsStatus.value;
  const tempo = session.engine.currentTempo;
  const state = s.limited ? 'limited' : s.state === 'buffering' ? 'buffering' : 'ready';
  const label = state === 'ready' ? t('tts.buffer', { seconds: Math.floor((s.aheadSeconds ?? 0) / tempo) }) : t(`tts.${state}` as MessageKey, { ahead: s.ahead });
  const speed = s.generationSpeed;
  const detail = speed === undefined ? t('tts.measuring') : t(speed >= tempo * 1.15 ? 'tts.fastEnough' : 'tts.needsBuffer', { speed: speed.toFixed(1), tempo: tempo.toFixed(1) });
  return (
    <span class={`tts-chip is-${state}`} title={`${label} · ${detail}${s.lastError ? ` – ${s.lastError}` : ''}`}>
      <span class="ai-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export const WPM_STEP = 25;

/** RSVP pace without a voice (spec 007 B1). */
export function setWpm(wpm: number): void {
  const { min, max } = LIMITS.rsvpWpm;
  settings.value = { ...settings.value, rsvpWpm: Math.min(max, Math.max(min, Math.round(wpm / WPM_STEP) * WPM_STEP)) };
}

export function setTempo(session: ReaderSession, tempo: number): void {
  const next = clampTempo(tempo);
  settings.value = { ...settings.value, tempo: next };
  session.engine.setTempo(next);
}

/** Transport bar: timeline, previous/next sentence, play/pause, tempo, remaining time, visual mode. */
export function Controls({ session }: { session: ReaderSession }) {
  const pacer = session.pacerMode;
  const playing = session.isPlaying;
  const tempo = settings.value.tempo;
  const wpm = settings.value.rsvpWpm;
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
          {!pacer ? <span class="time-remaining" aria-live="off">
            {t('reader.remaining', { time: formatDuration(remaining.value) })}
          </span> : null}
          <TtsChip session={session} />
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
            disabled={session.engine.silent && !pacer}
            onClick={() => session.togglePlay()}
          >
            {playing ? <IconPause size={26} /> : <IconPlay size={26} />}
          </button>
          <button type="button" class="icon-btn" aria-label={t('reader.nextSentence')} title={`${t('reader.nextSentence')} (→)`} onClick={() => session.navigate(nextSentence(session.timeline, p))}>
            <IconNext />
          </button>
        </div>
        <div class="transport-side transport-right">
          {!pacer ? <VolumeControl /> : null}
          {pacer ? (
            <div class="tempo" role="group" aria-label={t('settings.rsvpWpm')}>
              <button type="button" class="icon-btn small" aria-label={t('reader.tempoDown')} disabled={wpm <= LIMITS.rsvpWpm.min} onClick={() => setWpm(wpm - WPM_STEP)}>
                <IconMinus size={16} />
              </button>
              <span class="tempo-value is-wpm" aria-live="polite">
                {t('reader.wpm', { wpm })}
              </span>
              <button type="button" class="icon-btn small" aria-label={t('reader.tempoUp')} disabled={wpm >= LIMITS.rsvpWpm.max} onClick={() => setWpm(wpm + WPM_STEP)}>
                <IconPlus size={16} />
              </button>
            </div>
          ) : (
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
          )}
          <button type="button" class="chip" title={`${t('reader.visual')} (V)`} aria-label={`${t('reader.visual')}: ${t(`reader.visual.${mode}` as MessageKey)}`} onClick={() => session.cycleVisual()}>
            {t(`reader.visual.${mode}` as MessageKey)}
          </button>
        </div>
      </div>
    </footer>
  );
}
