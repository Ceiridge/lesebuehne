/**
 * @lesebuehne/llm-openrouter — OpenRouter as an OpenAI-compatible preset (always offered as a
 * fallback). Needs a key and an explicit model; an optional daily call cap protects the budget.
 */
import { ProviderError, type Availability, type FetchLike, type LLMRequest, type LLMResult } from '@lesebuehne/core';
import { OpenAICompatibleLLM } from '@lesebuehne/llm-openai-compatible';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface OpenRouterConfig {
  id?: string;
  apiKey?: string;
  model?: string;
  /** Maximum calls per local day (undefined = unlimited). */
  maxCallsPerDay?: number;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
}

export class OpenRouterLLM extends OpenAICompatibleLLM {
  private day = '';
  private calls = 0;

  constructor(private readonly o: OpenRouterConfig) {
    super({
      id: o.id ?? 'openrouter',
      label: 'OpenRouter',
      baseURL: OPENROUTER_BASE_URL,
      ...(o.model ? { model: o.model } : {}),
      ...(o.apiKey ? { apiKey: o.apiKey } : {}),
      requiresKey: true,
      // Attribution headers (no personal data); `usage.include` makes OpenRouter report cost.
      headers: { 'X-Title': 'Lesebuehne', 'HTTP-Referer': 'https://lesebuehne.local' },
      body: { usage: { include: true } },
      jsonMode: 'auto',
      costHint: 'metered',
      ...(o.fetch ? { fetch: o.fetch } : {}),
      ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
    });
  }

  override async isAvailable(): Promise<Availability> {
    const base = await super.isAvailable();
    if (!base.ok) return base;
    if (this.capReached()) return { ok: false, reason: `daily cap of ${this.o.maxCallsPerDay} calls reached` };
    return { ok: true };
  }

  private capReached(): boolean {
    const today = (this.o.now?.() ?? new Date()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.calls = 0;
    }
    return this.o.maxCallsPerDay !== undefined && this.calls >= this.o.maxCallsPerDay;
  }

  override async completeJSON<T>(req: LLMRequest<T>): Promise<LLMResult<T>> {
    if (this.capReached()) throw new ProviderError(this.id, 'rate-limit', 'daily call cap reached', { retryAt: Date.now() + 3_600_000 });
    this.calls++;
    return super.completeJSON(req);
  }
}

export default function create(config: OpenRouterConfig): OpenRouterLLM {
  return new OpenRouterLLM(config);
}
