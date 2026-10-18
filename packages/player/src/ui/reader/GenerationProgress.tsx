import type { ReaderSession } from '../../app/session.ts';
import { readyPercent, STAGE_KINDS, type GenerationRange } from '../../ai/progress.ts';
import { t } from '../../i18n/i18n.ts';
import { ttsStatus } from '../../ai/tts.ts';
import { throughputState } from '../../ai/throughput.ts';
import { settings } from '../../app/store.ts';
import { useMemo } from 'preact/hooks';

export interface GenerationRate {
  enabled: boolean;
  /** Generated seconds per wall second (rolling average), if measured. */
  speed?: number | undefined;
  /** What reading needs: the tempo for speech, the timeline pace for the stage. */
  target: number;
}

/** Word count of a book (RSVP pace). */
export const bookWords = (session: ReaderSession): number => session.timeline.entries.reduce((n, e) => n + e.sentence.tokens.filter((w) => w.wordLike).length, 0);

/** Generation pace against reading pace for speech and stage (shared by the tracks and the info panel). */
export function generationRates(session: ReaderSession, words: number): Record<'speech' | 'stage', GenerationRate> {
  const progress = session.generation.value;
  const tempo = session.engine.currentTempo;
  const speech = ttsStatus.value;
  const contentSpeed = progress.speechEnabled && !speech.limited ? speech.contentSpeed ?? 1 : 1;
  // Silent RSVP follows words/minute rather than the voice's playback rate. Pauses make this
  // a conservative estimate of the required stage throughput.
  const stageTempo = session.pacerMode && words > 0 ? session.timeline.duration * settings.value.rsvpWpm / (60 * words) : tempo * contentSpeed;
  const speechOn = progress.speechEnabled && !session.pacerMode;
  const stageOn = !!session.ai && session.stageVisible;
  return {
    speech: { enabled: speechOn, speed: speechOn ? speech.generationSpeed : undefined, target: tempo },
    stage: { enabled: stageOn, speed: stageOn ? session.ai?.generationSpeed.value : undefined, target: stageTempo },
  };
}

/** Small rolling-average readout; readiness remains on the two tracks above it. */
export function GenerationPace({ session }: { session: ReaderSession }) {
  const progress = session.generation.value;
  const words = useMemo(() => bookWords(session), [session]);
  const rates = generationRates(session, words);
  return <div class="generation-pace" aria-label={t('generation.pace')}>
    {(['speech', 'stage'] as const).map((kind) => {
      const { enabled, speed, target } = rates[kind];
      const state = throughputState(speed, target);
      const hiddenStage = kind === 'stage' && !session.stageVisible;
      const ready = progress[kind].length > 0 && progress[kind].every((r) => r.state === 'ready');
      const label = hiddenStage ? t('generation.paused') : speed === undefined ? !enabled ? '—' : ready ? t('generation.ready') : t('generation.pace.measuring') : t(`generation.pace.${state}`);
      const detail = hiddenStage ? t('generation.hiddenStage') : speed === undefined ? t('generation.pace.waiting') : t('generation.pace.detail', { speed: speed.toFixed(2), tempo: target.toFixed(2) });
      const title = `${t(`generation.${kind}`)}: ${detail}${kind === 'stage' ? ` ${t('generation.pace.stageEstimate')}` : ''}`;
      return <span key={kind} class={`generation-pace-item is-${enabled ? state : 'disabled'}`} title={title} tabIndex={0} aria-label={`${t(`generation.${kind}`)}: ${label}. ${detail}${kind === 'stage' ? ` ${t('generation.pace.stageEstimate')}` : ''}`}>
        <i aria-hidden="true" />{t(`generation.${kind}`)}: {label}{speed !== undefined ? ` · Ø ${(speed / target).toFixed(2)}×` : ''}
      </span>;
    })}
  </div>;
}

export function GenerationSegments({ ranges, start, end, vertical = false }: { ranges: readonly GenerationRange[]; start: number; end: number; vertical?: boolean }) {
  const duration = end - start || 1;
  return <>{ranges.filter((r) => (r.state !== 'idle' || r.entryIndex !== undefined) && r.end > start && r.start < end).map((r) => {
    const offset = (Math.max(start, r.start) - start) / duration * 100;
    const size = (Math.min(end, r.end) - Math.max(start, r.start)) / duration * 100;
    const title = `${r.entryIndex !== undefined ? `${t('generation.sentence', { number: r.entryIndex + 1 })} · ` : ''}${r.stageKind ? `${t(`generation.kind.${r.stageKind}`)} · ` : ''}${t(`generation.${r.state}`)}`;
    return <span key={`${r.sectionId}:${r.start}`} data-entry-index={r.entryIndex} class={`generation-segment is-${r.state}${r.entryIndex !== undefined ? ' is-sentence' : ''}${vertical ? ' is-vertical' : ''}${r.stageKind ? ` generation-kind-${r.stageKind}` : ''}`}
      title={title} aria-label={title} style={vertical ? { top: `${offset}%`, height: `${size}%` } : { left: `${offset}%`, width: `${size}%` }} />;
  })}</>;
}

/** Legend for the tracks: states, visual kinds, and the pace readout. */
export function GenerationLegend({ session }: { session: ReaderSession }) {
  const progress = session.generation.value;
  return <div class="generation-legends">
    <div class="generation-legend"><span><i class="is-ready" />{t('generation.ready')}</span><span><i class="is-working" />{t('generation.working')}</span><span><i class="is-queued" />{t('generation.queued')}</span></div>
    <div class="generation-kind-legend" aria-label={t('generation.kinds')}>
      {STAGE_KINDS.filter(kind => progress.stage.some(r => r.stageKind === kind && r.state !== 'idle')).map(kind => <span key={kind} class={`generation-kind-${kind}`}><i />{t(`generation.kind.${kind}`)}</span>)}
    </div>
    <GenerationPace session={session} />
  </div>;
}

/**
 * Stage and speech tracks. `start`/`end` select the visible part of the book (timeline zoom); the
 * percentages always cover the whole book. Without `legend: false` the legend follows the tracks.
 */
export function GenerationProgress({ session, start = 0, end, legend = true }: { session: ReaderSession; start?: number; end?: number; legend?: boolean }) {
  const progress = session.generation.value;
  const duration = session.timeline.duration;
  const viewEnd = end ?? duration;
  return <div class="generation-progress">
    {(['stage', 'speech'] as const).map((kind) => {
      const ranges = progress[kind];
      const percent = readyPercent(ranges, duration);
      const working = ranges.some((r) => r.state === 'working');
      const error = ranges.some((r) => r.state === 'error');
      const label = t(`generation.${kind}`);
      const disabled = kind === 'speech' && !progress.speechEnabled;
      return <div key={kind} class={`generation-row generation-${kind}`}>
        <span class="generation-label">{label}</span>
        <div class="generation-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Number(percent.toFixed(1))}
          aria-valuetext={disabled ? t('generation.onDemand') : `${percent.toFixed(1)}% ${t('generation.ready')}${working ? ` · ${t('generation.working')}` : ''}`}>
          <GenerationSegments ranges={ranges} start={start} end={viewEnd} />
        </div>
        <span class={`generation-value${working ? ' is-working' : ''}`} title={disabled ? t('generation.onDemand') : `${t('generation.ready')}${working ? ` · ${t('generation.working')}` : ''}${error ? ` · ${t('generation.error')}` : ''}`}>
          {disabled ? '—' : `${percent.toFixed(1)}%`}{error ? ' !' : ''}
        </span>
      </div>;
    })}
    {legend ? <GenerationLegend session={session} /> : null}
  </div>;
}

export function SectionGeneration({ session, sectionId }: { session: ReaderSession; sectionId: string }) {
  const { stage, speech } = session.generation.value;
  const ranges = stage.filter((r) => r.sectionId === sectionId);
  if (!ranges.length) return null;
  const start = ranges[0]!.start;
  const end = ranges.at(-1)!.end;
  return <span class="section-generation" aria-label={t('generation.margin')}>
    {(['stage', 'speech'] as const).map((kind) => <span key={kind} class={`generation-track generation-${kind}`} title={t(`generation.${kind}`)}>
      <GenerationSegments ranges={kind === 'stage' ? ranges : speech.filter((r) => r.sectionId === sectionId)} start={start} end={end} vertical />
    </span>)}
  </span>;
}
