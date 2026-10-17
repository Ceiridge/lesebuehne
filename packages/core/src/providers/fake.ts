import { ProviderError, type ProviderErrorCode } from './errors.ts';
import { completeWithRepair } from './llm-base.ts';
import type { Availability, LLMProvider, LLMRequest, LLMResult } from './types.ts';

/**
 * Deterministic fake LLM for tests (brief §11): answers come from a script (texts or functions of
 * the request); errors can be injected. No network.
 */
export interface FakeLLMOptions {
  id?: string;
  answers: Array<string | ((req: LLMRequest<unknown>, turn: number) => string) | { error: ProviderErrorCode; retryAt?: number }>;
  available?: Availability;
  model?: string;
}

export class FakeLLM implements LLMProvider {
  readonly kind = 'llm' as const;
  readonly id: string;
  readonly label = 'Fake LLM';
  readonly runsIn = ['browser', 'server'] as const;
  readonly capabilities = { jsonSchema: true };
  readonly costHint = 'free' as const;
  readonly requests: Array<{ system: string; turns: number; user: string }> = [];
  private next = 0;

  constructor(private readonly o: FakeLLMOptions) {
    this.id = o.id ?? 'fake-llm';
  }

  async isAvailable(): Promise<Availability> {
    return this.o.available ?? { ok: true };
  }

  completeJSON<T>(req: LLMRequest<T>): Promise<LLMResult<T>> {
    return completeWithRepair(this.id, req, async (turns, signal) => {
      if (signal.aborted) throw new ProviderError(this.id, 'aborted', 'aborted');
      this.requests.push({ system: req.system, turns: turns.length, user: turns[0]?.content ?? '' });
      const a = this.o.answers[Math.min(this.next, this.o.answers.length - 1)];
      this.next++;
      if (a === undefined) throw new ProviderError(this.id, 'server', 'no scripted answer');
      if (typeof a === 'object') throw new ProviderError(this.id, a.error, `scripted ${a.error}`, a.retryAt !== undefined ? { retryAt: a.retryAt } : {});
      const text = typeof a === 'function' ? a(req as LLMRequest<unknown>, turns.length) : a;
      return { text, model: this.o.model ?? 'fake-model', usage: { inputTokens: 10, outputTokens: 5 } };
    });
  }
}
