/**
 * Priority job queue (brief §8.2/8.3), shared by browser and server. Jobs have a key (dedupe),
 * a priority (lower runs first) and are abortable. `retain(keys)` aborts every queued or running
 * job that is no longer wanted, e.g. after a jump.
 */
export interface Job<R> {
  key: string;
  priority: number;
  run(signal: AbortSignal): Promise<R>;
}

interface Entry {
  job: Job<unknown>;
  ctrl: AbortController;
  promise: Promise<unknown>;
  resolve(v: unknown): void;
  reject(e: unknown): void;
  running: boolean;
  seq: number;
}

export interface QueueSnapshot {
  concurrency: number;
  /** Keys of running jobs. */
  running: string[];
  /** Keys of waiting jobs, next first. */
  queued: string[];
}

export class JobQueue {
  private readonly entries = new Map<string, Entry>();
  private running = 0;
  private seq = 0;

  constructor(private concurrency = 2) {}

  setConcurrency(value: number): void {
    if (!Number.isFinite(value) || value < 1) return;
    this.concurrency = Math.floor(value);
    this.pump();
  }

  /** Adds a job, or returns the pending promise of the same key (priority raised if lower). */
  enqueue<R>(job: Job<R>): Promise<R> {
    const existing = this.entries.get(job.key);
    if (existing) {
      if (job.priority < existing.job.priority) existing.job = { ...existing.job, priority: job.priority };
      return existing.promise as Promise<R>;
    }
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => undefined);
    this.entries.set(job.key, { job: job as Job<unknown>, ctrl: new AbortController(), promise, resolve, reject, running: false, seq: this.seq++ });
    queueMicrotask(() => this.pump());
    return promise as Promise<R>;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Reorder pending work after the playhead moves, in either direction. */
  prioritize(key: string, priority: number): void {
    const entry = this.entries.get(key);
    if (entry && !entry.running) entry.job = { ...entry.job, priority };
  }

  get size(): number {
    return this.entries.size;
  }

  /** What runs and how much waits (for status displays). */
  snapshot(): QueueSnapshot {
    const all = [...this.entries.values()];
    return {
      concurrency: this.concurrency,
      running: all.filter((e) => e.running).map((e) => e.job.key),
      queued: all.filter((e) => !e.running).sort((a, b) => a.job.priority - b.job.priority || a.seq - b.seq).map((e) => e.job.key),
    };
  }

  cancel(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.ctrl.abort();
    this.entries.delete(key);
    e.reject(new DOMException('aborted', 'AbortError'));
  }

  /** Aborts every job whose key is not in `keep`. */
  retain(keep: ReadonlySet<string>): void {
    for (const key of [...this.entries.keys()]) if (!keep.has(key)) this.cancel(key);
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const next = [...this.entries.values()]
        .filter((e) => !e.running)
        .sort((a, b) => a.job.priority - b.job.priority || a.seq - b.seq)[0];
      if (!next) return;
      next.running = true;
      this.running++;
      next.job
        .run(next.ctrl.signal)
        .then(next.resolve, next.reject)
        .finally(() => {
          this.running--;
          if (this.entries.get(next.job.key) === next) this.entries.delete(next.job.key);
          this.pump();
        });
    }
  }
}

/** Pause a group for maintenance, abort and drain existing work before changing its storage. */
export class TaskGroup {
  private controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private paused = false;

  run<T>(signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.paused) return Promise.reject(new DOMException('maintenance', 'AbortError'));
    const joined = AbortSignal.any([signal, this.controller.signal]);
    const p = Promise.resolve().then(() => { joined.throwIfAborted(); return task(joined); });
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p)).catch(() => undefined);
    return p;
  }

  async maintain(task: () => Promise<void>): Promise<void> {
    if (this.paused) throw new Error('maintenance already running');
    this.paused = true;
    this.controller.abort();
    try {
      await Promise.allSettled([...this.pending]);
      await task();
    } finally {
      this.controller = new AbortController();
      this.paused = false;
    }
  }
}
