import { conceptFor, type DiagramTemplate, type GlossaryConcept, type VisualPlan } from '@lesebuehne/core';

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
  /** The most recently revealed or highlighted item. */
  current: boolean;
  group?: string;
  detail?: string;
  /** Glossary colour and glyph (Style Bible). */
  color?: string;
  glyph?: string;
}

export interface TermState {
  term: string;
  opacity: number;
  scale: number;
  offsetY: number;
  current: boolean;
  color?: string;
  glyph?: string;
}

/**
 * What the stage draws. Every diagram template renders as a list for now (`template` is a CSS hook);
 * image and animation plans render their fallback until their renderers exist (M3).
 */
export type VisualState =
  | { mode: 'list'; template: DiagramTemplate; title?: string; items: ItemState[] }
  | { mode: 'kinetic'; terms: TermState[] }
  | { mode: 'quote'; text: string; opacity: number }
  | { mode: 'none' };

export interface VisualOptions {
  /** Glossary lookup (`glossaryIndex(styleBible)`) for colours and glyphs. */
  glossary?: ReadonlyMap<string, GlossaryConcept>;
}

const tint = (label: string, glossary: VisualOptions['glossary']): { color?: string; glyph?: string } => {
  const c = glossary ? conceptFor(label, glossary) : undefined;
  return c ? { color: c.color, glyph: c.glyph } : {};
};

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
export function visualState(plan: VisualPlan, cueTimes: readonly number[], t: number, motion: Motion, options: VisualOptions = {}): VisualState {
  const travel = motion === 'full' ? 1 : 0;
  const { glossary } = options;
  if ((plan.mode === 'diagram' || plan.mode === 'animation') && plan.diagram) {
    const revealAt = new Map<string, number>();
    let currentId: string | undefined;
    let currentTime = -Infinity;
    for (const [k, cue] of plan.cues.entries()) {
      const a = cue.action;
      if (a.type !== 'reveal' && a.type !== 'highlight') continue;
      const time = cueTimes[k] ?? 0;
      if (a.type === 'reveal' && !revealAt.has(a.itemId)) revealAt.set(a.itemId, time);
      if (time <= t && time >= currentTime) [currentId, currentTime] = [a.itemId, time];
    }
    return {
      mode: 'list',
      template: plan.diagram.template,
      ...(plan.diagram.title ? { title: plan.diagram.title } : {}),
      items: plan.diagram.items.map((item) => {
        const at = revealAt.get(item.id);
        const p = at === undefined ? 1 : cueProgress(at, t, motion);
        return {
          id: item.id,
          label: item.label,
          opacity: p,
          offsetY: (1 - p) * 14 * travel,
          current: item.id === currentId,
          ...(item.group ? { group: item.group } : {}),
          ...(item.detail ? { detail: item.detail } : {}),
          ...tint(item.label, glossary),
        };
      }),
    };
  }
  if (plan.mode === 'quote' && plan.quote) return { mode: 'quote', text: plan.quote.phrase, opacity: 1 };
  // Kinetic, and the fallback of image/animation plans without a renderer: their key terms.
  if (plan.mode === 'kinetic' || ((plan.mode === 'image' || plan.mode === 'animation') && plan.fallback === 'kinetic')) {
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
          ...tint(term, glossary),
        };
      }),
    };
  }
  return { mode: 'none' };
}
