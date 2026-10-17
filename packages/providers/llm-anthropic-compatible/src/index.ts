/**
 * @lesebuehne/llm-anthropic-compatible — Anthropic Messages API (or a compatible endpoint).
 * Structured output via one forced tool call whose input schema is the result schema.
 */
import {
  completeWithRepair,
  jsonSchemaOf,
  ProviderError,
  request,
  type Availability,
  type FetchLike,
  type LLMProvider,
  type LLMRequest,
  type LLMResult,
  type RunsIn,
} from '@lesebuehne/core';

export interface AnthropicConfig {
  id?: string;
  label?: string;
  baseURL?: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  /** Set when calling from a browser (BYOK): adds the direct-browser-access header. */
  browser?: boolean;
  timeoutMs?: number;
  fetch?: FetchLike;
}

export class AnthropicCompatibleLLM implements LLMProvider {
  readonly kind = 'llm' as const;
  readonly id: string;
  readonly label: string;
  readonly runsIn: readonly RunsIn[] = ['server', 'browser'];
  readonly capabilities = { jsonSchema: true, streaming: false };
  readonly limits = { concurrency: 2 };
  readonly costHint = 'metered' as const;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: AnthropicConfig) {
    this.id = config.id ?? 'anthropic';
    this.label = config.label ?? 'Anthropic';
    this.fetchImpl = config.fetch ?? ((u, i) => fetch(u, i));
  }

  async isAvailable(): Promise<Availability> {
    if (!this.config.apiKey) return { ok: false, reason: 'no API key configured' };
    if (!this.config.model) return { ok: false, reason: 'no model configured' };
    return { ok: true };
  }

  async completeJSON<T>(req: LLMRequest<T>): Promise<LLMResult<T>> {
    const model = req.model ?? this.config.model;
    if (!model) throw new ProviderError(this.id, 'unavailable', 'no model configured');
    const tool = { name: req.schemaName, description: 'Return the result.', input_schema: jsonSchemaOf(req.schema) };
    return completeWithRepair(this.id, req, async (turns, signal) => {
      const res = await request(this.id, this.fetchImpl, `${(this.config.baseURL ?? 'https://api.anthropic.com').replace(/\/+$/u, '')}/v1/messages`, {
        method: 'POST',
        signal,
        ...(this.config.timeoutMs !== undefined ? { timeoutMs: this.config.timeoutMs } : {}),
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.config.apiKey ?? '',
          'anthropic-version': '2023-06-01',
          ...(this.config.browser ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}),
        },
        body: JSON.stringify({
          model,
          max_tokens: this.config.maxTokens ?? 4096,
          system: req.system,
          messages: turns.map((t) => ({ role: t.role, content: t.content })),
          tools: [tool],
          tool_choice: { type: 'tool', name: tool.name },
        }),
      });
      const json = (await res.json()) as {
        model?: string;
        content?: Array<{ type: string; input?: unknown; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const call = json.content?.find((c) => c.type === 'tool_use');
      const text = call ? JSON.stringify(call.input) : (json.content?.find((c) => c.type === 'text')?.text ?? '');
      return {
        text,
        model: json.model ?? model,
        usage: { inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 },
      };
    });
  }
}

export default function create(config: AnthropicConfig): AnthropicCompatibleLLM {
  return new AnthropicCompatibleLLM(config);
}
