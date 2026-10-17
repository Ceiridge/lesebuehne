/** Minimum time a visual stays on stage, in milliseconds of playback (B9). */
export const MIN_DWELL_MS = 8000;

export interface StageFrame {
  /** Section whose visual is on stage. */
  current: string | null;
  /** Section whose visual is fading out, during a crossfade. */
  previous: string | null;
  /** Crossfade progress 0 … 1 (1 = only `current` visible). */
  fade: number;
}

/**
 * Decides which section's visual is on stage (B9). A new section's visual replaces the current one
 * only after the current one has been on stage for 8 s of **wall-clock playing time** (paused
 * time does not count, tempo does not matter); user navigation switches at once. Changes
 * crossfade over `crossfadeMs` of wall-clock time.
 */
export class StageScheduler {
  private current: string | null = null;
  private previous: string | null = null;
  private fadeStart = -Infinity;
  private onStageMs = 0;
  private lastNow: number | undefined;
  crossfadeMs: number;
  readonly minDwellMs: number;

  constructor(options: { crossfadeMs: number; minDwellMs?: number }) {
    this.crossfadeMs = options.crossfadeMs;
    this.minDwellMs = options.minDwellMs ?? MIN_DWELL_MS;
  }

  private show(sectionId: string, now: number, fade: boolean): void {
    if (sectionId === this.current) return;
    this.previous = fade ? this.current : null;
    this.current = sectionId;
    this.fadeStart = now;
    this.onStageMs = 0;
  }

  /** The visual on stage (null before the first tick). */
  get currentId(): string | null {
    return this.current;
  }

  /** User navigation (jump, TOC, timeline): switch now. */
  navigate(sectionId: string, now: number): StageFrame {
    this.lastNow = now;
    this.show(sectionId, now, this.current !== null);
    return this.frame(now);
  }

  /** Called every frame with the section under the playhead. */
  tick(wanted: string, now: number, playing: boolean): StageFrame {
    if (playing && this.lastNow !== undefined) this.onStageMs += Math.max(0, now - this.lastNow);
    this.lastNow = now;
    if (this.current === null) this.show(wanted, now, false);
    else if (wanted !== this.current && this.onStageMs >= this.minDwellMs) this.show(wanted, now, true);
    return this.frame(now);
  }

  private frame(now: number): StageFrame {
    const fade = this.crossfadeMs <= 0 || this.previous === null ? 1 : Math.min(1, (now - this.fadeStart) / this.crossfadeMs);
    if (fade >= 1) this.previous = null;
    return { current: this.current, previous: this.previous, fade };
  }
}
