import { ProviderRegistry, type LLMProvider } from '@lesebuehne/core';
import { AnthropicCompatibleLLM } from '@lesebuehne/llm-anthropic-compatible';
import { ChatGptPlanLLM } from '@lesebuehne/llm-chatgpt-plan';
import { codexCliSource, CodexAuthLLM, openCodeSource, ownSource, type TokenSource } from '@lesebuehne/llm-codex-auth';
import { OpenAICompatibleLLM } from '@lesebuehne/llm-openai-compatible';
import { OpenRouterLLM } from '@lesebuehne/llm-openrouter';
import { join } from 'node:path';
import type { ServerConfig, TaskModels } from './config.ts';

export interface ProviderSetup {
  registry: ProviderRegistry;
  /** The LLM chain in order (registered providers only; the heuristic follows implicitly). */
  chain: string[];
  /** Model override per provider and task. */
  taskModel(providerId: string, task: keyof TaskModels): string | undefined;
  /** Files of the own sign-in flows. */
  files: { codexToken: string; planStore: string };
}

/** A provider that refuses until configured, so it still shows up (with a reason) in status. */
function unconfigured(id: string, label: string, reason: string): LLMProvider {
  return {
    kind: 'llm',
    id,
    label,
    runsIn: ['server', 'browser'],
    capabilities: {},
    isAvailable: async () => ({ ok: false, reason }),
    completeJSON: () => Promise.reject(new Error(reason)),
  };
}

/** Builds the registry from the config. Secrets stay inside the provider objects. */
export function buildProviders(config: ServerConfig, dataDir: string, fetchImpl?: typeof fetch): ProviderSetup {
  const registry = new ProviderRegistry();
  const p = config.providers;
  const files = { codexToken: join(dataDir, 'auth', 'codex-token.json'), planStore: join(dataDir, 'auth', 'chatgpt-plan.json') };
  const tasks = new Map<string, TaskModels | undefined>();
  const f = fetchImpl ? { fetch: fetchImpl } : {};

  if (p['codex-auth'].enabled) {
    const c = p['codex-auth'];
    const sources: TokenSource[] = c.sources.map((s) =>
      s === 'opencode' ? openCodeSource() : s === 'codex-cli' ? codexCliSource() : ownSource(files.codexToken, f),
    );
    registry.register(
      new CodexAuthLLM({
        model: c.model,
        sources,
        ...(c.reasoningEffort ? { reasoningEffort: c.reasoningEffort } : {}),
        ...(c.originator ? { originator: c.originator } : {}),
        ...f,
      }),
    );
    tasks.set('codex-auth', c.models);
  }
  if (p['chatgpt-plan'].enabled) {
    registry.register(new ChatGptPlanLLM({ storeFile: files.planStore, model: p['chatgpt-plan'].model, ...f }));
    tasks.set('chatgpt-plan', p['chatgpt-plan'].models);
  }
  if (p.openrouter.enabled) {
    const o = p.openrouter;
    registry.register(
      o.apiKey && o.model
        ? new OpenRouterLLM({ apiKey: o.apiKey, model: o.model, ...(o.maxCallsPerDay ? { maxCallsPerDay: o.maxCallsPerDay } : {}), ...f })
        : unconfigured('openrouter', 'OpenRouter', o.apiKey ? 'no model configured' : 'no API key (OPENROUTER_API_KEY)'),
    );
    tasks.set('openrouter', o.models);
  }
  if (p['anthropic-compatible'].enabled) {
    const a = p['anthropic-compatible'];
    registry.register(
      a.apiKey && a.model
        ? new AnthropicCompatibleLLM({ apiKey: a.apiKey, model: a.model, ...(a.baseURL ? { baseURL: a.baseURL } : {}), ...f })
        : unconfigured('anthropic-compatible', 'Anthropic-compatible', a.apiKey ? 'no model configured' : 'no API key (ANTHROPIC_API_KEY)'),
    );
    tasks.set('anthropic-compatible', a.models);
  }
  for (const o of p['openai-compatible']) {
    registry.register(new OpenAICompatibleLLM({ id: o.id, baseURL: o.baseURL, model: o.model, ...(o.apiKey ? { apiKey: o.apiKey } : {}), ...f }));
    tasks.set(o.id, o.models);
  }

  // Configured chain first, then any other registered LLM (e.g. extra openai-compatible instances).
  const registered = registry.list('llm').map((x) => x.id);
  const chain = [...config.llm.chain.filter((id) => registered.includes(id)), ...registered.filter((id) => !config.llm.chain.includes(id))];
  return { registry, chain, taskModel: (id, task) => tasks.get(id)?.[task], files };
}
