import type { Timers } from '../../src/engine/voices.ts';

/** Deterministic timers: time moves only through `advance`. */
export class FakeTimers implements Timers {
  private t = 0;
  private seq = 0;
  private readonly due = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.due.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(id: unknown): void {
    this.due.delete(id as number);
  }
  /** Moves time forward, running due timers in order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.due) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.due.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
  }
  get pending(): number {
    return this.due.size;
  }
}
