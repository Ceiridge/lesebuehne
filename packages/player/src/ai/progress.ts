import type { VisualMode } from '@lesebuehne/core';

export type GenerationState = 'idle' | 'queued' | 'working' | 'ready' | 'error';
export const STAGE_KINDS = ['image', 'animation', 'diagram', 'quote', 'kinetic', 'figure', 'none'] as const satisfies readonly VisualMode[];

export interface GenerationRange {
  start: number;
  end: number;
  sectionId: string;
  /** Keep sentence boundaries for image sequences, even when neighbouring states match. */
  entryIndex?: number;
  state: GenerationState;
  /** Effective visual plan; absent for speech or while an AI plan is still unknown. */
  stageKind?: VisualMode;
}

/** Merge adjacent ranges for compact rendering, keeping section boundaries. */
export function mergeRanges(ranges: GenerationRange[]): GenerationRange[] {
  const out: GenerationRange[] = [];
  for (const range of ranges) {
    const previous = out.at(-1);
    if (previous && previous.entryIndex === range.entryIndex && previous.sectionId === range.sectionId && previous.state === range.state && previous.stageKind === range.stageKind && Math.abs(previous.end - range.start) < 0.001) previous.end = range.end;
    else out.push({ ...range });
  }
  return out;
}

export function readyPercent(ranges: readonly GenerationRange[], duration: number): number {
  return duration > 0 ? Math.min(100, ranges.reduce((sum, r) => sum + (r.state === 'ready' ? r.end - r.start : 0), 0) / duration * 100) : 0;
}
