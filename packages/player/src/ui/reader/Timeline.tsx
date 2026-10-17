import { useComputed, useSignal } from '@preact/signals';
import { useMemo, useRef } from 'preact/hooks';
import type { ReaderSession } from '../../app/session.ts';
import { t } from '../../i18n/i18n.ts';
import { formatDuration, headingAt, nextSection, positionAt, prevSection, timelineMarkers } from '../../nav/navigation.ts';

/**
 * Timeline bar (B8): chapter and section markers on the estimated time axis, current position,
 * hover/focus tooltip with the heading, click/drag to jump. Arrow keys stay native to the
 * slider: they move by section.
 */
export function Timeline({ session }: { session: ReaderSession }) {
  const track = useRef<HTMLDivElement>(null);
  const hover = useSignal<number | null>(null);
  const dragging = useSignal(false);
  const total = session.timeline.duration || 1;
  const markers = useMemo(() => timelineMarkers(session.book, session.timeline), [session]);
  const now = useComputed(() => {
    void session.engine.position.value;
    return session.engine.time();
  });
  const progress = (dragging.value && hover.value !== null ? hover.value : now.value) / total;

  const tauAt = (clientX: number): number => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * total;
  };

  const seekTo = (tau: number): void => session.navigate(positionAt(session.timeline, tau));
  const tooltipTau = hover.value;

  return (
    <div class="timeline">
      <div
        ref={track}
        class="timeline-track"
        role="slider"
        tabIndex={0}
        aria-label={t('reader.timeline')}
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={Math.round(now.value)}
        aria-valuetext={`${formatDuration(now.value)} / ${formatDuration(total)} – ${headingAt(session.book, session.timeline, now.value)}`}
        onPointerDown={(e) => {
          dragging.value = true;
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          hover.value = tauAt(e.clientX);
        }}
        onPointerMove={(e) => (hover.value = tauAt(e.clientX))}
        onPointerUp={(e) => {
          if (dragging.value) seekTo(tauAt(e.clientX));
          dragging.value = false;
        }}
        onPointerLeave={() => {
          if (!dragging.value) hover.value = null;
        }}
        onKeyDown={(e) => {
          const p = session.engine.position.value;
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') session.navigate(nextSection(session.timeline, p));
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') session.navigate(prevSection(session.timeline, p));
          else if (e.key === 'Home') session.navigate({ entryIndex: 0, tokenIndex: 0 });
          else if (e.key === 'End') session.navigate({ entryIndex: session.timeline.entries.length - 1, tokenIndex: 0 });
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div class="timeline-rail" />
        <div class="timeline-fill" style={{ transform: `scaleX(${progress})` }} />
        {markers.map((m) => (
          <span key={`${m.kind}${m.tau}`} class={`timeline-marker is-${m.kind}`} style={{ left: `${m.at * 100}%` }} />
        ))}
        <span class="timeline-thumb" style={{ left: `${progress * 100}%` }} />
        {tooltipTau !== null ? (
          <span class="timeline-tooltip" style={{ left: `${(tooltipTau / total) * 100}%` }}>
            <span class="timeline-tooltip-title">{headingAt(session.book, session.timeline, tooltipTau)}</span>
            <span class="timeline-tooltip-time">{formatDuration(tooltipTau / session.engine.currentTempo)}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
