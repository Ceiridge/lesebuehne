import type { VisualPlan } from '@lesebuehne/core';

/** Motion level (B8 settings, `prefers-reduced-motion`). */
export type Motion = 'full' | 'reduced' | 'none';

/** Seconds of book time an item or term takes to appear. */
export const REVEAL_SECONDS = 0.6;
/** Kinetic plans keep at most this many terms on stage. */
export const MAX_VISIBLE_TERMS = 4;

export interface ItemState {
  id: string;
  label: string;
  /** 0 … 1 */
  opacity: number;
  /** Pixels below the rest position. */
  offsetY: number;
  /** The most recently revealed item. */
  current: boolean;
}

export interface TermState {
  term: string;
  opacity: number;
  scale: number;
  offsetY: number;
  current: boolean;
}

export type VisualState =
  | { mode: 'list'; title?: string; items: ItemState[] }
  | { mode: 'kinetic'; terms: TermState[] }
  | { mode: 'none' };

/** Smoothstep easing of a linear progress value. */
const ease = (p: number): number => p * p * (3 - 2 * p);

/**
 * Appear progress of a cue at `t` under `motion`: the reveal runs during the `REVEAL_SECONDS`
 * before the cue, so the item is fully there when its word is spoken (and when playback is
 * paused on that word). 1 for every cue ≤ `t`; "none" jumps from 0 to 1 at the cue.
 */
export function cueProgress(cueTime: number, t: number, motion: Motion): number {
  if (t >= cueTime) return 1;
  if (motion === 'none') return 0;
  return ease(Math.max(0, 1 - (cueTime - t) / REVEAL_SECONDS));
}

/**
 * The visual state at book time `t`: a pure function of its inputs, so a seek to `t` gives
 * exactly the state of continuous playback to `t` (B9). All cues with time ≤ `t` count as applied.
 * Motion "reduced" changes opacity only; "none" jumps to final states.
 */
export function visualState(plan: VisualPlan, cueTimes: readonly number[], t: number, motion: Motion): VisualState {
  const travel = motion === 'full' ? 1 : 0;
  if (plan.mode === 'diagram' && plan.diagram) {
    const revealAt = new Map<string, number>();
    for (const [k, cue] of plan.cues.entries()) {
      if (cue.action.type === 'reveal' && !revealAt.has(cue.action.itemId)) revealAt.set(cue.action.itemId, cueTimes[k] ?? 0);
    }
    let currentId: string | undefined;
    let currentTime = -Infinity;
    for (const [id, time] of revealAt) if (time <= t && time >= currentTime) [currentId, currentTime] = [id, time];
    return {
      mode: 'list',
      ...(plan.diagram.title ? { title: plan.diagram.title } : {}),
      items: plan.diagram.items.map((item) => {
        const at = revealAt.get(item.id);
        const p = at === undefined ? 1 : cueProgress(at, t, motion);
        return { id: item.id, label: item.label, opacity: p, offsetY: (1 - p) * 14 * travel, current: item.id === currentId };
      }),
    };
  }
  if (plan.mode === 'kinetic') {
    const shown = plan.cues
      .map((cue, k) => ({ cue, time: cueTimes[k] ?? 0 }))
      .filter((x) => x.cue.action.type === 'showTerm' && x.time - (motion === 'none' ? 0 : REVEAL_SECONDS) <= t);
    const visible = shown.slice(-MAX_VISIBLE_TERMS);
    return {
      mode: 'kinetic',
      terms: visible.map(({ cue, time }, k) => {
        const p = cueProgress(time, t, motion);
        const current = k === visible.length - 1;
        const term = cue.action.type === 'showTerm' ? cue.action.term : '';
        const rest = current ? 1 : 0.45;
        return {
          term,
          opacity: p * rest,
          scale: travel ? (current ? 0.9 + 0.1 * p : 0.8) : 1,
          offsetY: (1 - p) * 20 * travel,
          current,
        };
      }),
    };
  }
  return { mode: 'none' };
}
