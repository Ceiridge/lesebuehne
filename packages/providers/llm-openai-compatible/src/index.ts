/**
 * @lesebuehne/llm-openai-compatible — any OpenAI-compatible chat-completions endpoint (OpenAI,
 * Ollama, LM Studio, vLLM, OpenRouter …). Structured output degrades gracefully:
 * `json_schema` (strict) → `json_object` → prompt-only, remembered per instance.
 */
import {
  completeWithRepair,
  jsonSchemaOf,
  ProviderError,
  request,
  schemaInstruction,
  type Availability,
  type CostHint,
  type FetchLike,
  type LLMProvider,
  type LLMRequest,
  type LLMResult,
  type ModelOption,
  type RunsIn,
  type Usage,
} from '@lesebuehne/core';

export type JsonMode = 'auto' | 'schema' | 'object' | 'prompt';

export interface OpenAICompatibleConfig {
  id: string;
  label?: string;
  /** e.g. `https://api.openai.com/v1`, `http://127.0.0.1:11434/v1` (Ollama). */
  baseURL: string;
  model?: string;
  apiKey?: string;
  /** Extra headers (OpenRouter attribution …). */
  headers?: Record<string, string>;
  jsonMode?: JsonMode;
  timeoutMs?: number;
  runsIn?: readonly RunsIn[];
  costHint?: CostHint;
  concurrency?: number;
  /** A key is required (cloud endpoints); local servers need none. */
  requiresKey?: boolean;
  /** Optional extra body fields (temperature …). */
  body?: Record<string, unknown>;
  fetch?: FetchLike;
}

const LEVELS: readonly Exclude<JsonMode, 'auto'>[] = ['schema', 'object', 'prompt'];

export class OpenAICompatibleLLM implements LLMProvider {
  readonly kind = 'llm' as const;
  readonly id: string;
  readonly label: string;
  readonly runsIn: readonly RunsIn[];
  readonly capabilities: Record<string, boolean | string | number>;
  readonly limits: { concurrency: number };
  readonly costHint: CostHint;
  private level: Exclude<JsonMode, 'auto'>;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.id = config.id;
    this.label = config.label ?? config.id;
    this.runsIn = config.runsIn ?? ['server', 'browser'];
    this.costHint = config.costHint ?? 'metered';
    this.limits = { concurrency: config.concurrency ?? 2 };
    this.level = !config.jsonMode || config.jsonMode === 'auto' ? 'schema' : config.jsonMode;
    this.capabilities = { jsonSchema: this.level === 'schema', streaming: false };
    this.fetchImpl = config.fetch ?? ((u, i) => fetch(u, i));
  }

  get model(): string | undefined {
    return this.config.model;
  }

  async isAvailable(): Promise<Availability> {
    if (!this.config.baseURL) return { ok: false, reason: 'no base URL configured' };
    if (!this.config.model) return { ok: false, reason: 'no model configured' };
    if ((this.config.requiresKey ?? false) && !this.config.apiKey) return { ok: false, reason: 'no API key configured' };
    return { ok: true };
  }

  private url(path: string): string {
    return `${this.config.baseURL.replace(/\/+$/u, '')}${path}`;
  }

  private async chat<T>(req: LLMRequest<T>, messages: Array<{ role: string; content: string }>, signal: AbortSignal) {
    const model = req.model ?? this.config.model;
    if (!model) throw new ProviderError(this.id, 'unavailable', 'no model configured');
    const format =
      this.level === 'schema'
        ? { response_format: { type: 'json_schema', json_schema: { name: req.schemaName, strict: true, schema: jsonSchemaOf(req.schema) } } }
        : this.level === 'object'
          ? { response_format: { type: 'json_object' } }
          : {};
    const system = this.level === 'schema' ? req.system : `${req.system}\n\n${schemaInstruction(req.schema, req.schemaName)}`;
    const res = await request(this.id, this.fetchImpl, this.url('/chat/completions'), {
      method: 'POST',
      signal,
      ...(this.config.timeoutMs !== undefined ? { timeoutMs: this.config.timeoutMs } : {}),
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        ...this.config.headers,
      },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, ...messages], ...format, ...this.config.body }),
    });
    const json = (await res.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string | null; refusal?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const message = json.choices?.[0]?.message;
    if (message?.refusal) throw new ProviderError(this.id, 'invalid-output', `model refused: ${message.refusal}`);
    const usage: Usage = {
      ...(json.usage?.prompt_tokens !== undefined ? { inputTokens: json.usage.prompt_tokens } : {}),
      ...(json.usage?.completion_tokens !== undefined ? { outputTokens: json.usage.completion_tokens } : {}),
      ...(json.usage?.cost !== undefined ? { cost: json.usage.cost } : {}),
    };
    return { text: message?.content ?? '', model: json.model ?? model, usage };
  }

  /** `GET {baseURL}/models` (OpenAI, OpenRouter, Ollama, LM Studio …), sorted by name. */
  async listModels(signal: AbortSignal): Promise<ModelOption[]> {
    const res = await request(this.id, this.fetchImpl, this.url('/models'), {
      signal,
      timeoutMs: 20_000,
      headers: { ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}), ...this.config.headers },
    });
    const json = (await res.json()) as { data?: Array<{ id?: string; name?: string; description?: string }> };
    return (json.data ?? [])
      .filter((m): m is { id: string; name?: string; description?: string } => typeof m.id === 'string')
      .map((m) => ({ id: m.id, name: m.name || m.id, ...(m.description ? { description: m.description.slice(0, 200) } : {}) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async completeJSON<T>(req: LLMRequest<T>): Promise<LLMResult<T>> {
    for (;;) {
      try {
        return await completeWithRepair(this.id, req, (turns, signal) => this.chat(req, turns, signal));
      } catch (e) {
        // The endpoint does not support this structured-output level: step down once and retry.
        const unsupported = e instanceof ProviderError && e.code === 'bad-request' && /response_format|json_schema|json_object|structured/iu.test(e.message);
        const next = LEVELS[LEVELS.indexOf(this.level) + 1];
        if (!unsupported || !next) throw e;
        this.level = next;
        this.capabilities.jsonSchema = next === 'schema';
      }
    }
  }
}

export default function create(config: OpenAICompatibleConfig): OpenAICompatibleLLM {
  return new OpenAICompatibleLLM(config);
}

/** Preset for a local Ollama server (no key, OpenAI-compatible API on port 11434). */
export function ollama(o: { model?: string; baseURL?: string; id?: string } = {}): OpenAICompatibleLLM {
  return new OpenAICompatibleLLM({
    id: o.id ?? 'ollama',
    label: 'Ollama (local)',
    baseURL: o.baseURL ?? 'http://127.0.0.1:11434/v1',
    ...(o.model ? { model: o.model } : {}),
    jsonMode: 'auto',
    costHint: 'free',
    concurrency: 1,
    timeoutMs: 300_000,
  });
}
