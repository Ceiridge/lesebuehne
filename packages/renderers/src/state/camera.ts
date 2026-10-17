import type { ImageSpec } from '@lesebuehne/core';
import type { Motion } from './visual-state.ts';

/** Camera on an image: centre in normalised image coordinates and zoom (1 = whole image). */
export interface Camera {
  x: number;
  y: number;
  scale: number;
}

/** Seconds a camera move to a focus region takes. */
export const CAMERA_MOVE_SECONDS = 10;
/** Share of the frame a focused region fills. */
const REGION_FILL = 0.7;
const MAX_SCALE = 1.04;

const ease = (p: number): number => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));

/** Keeps the frame inside the image at `scale`. */
function bounded(c: Camera): Camera {
  const half = 0.5 / c.scale;
  return { scale: c.scale, x: clamp(c.x, half, 1 - half), y: clamp(c.y, half, 1 - half) };
}

/** Camera that frames a focus region. */
export function cameraFor(region: ImageSpec['focusRegions'][number]): Camera {
  const scale = clamp(REGION_FILL / Math.max(region.w, region.h, 0.05), 1, MAX_SCALE);
  return bounded({ x: region.x + region.w / 2, y: region.y + region.h / 2, scale });
}

const WHOLE: Camera = { x: 0.5, y: 0.5, scale: 1 };

/**
 * Ken Burns camera at book time `t` (spec 005 B3), a pure function so seeking is exact: before
 * the first focus cue the whole picture stays still; each focus cue eases from wherever
 * the camera is at that moment to its region. Reduced or no motion: the whole image, still.
 */
export function cameraAt(spec: ImageSpec, focus: ReadonlyArray<{ time: number; regionId: string }>, t: number, motion: Motion): Camera {
  if (motion !== 'full') return WHOLE;
  const regions = new Map(spec.focusRegions.map((r) => [r.id, r]));
  let from: Camera | undefined;
  let to: Camera = WHOLE;
  let start = -Infinity;
  const at = (time: number): Camera => {
    if (!from) return WHOLE;
    const p = ease(clamp((time - start) / CAMERA_MOVE_SECONDS, 0, 1));
    return bounded({ x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p, scale: from.scale + (to.scale - from.scale) * p });
  };
  for (const cue of [...focus].sort((a, b) => a.time - b.time)) {
    if (cue.time > t) break;
    const region = regions.get(cue.regionId);
    if (!region) continue;
    from = at(cue.time);
    to = cameraFor(region);
    start = cue.time;
  }
  return at(t);
}
