import { useComputed, useSignal } from '@preact/signals';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { GenerationRange } from '../../ai/progress.ts';
import type { ReaderSession } from '../../app/session.ts';
import { t, type MessageKey } from '../../i18n/i18n.ts';
import { entryIndexAt } from '@lesebuehne/core';
import { formatDuration, headingAt, nextSection, positionAt, prevSection, timelineMarkers } from '../../nav/navigation.ts';
import { IconMinus, IconPlus } from '../icons.tsx';
import { GenerationLegend, GenerationProgress } from './GenerationProgress.tsx';

/** Smallest visible stretch of the book when zoomed in, in seconds at 1×. */
const MIN_SPAN = 20;
/** After the reader scrolls the zoomed view, it stops following the playhead for this long. */
const FOLLOW_PAUSE_MS = 4000;
/** Sentence ticks appear when the view shows at most this many seconds. */
const TICK_SPAN = 6 * 60;
const ZOOM_STEP = 2;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function laneAt(ranges: readonly GenerationRange[], tau: number): GenerationRange | undefined {
  return ranges.find((r) => r.start <= tau && tau < r.end);
}

/**
 * Timeline (B8): the stage and speech tracks sit just above the main line and share its time axis.
 * Hovering anywhere shows one crosshair through all three with the heading, the sentence and the
 * state of both tracks; clicking or dragging anywhere jumps there. The view zooms (buttons, wheel
 * at the pointer) and pans (Shift+wheel, horizontal wheel); while playing, a zoomed view follows
 * the playhead. Arrow keys stay native to the slider: they move by section.
 */
export function Timeline({ session }: { session: ReaderSession }) {
  const hit = useRef<HTMLDivElement>(null);
  const hover = useSignal<number | null>(null);
  const dragging = useSignal(false);
  const total = session.timeline.duration || 1;
  const view = useSignal({ start: 0, span: total });
  const lastManual = useRef(0);
  const markers = useMemo(() => timelineMarkers(session.book, session.timeline), [session]);
  const now = useComputed(() => {
    void session.engine.position.value;
    return session.engine.time();
  });

  // Handlers read the latest view: several wheel events can arrive before the next render.
  const current = (v = view.peek()): { start: number; span: number } => {
    const sp = clamp(v.span, Math.min(MIN_SPAN, total), total);
    return { start: clamp(v.start, 0, total - sp), span: sp };
  };
  const { start, span } = current(view.value);
  const end = start + span;
  const zoomed = span < total - 0.5;
  const setView = (s: number, sp: number, manual = true): void => {
    const nextSpan = clamp(sp, Math.min(MIN_SPAN, total), total);
    view.value = { start: clamp(s, 0, total - nextSpan), span: nextSpan };
    if (manual) lastManual.current = Date.now();
  };

  // A zoomed view follows the playhead unless the reader just moved it.
  useEffect(() => {
    if (!zoomed || dragging.peek() || Date.now() - lastManual.current < FOLLOW_PAUSE_MS) return;
    const tau = now.value;
    if (tau < start || tau > start + span * 0.92) setView(tau - span * 0.15, span, false);
  }, [now.value, zoomed, start, span]);

  const pct = (tau: number): number => ((tau - start) / span) * 100;
  const tauAt = (clientX: number): number => {
    const rect = hit.current?.getBoundingClientRect();
    const v = current();
    if (!rect || rect.width === 0) return v.start;
    return v.start + clamp((clientX - rect.left) / rect.width, 0, 1) * v.span;
  };
  const zoom = (factor: number, at = hover.peek() ?? now.peek()): void => {
    const around = Number.isFinite(at) ? at : now.peek();
    const v = current();
    const f = clamp((around - v.start) / v.span, 0, 1);
    const next = v.span * factor;
    setView(around - f * next, next);
  };

  const seekTo = (tau: number): void => session.navigate(positionAt(session.timeline, tau));
  const position = dragging.value && hover.value !== null ? hover.value : now.value;
  const tooltipTau = hover.value;
  const progress = session.generation.value;
  const ticks = span <= TICK_SPAN ? session.timeline.entries.filter((e) => e.start > start && e.start < end).slice(0, 400) : [];
  const sentenceAt = (tau: number): string => {
    const text = session.timeline.entries[entryIndexAt(session.timeline, tau)]?.sentence.text ?? '';
    return text.length > 90 ? `${text.slice(0, 89).trimEnd()} …` : text;
  };
  const laneLabel = (kind: 'stage' | 'speech', tau: number): string => {
    const r = laneAt(progress[kind], tau);
    if (!r || r.state === 'idle') return `${t(`generation.${kind}`)}: —`;
    return `${t(`generation.${kind}`)}: ${r.stageKind ? `${t(`generation.kind.${r.stageKind}` as MessageKey)} · ` : ''}${t(`generation.${r.state}`)}`;
  };

  return (
    <div class="timeline">
      <div class="timeline-head">
        <div class="timeline-zoom" role="group" aria-label={t('reader.zoom')} title={t('reader.zoomHint')}>
          <button type="button" class="icon-btn small" aria-label={t('reader.zoomOut')} disabled={!zoomed} onClick={() => zoom(ZOOM_STEP, now.peek())}><IconMinus size={14} /></button>
          <button type="button" class="icon-btn small" aria-label={t('reader.zoomIn')} disabled={span <= Math.min(MIN_SPAN, total) + 0.5} onClick={() => zoom(1 / ZOOM_STEP, now.peek())}><IconPlus size={14} /></button>
          {zoomed ? (
            <>
              <button type="button" class="chip small" onClick={() => setView(0, total)}>{t('reader.zoomAll')}</button>
              <span
                class="timeline-overview"
                role="presentation"
                title={t('reader.zoomOverview')}
                onClick={(e) => {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setView(((e.clientX - rect.left) / rect.width) * total - span / 2, span);
                }}
              >
                <i class="timeline-overview-window" style={{ left: `${(start / total) * 100}%`, width: `${(span / total) * 100}%` }} />
                <i class="timeline-overview-now" style={{ left: `${(now.value / total) * 100}%` }} />
              </span>
              <span class="timeline-range">{formatDuration(start / session.engine.currentTempo)}–{formatDuration(end / session.engine.currentTempo)}</span>
            </>
          ) : null}
        </div>
        <GenerationLegend session={session} />
      </div>
      <div
        class="timeline-body"
        onWheel={(e) => {
          const pan = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
          const delta = pan ? (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) : e.deltaY;
          if (delta === 0) return;
          e.preventDefault();
          if (pan) {
            const width = hit.current?.getBoundingClientRect().width || 1;
            const v = current();
            setView(v.start + (delta / width) * v.span, v.span);
          } else zoom(delta < 0 ? 1 / 1.4 : 1.4, tauAt(e.clientX));
        }}
      >
        <GenerationProgress session={session} start={start} end={end} legend={false} />
        <div class="timeline-track" aria-hidden="true">
          <div class="timeline-rail" />
          <div class="timeline-fill" style={{ transform: `scaleX(${clamp(pct(position) / 100, 0, 1)})` }} />
          {ticks.map((e) => <span key={e.sentence.id} class="timeline-tick" style={{ left: `${pct(e.start)}%` }} />)}
          {markers.filter((m) => m.tau >= start && m.tau <= end).map((m) => (
            <span key={`${m.kind}${m.tau}`} class={`timeline-marker is-${m.kind}`} style={{ left: `${pct(m.tau)}%` }} />
          ))}
          {position >= start && position <= end ? <span class="timeline-thumb" style={{ left: `${pct(position)}%` }} /> : null}
        </div>
        <div
          ref={hit}
          class={`timeline-hit${dragging.value ? ' is-dragging' : ''}`}
          role="slider"
          tabIndex={0}
          aria-label={t('reader.timeline')}
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(now.value)}
          aria-valuetext={`${formatDuration(now.value)} / ${formatDuration(total)} – ${headingAt(session.book, session.timeline, now.value)}`}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
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
          {tooltipTau !== null ? (
            <>
              <span class="timeline-crosshair" style={{ left: `${pct(tooltipTau)}%` }} />
              <span class={`timeline-tooltip${pct(tooltipTau) > 70 ? ' is-left' : pct(tooltipTau) < 30 ? ' is-right' : ''}`} style={{ left: `${pct(tooltipTau)}%` }}>
                <span class="timeline-tooltip-title">{headingAt(session.book, session.timeline, tooltipTau)}</span>
                <span class="timeline-tooltip-time">{formatDuration(tooltipTau / session.engine.currentTempo)}</span>
                <span class="timeline-tooltip-text">{sentenceAt(tooltipTau)}</span>
                <span class="timeline-tooltip-lanes">
                  <span class="generation-stage">{laneLabel('stage', tooltipTau)}</span>
                  <span class="generation-speech">{laneLabel('speech', tooltipTau)}</span>
                </span>
              </span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
