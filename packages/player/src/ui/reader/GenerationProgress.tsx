import type { ReaderSession } from '../../app/session.ts';
import { readyPercent, STAGE_KINDS, type GenerationRange } from '../../ai/progress.ts';
import { t } from '../../i18n/i18n.ts';
import { ttsStatus } from '../../ai/tts.ts';
import { throughputState } from '../../ai/throughput.ts';
import { settings } from '../../app/store.ts';
import { useMemo } from 'preact/hooks';

/** Small rolling-average readout; readiness remains on the two tracks above it. */
export function GenerationPace({ session }: { session: ReaderSession }) {
  const progress = session.generation.value;
  const tempo = session.engine.currentTempo;
  const speech = ttsStatus.value;
  const contentSpeed = progress.speechEnabled && !speech.limited ? speech.contentSpeed ?? 1 : 1;
  const words = useMemo(() => session.timeline.entries.reduce((n, e) => n + e.sentence.tokens.filter((w) => w.wordLike).length, 0), [session]);
  // Silent RSVP follows words/minute rather than the voice's playback rate. Pauses make this
  // a conservative estimate of the required stage throughput.
  const stageTempo = session.pacerMode && words > 0 ? session.timeline.duration * settings.value.rsvpWpm / (60 * words) : tempo * contentSpeed;
  return <div class="generation-pace" aria-label={t('generation.pace')}>
    {(['speech', 'stage'] as const).map((kind) => {
      const enabled = kind === 'speech' ? progress.speechEnabled && !session.pacerMode : !!session.ai && session.stageVisible;
      const speed = enabled ? kind === 'speech' ? ttsStatus.value.generationSpeed : session.ai?.generationSpeed.value : undefined;
      const target = kind === 'speech' ? tempo : stageTempo;
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
  return <>{ranges.filter((r) => r.state !== 'idle' && r.end > start && r.start < end).map((r) => {
    const offset = (Math.max(start, r.start) - start) / duration * 100;
    const size = (Math.min(end, r.end) - Math.max(start, r.start)) / duration * 100;
    const title = `${r.stageKind ? `${t(`generation.kind.${r.stageKind}`)} · ` : ''}${t(`generation.${r.state}`)}`;
    return <span key={`${r.sectionId}:${r.start}`} class={`generation-segment is-${r.state}${r.stageKind ? ` generation-kind-${r.stageKind}` : ''}`}
      title={title} aria-label={title} style={vertical ? { top: `${offset}%`, height: `${size}%` } : { left: `${offset}%`, width: `${size}%` }} />;
  })}</>;
}

export function GenerationProgress({ session }: { session: ReaderSession }) {
  const progress = session.generation.value;
  const duration = session.timeline.duration;
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
          <GenerationSegments ranges={ranges} start={0} end={duration} />
        </div>
        <span class={`generation-value${working ? ' is-working' : ''}`} title={disabled ? t('generation.onDemand') : `${t('generation.ready')}${working ? ` · ${t('generation.working')}` : ''}${error ? ` · ${t('generation.error')}` : ''}`}>
          {disabled ? '—' : `${percent.toFixed(1)}%`}{error ? ' !' : ''}
        </span>
      </div>;
    })}
    <div class="generation-legend"><span><i class="is-ready" />{t('generation.ready')}</span><span><i class="is-working" />{t('generation.working')}</span><span><i class="is-queued" />{t('generation.queued')}</span></div>
    <div class="generation-kind-legend" aria-label={t('generation.kinds')}>
      {STAGE_KINDS.filter(kind => progress.stage.some(r => r.stageKind === kind && r.state !== 'idle')).map(kind => <span key={kind} class={`generation-kind-${kind}`}><i />{t(`generation.kind.${kind}`)}</span>)}
    </div>
    <GenerationPace session={session} />
  </div>;
}

export function SectionGeneration({ session, sectionId }: { session: ReaderSession; sectionId: string }) {
  const { stage, speech } = session.generation.value;
  const range = stage.find((r) => r.sectionId === sectionId);
  if (!range) return null;
  return <span class="section-generation" aria-label={t('generation.margin')}>
    {(['stage', 'speech'] as const).map((kind) => <span key={kind} class={`generation-track generation-${kind}`} title={t(`generation.${kind}`)}>
      <GenerationSegments ranges={(kind === 'stage' ? stage : speech).filter((r) => r.sectionId === sectionId)} start={range.start} end={range.end} vertical />
    </span>)}
  </span>;
}
