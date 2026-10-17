import { conceptFor, type DiagramTemplate, type GlossaryConcept, type VisualPlan } from '@lesebuehne/core';
import type { AnimationInit } from '../animation/host.ts';
import { effectiveTemplate, sceneFor, type Scene } from '../diagram/layout.ts';
import { cameraAt, type Camera } from './camera.ts';

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
  /** Faded back by a `dim` cue (until highlighted again). */
  dimmed: boolean;
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

export interface EdgeState {
  from: string;
  to: string;
  /** Drawing progress 0 … 1. */
  progress: number;
}

/**
 * What the stage draws: the list (HTML) or a laid-out SVG diagram for the other templates; image
 * plans render their fallback until the image renderer exists (M5).
 */
export type VisualState =
  | { mode: 'list'; template: DiagramTemplate; title?: string; items: ItemState[] }
  | { mode: 'diagram'; template: DiagramTemplate; title?: string; scene: Scene; items: ItemState[]; edges: EdgeState[] }
  | { mode: 'kinetic'; terms: TermState[] }
  | { mode: 'quote'; text: string; opacity: number }
  /** A generated illustration with its Ken Burns camera; `fallback` shows until it has loaded. */
  | { mode: 'image'; url: string; camera: Camera; fallback: VisualState }
  /** Stand-in for an image that is not there (yet): palette backdrop with the key terms on top. */
  | { mode: 'placeholder'; overlay: VisualState }
  /** An LLM-written program in the sandbox; `fallback` is drawn until it runs (and if it fails). */
  | { mode: 'animation'; key: string; code: string; t: number; init: AnimationInit; fallback: VisualState }
  | { mode: 'none' };

export interface VisualOptions {
  /** Glossary lookup (`glossaryIndex(styleBible)`) for colours and glyphs. */
  glossary?: ReadonlyMap<string, GlossaryConcept>;
  /** The section's generated image (image plans only). */
  image?: { url: string };
  /** The section's animation program (animation plans only). */
  animation?: { key: string; code: string; sectionStart: number; palette: AnimationInit['palette'] };
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
  const { glossary, animation, image } = options;
  if (plan.mode === 'image') {
    const overlay = visualState({ ...plan, mode: 'kinetic' }, cueTimes, t, motion, glossary ? { glossary } : {});
    const placeholder: VisualState = { mode: 'placeholder', overlay };
    if (!image || !plan.image) return placeholder;
    const focus = plan.cues.flatMap((c, k) => (c.action.type === 'focus' ? [{ time: cueTimes[k] ?? 0, regionId: c.action.regionId }] : []));
    return { mode: 'image', url: image.url, camera: cameraAt(plan.image, focus, t, motion), fallback: placeholder };
  }
  if (plan.mode === 'animation' && animation) {
    const fallback = visualState(plan, cueTimes, t, motion, glossary ? { glossary } : {});
    const items = (plan.diagram?.items ?? []).map((i) => ({ id: i.id, label: i.label, ...(i.group ? { group: i.group } : {}), ...tint(i.label, glossary) }));
    return {
      mode: 'animation',
      key: animation.key,
      code: animation.code,
      t: t - animation.sectionStart,
      init: { cues: cueTimes.map((c) => c - animation.sectionStart), items, terms: plan.keyTerms, palette: animation.palette, motion },
      fallback,
    };
  }
  if ((plan.mode === 'diagram' || plan.mode === 'animation') && plan.diagram) {
    const revealAt = new Map<string, number>();
    const connectAt = new Map<string, number>();
    /** Latest dim / highlight per item that has happened by `t`. */
    const lastMark = new Map<string, { time: number; dim: boolean }>();
    let currentId: string | undefined;
    let currentTime = -Infinity;
    for (const [k, cue] of plan.cues.entries()) {
      const a = cue.action;
      const time = cueTimes[k] ?? 0;
      if (a.type === 'connect') {
        const key = `${a.from}>${a.to}`;
        if (!connectAt.has(key)) connectAt.set(key, time);
        continue;
      }
      if (a.type !== 'reveal' && a.type !== 'highlight' && a.type !== 'dim') continue;
      if (a.type === 'reveal' && !revealAt.has(a.itemId)) revealAt.set(a.itemId, time);
      if (time > t) continue;
      const prev = lastMark.get(a.itemId);
      if (!prev || time >= prev.time) lastMark.set(a.itemId, { time, dim: a.type === 'dim' });
      if (a.type !== 'dim' && time >= currentTime) [currentId, currentTime] = [a.itemId, time];
    }
    if (currentId && lastMark.get(currentId)?.dim) currentId = undefined;
    const items: ItemState[] = plan.diagram.items.map((item) => {
      const at = revealAt.get(item.id);
      const p = at === undefined ? 1 : cueProgress(at, t, motion);
      return {
        id: item.id,
        label: item.label,
        opacity: p,
        offsetY: (1 - p) * 14 * travel,
        current: item.id === currentId,
        dimmed: lastMark.get(item.id)?.dim ?? false,
        ...(item.group ? { group: item.group } : {}),
        ...(item.detail ? { detail: item.detail } : {}),
        ...tint(item.label, glossary),
      };
    });
    const title = plan.diagram.title ? { title: plan.diagram.title } : {};
    if (effectiveTemplate(plan.diagram) === 'list') return { mode: 'list', template: plan.diagram.template, ...title, items };
    const scene = sceneFor(plan.diagram);
    // An edge without its own connect cue is drawn once both endpoints are there.
    const edges: EdgeState[] = scene.edges.map((e) => {
      const at = connectAt.get(`${e.from}>${e.to}`) ?? Math.max(revealAt.get(e.from) ?? -Infinity, revealAt.get(e.to) ?? -Infinity);
      return { from: e.from, to: e.to, progress: at === -Infinity ? 1 : cueProgress(at, t, motion) };
    });
    return { mode: 'diagram', template: scene.template, ...title, scene, items, edges };
  }
  if (plan.mode === 'quote' && plan.quote) return { mode: 'quote', text: plan.quote.phrase, opacity: 1 };
  // Kinetic, and animation plans without a diagram: their key terms.
  if (plan.mode === 'kinetic' || (plan.mode === 'animation' && plan.fallback === 'kinetic')) {
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
