/**
 * @lesebuehne/llm-codex-auth — ChatGPT-plan access through the Codex backend, the way OpenCode's
 * Codex sign-in does it: `POST /backend-api/codex/responses` with bearer token, account id,
 * originator and session headers, `store:false`, `stream:true`. Server-only.
 *
 * Token sources, in order and each optional: OpenCode (read-only), Codex CLI (read-only), own
 * sign-in (refreshed by us). An expired read-only token is reported, never refreshed.
 */
import {
  completeWithRepair,
  effortFor,
  jsonSchemaOf,
  ProviderError,
  readSse,
  request,
  type Availability,
  type FetchLike,
  type LLMProvider,
  type LLMRequest,
  type LLMResult,
  type ModelOption,
  type Usage,
} from '@lesebuehne/core';
import { codexCliSource, openCodeSource, ownSource, type CodexToken, type TokenSource } from './sources.ts';

export { codexCliSource, defaultPaths, openCodeSource, ownSource, CODEX_CLIENT_ID, type CodexToken, type TokenSource } from './sources.ts';
export { startCodexLogin, codexAuthorizeUrl, CODEX_REDIRECT, pkce, type LoginSession } from './login.ts';
export { accountIdFrom, jwtClaims, jwtExpiry } from './jwt.ts';

export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
/** Client version sent with the model list request. */
export const CODEX_CLIENT_VERSION = '0.162.1';
export const DEFAULT_ORIGINATOR = 'lesebuehne';
/** A token with less life left than this counts as expired. */
const EXPIRY_MARGIN_MS = 60_000;

export interface CodexAuthConfig {
  id?: string;
  /** `auto` = first model the backend lists; or a model slug. */
  model?: string;
  /** Source order; defaults to OpenCode, Codex CLI, own sign-in. */
  sources?: TokenSource[];
  /** Own sign-in token file (enables the own source). */
  ownTokenFile?: string;
  /** Optional reasoning effort for supporting models (`low` | `medium` | `high`). */
  reasoningEffort?: string;
  /** `originator` header identifying the client to the backend. */
  originator?: string;
  baseURL?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
  now?: () => number;
}

/** The parts of a Codex catalog entry the player uses (`GET /models`). */
interface ModelInfo {
  slug: string;
  visibility?: string;
  display_name?: string;
  description?: string | null;
  default_reasoning_level?: string | null;
  supported_reasoning_levels?: Array<{ effort: string; description?: string }>;
  service_tiers?: Array<{ id: string; name: string; description?: string }>;
  /** Deprecated catalog field: `fast` means the `priority` tier. */
  additional_speed_tiers?: string[];
  default_service_tier?: string | null;
}

function toOption(m: ModelInfo): ModelOption {
  const tiers = [...(m.service_tiers ?? [])];
  if (m.additional_speed_tiers?.includes('fast') && !tiers.some((t) => t.id === 'priority')) tiers.push({ id: 'priority', name: 'Fast' });
  return {
    id: m.slug,
    name: m.display_name || m.slug,
    ...(m.description ? { description: m.description } : {}),
    reasoningLevels: (m.supported_reasoning_levels ?? []).map((l) => ({ effort: l.effort, ...(l.description ? { description: l.description } : {}) })),
    ...(m.default_reasoning_level ? { defaultReasoning: m.default_reasoning_level } : {}),
    serviceTiers: tiers,
    ...(m.default_service_tier ? { defaultServiceTier: m.default_service_tier } : {}),
  };
}

export class CodexAuthLLM implements LLMProvider {
  readonly kind = 'llm' as const;
  readonly id: string;
  readonly label = 'ChatGPT via Codex (OpenCode / Codex CLI / own sign-in)';
  readonly runsIn = ['server'] as const;
  readonly capabilities = { jsonSchema: true, streaming: true };
  readonly limits = { concurrency: 2, minIntervalMs: 250 };
  readonly costHint = 'subscription' as const;
  readonly sources: TokenSource[];
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private models?: { at: number; list: ModelInfo[] };
  /** Which source produced the last usable token (status display). */
  lastSource?: TokenSource['id'];

  constructor(private readonly config: CodexAuthConfig = {}) {
    this.id = config.id ?? 'codex-auth';
    this.sources = config.sources ?? [openCodeSource(), codexCliSource(), ...(config.ownTokenFile ? [ownSource(config.ownTokenFile)] : [])];
    this.fetchImpl = config.fetch ?? ((u, i) => fetch(u, i));
    this.now = config.now ?? Date.now;
  }

  private base(): string {
    return (this.config.baseURL ?? CODEX_BASE_URL).replace(/\/+$/u, '');
  }

  /** The first valid token across the sources; refreshes only the own source. */
  async token(signal?: AbortSignal): Promise<{ token: CodexToken; source: TokenSource } | { reason: string }> {
    const reasons: string[] = [];
    for (const source of this.sources) {
      let token: CodexToken | undefined;
      try {
        token = await source.load();
      } catch (e) {
        reasons.push(`${source.label}: ${(e as Error).message}`);
        continue;
      }
      if (!token) continue;
      if (token.expires - EXPIRY_MARGIN_MS > this.now()) {
        this.lastSource = source.id;
        return { token, source };
      }
      if (!source.readOnly && source.refresh) {
        const fresh = await source.refresh(signal).catch(() => undefined);
        if (fresh && fresh.expires - EXPIRY_MARGIN_MS > this.now()) {
          this.lastSource = source.id;
          return { token: fresh, source };
        }
        reasons.push(`${source.label}: refresh failed — sign in again`);
      } else {
        reasons.push(`${source.label}: token expired — open ${source.id === 'opencode' ? 'OpenCode' : 'Codex'} once to renew it`);
      }
    }
    return { reason: reasons.length > 0 ? reasons.join('; ') : 'no ChatGPT sign-in found (OpenCode, Codex CLI or own sign-in)' };
  }

  async isAvailable(): Promise<Availability> {
    const t = await this.token();
    return 'reason' in t ? { ok: false, reason: t.reason } : { ok: true };
  }

  private headers(token: CodexToken): Record<string, string> {
    return {
      authorization: `Bearer ${token.access}`,
      'chatgpt-account-id': token.accountId,
      originator: this.config.originator ?? DEFAULT_ORIGINATOR,
      'session-id': crypto.randomUUID(),
    };
  }

  /** Request headers with a valid token (for other Codex-backend features, e.g. images). */
  async authHeaders(signal?: AbortSignal): Promise<Record<string, string>> {
    const t = await this.token(signal);
    if ('reason' in t) throw new ProviderError(this.id, 'unavailable', t.reason);
    return this.headers(t.token);
  }

  /** Absolute URL of a backend path (`/responses` …). */
  endpoint(path: string): string {
    return `${this.base()}${path}`;
  }

  /** Models for the picker: name, reasoning levels and speed tiers from the catalog. */
  async listModels(signal: AbortSignal): Promise<ModelOption[]> {
    return (await this.catalog(signal)).map(toOption);
  }

  /** Models from the backend's list (visibility `list`), cached for 10 minutes. */
  async catalog(signal: AbortSignal): Promise<ModelInfo[]> {
    if (this.models && this.now() - this.models.at < 600_000) return this.models.list;
    const t = await this.token(signal);
    if ('reason' in t) throw new ProviderError(this.id, 'unavailable', t.reason);
    const res = await request(this.id, this.fetchImpl, `${this.base()}/models?client_version=${CODEX_CLIENT_VERSION}`, {
      signal,
      headers: this.headers(t.token),
      timeoutMs: 20_000,
    });
    const json = (await res.json()) as { models?: ModelInfo[]; data?: ModelInfo[] };
    const list = (json.models ?? json.data ?? []).filter((m) => m.slug && (m.visibility ?? 'list') === 'list');
    this.models = { at: this.now(), list };
    return list;
  }

  private async resolveModel(req: LLMRequest<unknown>, signal: AbortSignal): Promise<string> {
    const wanted = req.model ?? this.config.model ?? 'auto';
    if (wanted !== 'auto') return wanted;
    const first = (await this.catalog(signal))[0]?.slug;
    if (!first) throw new ProviderError(this.id, 'unavailable', 'the Codex backend lists no models for this account');
    return first;
  }

  async completeJSON<T>(req: LLMRequest<T>): Promise<LLMResult<T>> {
    const model = await this.resolveModel(req as LLMRequest<unknown>, req.signal);
    const format = { type: 'json_schema', name: req.schemaName, strict: true, schema: jsonSchemaOf(req.schema) };
    // Send only what this model accepts: its reasoning levels and catalog tiers (flex always works).
    const info = await this.catalog(req.signal).then((list) => list.find((m) => m.slug === model), () => undefined);
    const option = info ? toOption(info) : undefined;
    const levels = option?.reasoningLevels?.length ? option.reasoningLevels.map((l) => l.effort) : this.config.reasoningEffort ? [this.config.reasoningEffort] : [];
    const effort = effortFor(req.reasoningEffort ?? this.config.reasoningEffort, req.task, levels);
    const tier = req.serviceTier && (req.serviceTier === 'flex' || option?.serviceTiers?.some((t) => t.id === req.serviceTier)) ? req.serviceTier : undefined;
    return completeWithRepair(this.id, req, async (turns, signal) => {
      const t = await this.token(signal);
      if ('reason' in t) throw new ProviderError(this.id, 'unavailable', t.reason);
      const res = await request(this.id, this.fetchImpl, `${this.base()}/responses`, {
        method: 'POST',
        signal,
        timeoutMs: this.config.timeoutMs ?? 180_000,
        headers: { ...this.headers(t.token), 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({
          model,
          instructions: req.system,
          input: turns.map((x) => ({
            role: x.role,
            content: [{ type: x.role === 'user' ? 'input_text' : 'output_text', text: x.content }],
          })),
          store: false,
          stream: true,
          text: { format },
          ...(effort ? { reasoning: { effort } } : {}),
          ...(tier ? { service_tier: tier } : {}),
        }),
      });
      if (!res.body) throw new ProviderError(this.id, 'server', 'empty response');
      let text = '';
      let usage: Usage | undefined;
      let answeredModel = model;
      for await (const ev of readSse(res.body)) {
        if (ev.data === '[DONE]') break;
        let data: { type?: string; delta?: string; response?: { model?: string; output?: unknown; usage?: { input_tokens?: number; output_tokens?: number }; error?: { code?: string; message?: string } } };
        try {
          data = JSON.parse(ev.data);
        } catch {
          continue;
        }
        const type = data.type ?? ev.event;
        if (type === 'response.output_text.delta' && typeof data.delta === 'string') text += data.delta;
        else if (type === 'response.completed') {
          answeredModel = data.response?.model ?? model;
          usage = { inputTokens: data.response?.usage?.input_tokens ?? 0, outputTokens: data.response?.usage?.output_tokens ?? 0 };
          if (!text) text = outputText(data.response?.output);
        } else if (type === 'response.failed' || type === 'response.incomplete' || type === 'error') {
          const err = data.response?.error;
          const message = err?.message ?? err?.code ?? type;
          const limited = /limit|quota|rate/iu.test(`${err?.code ?? ''} ${message}`);
          throw new ProviderError(this.id, limited ? 'rate-limit' : 'server', `Codex backend: ${message}`, limited ? { retryAt: this.now() + 15 * 60_000 } : {});
        }
      }
      return { text, model: answeredModel, ...(usage ? { usage } : {}) };
    });
  }
}

function outputText(output: unknown): string {
  if (!Array.isArray(output)) return '';
  return output
    .flatMap((o: { content?: Array<{ text?: string }> }) => o.content ?? [])
    .map((c) => c.text ?? '')
    .join('');
}

export { CodexImageProvider, type CodexImageConfig } from './image.ts';

export default function create(config: CodexAuthConfig = {}): CodexAuthLLM {
  return new CodexAuthLLM(config);
}
