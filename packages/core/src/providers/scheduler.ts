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

export class JobQueue {
  private readonly entries = new Map<string, Entry>();
  private running = 0;
  private seq = 0;

  constructor(private readonly concurrency = 2) {}

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

  get size(): number {
    return this.entries.size;
  }

  cancel(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.ctrl.abort();
    if (!e.running) {
      this.entries.delete(key);
      e.reject(new DOMException('aborted', 'AbortError'));
    }
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
          this.entries.delete(next.job.key);
          this.pump();
        });
    }
  }
}
