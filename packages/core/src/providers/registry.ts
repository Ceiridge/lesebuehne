import { isAbort, ProviderError } from './errors.ts';
import type { AnyProvider, Availability, ProviderKind, Usage } from './types.ts';

export interface ProviderStats {
  calls: number;
  ok: number;
  errors: number;
  rateLimits: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  lastError?: string;
  lastErrorAt?: number;
  /** Skipped by chains until then (rate limit / repeated failures). */
  coolingUntil?: number;
}

export interface ChainAttempt {
  providerId: string;
  outcome: 'ok' | 'skipped' | 'failed';
  reason?: string;
  ms?: number;
}

export interface ChainResult<R> {
  value: R;
  providerId: string;
  attempts: ChainAttempt[];
}

export class ChainExhaustedError extends Error {
  constructor(readonly kind: ProviderKind, readonly attempts: ChainAttempt[]) {
    super(`no ${kind} provider succeeded: ${attempts.map((a) => `${a.providerId} ${a.outcome}${a.reason ? ` (${a.reason})` : ''}`).join('; ')}`);
    this.name = 'ChainExhaustedError';
  }
}

/** Concurrency and minimum spacing per provider. */
class Gate {
  private active = 0;
  private lastStart = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly concurrency: number, private readonly minIntervalMs: number, private readonly now: () => number) {}

  async run<R>(fn: () => Promise<R>, signal: AbortSignal): Promise<R> {
    while (this.active >= this.concurrency) {
      await new Promise<void>((resolve, reject) => {
        const go = (): void => {
          signal.removeEventListener('abort', stop);
          resolve();
        };
        const stop = (): void => {
          const i = this.waiting.indexOf(go);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(new DOMException('aborted', 'AbortError'));
        };
        signal.addEventListener('abort', stop, { once: true });
        this.waiting.push(go);
      });
    }
    this.active++;
    try {
      const wait = this.lastStart + this.minIntervalMs - this.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastStart = this.now();
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

const COOLDOWN_AFTER_FAILURES = 3;
const FAILURE_COOLDOWN_MS = 2 * 60_000;

/**
 * Providers by id and fallback chains (B1). `run` walks a chain: unavailable or cooling-down
 * providers are skipped, failures move on to the next one, aborts stop the walk. Every call is
 * counted per provider.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, AnyProvider>();
  private readonly gates = new Map<string, Gate>();
  private readonly stats = new Map<string, ProviderStats>();
  private readonly failures = new Map<string, number>();
  private readonly availability = new Map<string, { at: number; value: Availability }>();

  constructor(private readonly now: () => number = () => Date.now(), private readonly availabilityTtlMs = 30_000) {}

  register(p: AnyProvider): this {
    this.providers.set(p.id, p);
    this.gates.set(p.id, new Gate(p.limits?.concurrency ?? 2, p.limits?.minIntervalMs ?? 0, this.now));
    this.stats.set(p.id, { calls: 0, ok: 0, errors: 0, rateLimits: 0, inputTokens: 0, outputTokens: 0, cost: 0 });
    return this;
  }

  get<K extends ProviderKind>(id: string, kind?: K): Extract<AnyProvider, { kind: K }> | undefined {
    const p = this.providers.get(id);
    if (!p || (kind && p.kind !== kind)) return undefined;
    return p as Extract<AnyProvider, { kind: K }>;
  }

  list(kind?: ProviderKind): AnyProvider[] {
    return [...this.providers.values()].filter((p) => !kind || p.kind === kind);
  }

  statsOf(id: string): ProviderStats | undefined {
    const s = this.stats.get(id);
    return s ? { ...s } : undefined;
  }

  /** Cached `isAvailable()` (availability checks can read files or call model lists). */
  async available(id: string, fresh = false): Promise<Availability> {
    const p = this.providers.get(id);
    if (!p) return { ok: false, reason: 'unknown provider' };
    const cached = this.availability.get(id);
    if (!fresh && cached && this.now() - cached.at < this.availabilityTtlMs) return cached.value;
    let value: Availability;
    try {
      value = await p.isAvailable();
    } catch (e) {
      value = { ok: false, reason: (e as Error).message };
    }
    this.availability.set(id, { at: this.now(), value });
    return value;
  }

  invalidate(id?: string): void {
    if (id) this.availability.delete(id);
    else this.availability.clear();
  }

  /** Records usage reported by a provider call. */
  addUsage(id: string, usage: Usage | undefined): void {
    const s = this.stats.get(id);
    if (!s || !usage) return;
    s.inputTokens += usage.inputTokens ?? 0;
    s.outputTokens += usage.outputTokens ?? 0;
    s.cost += usage.cost ?? 0;
  }

  async run<K extends ProviderKind, R>(
    kind: K,
    chain: readonly string[],
    call: (provider: Extract<AnyProvider, { kind: K }>, signal: AbortSignal) => Promise<R>,
    signal: AbortSignal,
  ): Promise<ChainResult<R>> {
    const attempts: ChainAttempt[] = [];
    for (const id of chain) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      const p = this.get(id, kind);
      const s = this.stats.get(id);
      if (!p || !s) {
        attempts.push({ providerId: id, outcome: 'skipped', reason: 'not registered' });
        continue;
      }
      if (s.coolingUntil && s.coolingUntil > this.now()) {
        attempts.push({ providerId: id, outcome: 'skipped', reason: `cooling down until ${new Date(s.coolingUntil).toISOString()}` });
        continue;
      }
      const avail = await this.available(id);
      if (!avail.ok) {
        attempts.push({ providerId: id, outcome: 'skipped', reason: avail.reason ?? 'unavailable' });
        continue;
      }
      const started = this.now();
      s.calls++;
      try {
        const value = await this.gates.get(id)!.run(() => call(p, signal), signal);
        s.ok++;
        this.failures.set(id, 0);
        attempts.push({ providerId: id, outcome: 'ok', ms: this.now() - started });
        return { value, providerId: id, attempts };
      } catch (e) {
        if (isAbort(e) || signal.aborted) throw e;
        s.errors++;
        const message = e instanceof Error ? e.message : String(e);
        s.lastError = message;
        s.lastErrorAt = this.now();
        attempts.push({ providerId: id, outcome: 'failed', reason: message, ms: this.now() - started });
        if (e instanceof ProviderError && e.code === 'rate-limit') {
          s.rateLimits++;
          s.coolingUntil = e.retryAt ?? this.now() + 60_000;
        } else if (e instanceof ProviderError && (e.code === 'unavailable' || e.code === 'auth')) {
          this.availability.set(id, { at: this.now(), value: { ok: false, reason: message } });
        } else {
          const n = (this.failures.get(id) ?? 0) + 1;
          this.failures.set(id, n);
          if (n >= COOLDOWN_AFTER_FAILURES) {
            s.coolingUntil = this.now() + FAILURE_COOLDOWN_MS;
            this.failures.set(id, 0);
          }
        }
      }
    }
    throw new ChainExhaustedError(kind, attempts);
  }
}
