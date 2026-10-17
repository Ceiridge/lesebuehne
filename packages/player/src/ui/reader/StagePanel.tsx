import type { StyleBible } from '@lesebuehne/core';
import { StageView, visualState, type AnimationInit, type StageFrame, type VisualOptions, type VisualState } from '@lesebuehne/renderers';
import { signal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import type { ReaderSession } from '../../app/session.ts';
import { resolvedTheme, settings } from '../../app/store.ts';
import { THEMES } from '../../theme/tokens.ts';
import { t, type MessageKey } from '../../i18n/i18n.ts';
import { DURATIONS } from '../../theme/tokens.ts';
import { DebugOverlay } from './DebugOverlay.tsx';
import { Subtitles } from './Subtitles.tsx';

export interface StageSnapshot {
  frame: StageFrame;
  current: VisualState | null;
  previous: VisualState | null;
  tau: number;
}

/**
 * Stage controller (B9): one step per animation frame. Takes book time τ from the engine (the
 * only clock), the section under the playhead, applies the forced mode and the dwell scheduler,
 * and computes `visualState(plan, cueTimes, τ, motion)` — a pure function, so seeks are exact.
 */
export function stageStep(session: ReaderSession, now: number): StageSnapshot {
  const tau = session.engine.frame(now);
  const sectionId = session.sectionIdAt(session.engine.position.value.entryIndex) ?? '';
  session.stage.crossfadeMs = DURATIONS[settings.value.motion].slow;
  const wanted = session.stageKey(sectionId);
  const playing = session.engine.playing.value;
  const onStage = session.stage.currentId;
  // A new plan for the section on stage while paused (or reading silently): crossfade now; while
  // playing, the dwell rule decides.
  if (!playing && onStage && onStage !== wanted && session.sectionOfKey(onStage) === sectionId) session.stage.navigate(wanted, now);
  const frame = session.stage.tick(wanted, now, playing);
  const motion = settings.value.motion;
  const glossary = session.glossary.value;
  const palette = animationPalette(session);
  const state = (key: string | null): VisualState | null => {
    if (!key) return null;
    const v = session.visualFor(key);
    if (!v) return null;
    const options: VisualOptions = { glossary };
    const sectionId = session.sectionOfKey(key);
    const anim = v.plan.mode === 'animation' ? session.animations.value.get(sectionId) : undefined;
    if (anim && anim.status !== 'failed') options.animation = { key: anim.key, code: anim.program.code, sectionStart: session.sectionStart(sectionId), palette };
    return visualState(v.plan, v.times, tau, motion, options);
  };
  return { frame, current: state(frame.current), previous: state(frame.previous), tau };
}

/** Colours handed to animation programs: the theme's stage colours with the book's accents. */
function animationPalette(session: ReaderSession): AnimationInit['palette'] {
  const theme = THEMES[resolvedTheme(settings.value, session.env.prefersDark())];
  const sb = session.styleBible.value?.palette;
  return { background: theme.stageBg, ink: theme.stageText, accent: sb?.accent ?? theme.stageAccent, accent2: sb?.accent2 ?? theme.accent, muted: theme.muted };
}

/** Style Bible accents for diagrams, mixed with the theme's stage text so every theme stays readable. */
function paletteVars(sb: StyleBible | undefined): Record<string, string> | undefined {
  if (!sb) return undefined;
  return {
    '--lb-accent': `color-mix(in srgb, ${sb.palette.accent} 78%, var(--c-stage-text))`,
    '--lb-accent2': `color-mix(in srgb, ${sb.palette.accent2} 78%, var(--c-stage-text))`,
  };
}

export function StagePanel({ session, subtitles = false }: { session: ReaderSession; subtitles?: boolean }) {
  const snapshot = useMemo(() => signal<StageSnapshot>(stageStep(session, session.env.timers.now())), [session]);

  useEffect(() => {
    let raf = 0;
    const loop = (): void => {
      snapshot.value = stageStep(session, session.env.timers.now());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [session]);

  const s = snapshot.value;
  const sectionId = s.frame.current ? session.sectionOfKey(s.frame.current) : null;
  const plan = sectionId ? session.plans.value.get(sectionId) : undefined;
  const mode = sectionId ? session.forcedMode(sectionId) : 'auto';
  const title = sectionId ? session.sectionTitle(sectionId) : '';
  const previousTitle = s.frame.previous ? session.sectionTitle(session.sectionOfKey(s.frame.previous)) : undefined;
  return (
    <section class={subtitles ? 'stage has-subtitles' : 'stage'} aria-label={t('reader.stage')} style={paletteVars(session.styleBible.value)}>
      <div class="stage-canvas">
        <StageView
          current={s.current}
          previous={s.previous}
          fade={s.frame.fade}
          currentTitle={title}
          previousTitle={previousTitle}
          onAnimationStatus={(key, status) => session.animationStatus(key, status.state === 'failed' ? { state: 'failed', reason: status.reason } : status)}
        />
      </div>
      {s.current && (s.current.mode === 'list' || s.current.mode === 'quote' || (s.current.mode === 'kinetic' && s.current.terms.length > 0)) && title ? (
        <span class="stage-context">{title}</span>
      ) : null}
      {subtitles ? <Subtitles session={session} /> : null}
      {mode !== 'auto' ? <span class="stage-badge">{t(`reader.visual.${mode}` as MessageKey)}</span> : null}
      {session.debug.value && plan ? <DebugOverlay session={session} plan={plan} tau={s.tau} /> : null}
    </section>
  );
}
