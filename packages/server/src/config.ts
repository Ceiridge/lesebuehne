import { join } from 'node:path';

/** Per-task model overrides (e.g. a faster model for plans, a stronger one for the Style Bible). */
export interface TaskModels {
  plan?: string;
  style?: string;
  /** Animation programs (code): often worth a stronger model. */
  animate?: string;
}

export interface TtsConfig {
  id: string;
  /** Preset: `qwentts` (local Qwen3-TTS server), `openai`, or a plain `openai-compatible` endpoint. */
  kind: 'qwentts' | 'openai' | 'openai-compatible';
  baseURL?: string;
  apiKey?: string;
  model?: string;
  /** Voice ids, or `{ id, name, languages }`. */
  voices: Array<string | { id: string; name: string; languages: string[] }>;
  language?: 'none' | 'code' | 'name';
  format?: 'wav' | 'pcm';
  /** Extra body fields (`seed`, `temperature` …). */
  body?: Record<string, unknown>;
}

export interface ImageConfig {
  id: string;
  /** `codex`: the Codex backend's image tool with the codex-auth sign-in (fallback for image-use). */
  kind: 'image-use' | 'codex' | 'openai-compatible';
  /** codex: image model and quality for the tool (omit for the backend default). */
  imageModel?: string;
  quality?: string;
  /** image-use install directory (default `$IMAGE_USE_DIR` or `~/.local/share/image-use`). */
  dir?: string;
  /** image-use interpreter (default `py -3.11 -X utf8` on Windows, `python3 -X utf8` elsewhere). */
  python?: string[];
  baseURL?: string;
  apiKey?: string;
  model?: string;
  body?: Record<string, unknown>;
}

export interface ServerConfig {
  server: {
    port: number;
    /** Extra origins allowed to call the API (same origin is always allowed). */
    origins: string[];
  };
  /** Data directory (cache, books, own tokens). Default: the platform's user data directory. */
  dataDir?: string;
  llm: {
    /** Provider ids in fallback order; the heuristic director always comes last. */
    chain: string[];
  };
  director: {
    budget: { images: number; animations: number };
  };
  images: {
    /** The book's first image is the style reference of the following ones. */
    styleReference: boolean;
  };
  providers: {
    'codex-auth': {
      enabled: boolean;
      /** `auto` = first model the backend lists. */
      model: string;
      models?: TaskModels;
      reasoningEffort?: string;
      originator?: string;
      /** Token sources in order. */
      sources: Array<'opencode' | 'codex-cli' | 'own'>;
    };
    'chatgpt-plan': { enabled: boolean; model: string; models?: TaskModels };
    openrouter: { enabled: boolean; apiKey?: string; model?: string; models?: TaskModels; maxCallsPerDay?: number };
    'anthropic-compatible': { enabled: boolean; baseURL?: string; apiKey?: string; model?: string; models?: TaskModels };
    /** Any number of OpenAI-compatible endpoints (OpenAI, Ollama, LM Studio …). */
    'openai-compatible': Array<{ id: string; baseURL: string; model: string; apiKey?: string; models?: TaskModels }>;
    /** Speech providers (spec 004): a local qwentts.cpp server, OpenAI, or any compatible endpoint. */
    tts: TtsConfig[];
    /** Image providers (spec 005): `image-use` (ChatGPT subscription CLI) or compatible endpoints. */
    images: ImageConfig[];
  };
}

/** Recursive partial for config files. */
export type ConfigInput = {
  [K in keyof ServerConfig]?: ServerConfig[K] extends unknown[] ? ServerConfig[K] : ServerConfig[K] extends object ? DeepPartial<ServerConfig[K]> : ServerConfig[K];
};
type DeepPartial<T> = { [K in keyof T]?: T[K] extends unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

export const defineConfig = (c: ConfigInput): ConfigInput => c;

export const DEFAULT_CONFIG: ServerConfig = {
  server: { port: 8787, origins: [] },
  llm: { chain: ['codex-auth', 'chatgpt-plan', 'openrouter', 'anthropic-compatible'] },
  director: { budget: { images: 2, animations: 3 } },
  images: { styleReference: true },
  providers: {
    'codex-auth': { enabled: true, model: 'auto', sources: ['opencode', 'codex-cli', 'own'] },
    'chatgpt-plan': { enabled: true, model: 'auto' },
    openrouter: { enabled: true },
    'anthropic-compatible': { enabled: true },
    'openai-compatible': [],
    tts: [],
    images: [
      { id: 'image-use', kind: 'image-use' },
      { id: 'codex-image', kind: 'codex' },
    ],
  },
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep merge: objects merge, arrays and scalars replace. */
export function mergeConfig<T>(base: T, over: unknown): T {
  if (!isObject(base) || !isObject(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = v === undefined ? out[k] : mergeConfig(out[k], v);
  return out as T;
}

type Env = Record<string, string | undefined>;

/** Keys and URLs from the environment (never from committed files). */
export function envOverrides(env: Env): ConfigInput {
  const o: ConfigInput = {};
  const providers: Record<string, unknown> = {};
  if (env.LESEBUEHNE_PORT) o.server = { port: Number(env.LESEBUEHNE_PORT) };
  if (env.LESEBUEHNE_DATA_DIR) o.dataDir = env.LESEBUEHNE_DATA_DIR;
  if (env.LESEBUEHNE_LLM_CHAIN) o.llm = { chain: env.LESEBUEHNE_LLM_CHAIN.split(',').map((s) => s.trim()).filter(Boolean) };
  if (env.OPENROUTER_API_KEY || env.OPENROUTER_MODEL) {
    providers.openrouter = { ...(env.OPENROUTER_API_KEY ? { apiKey: env.OPENROUTER_API_KEY } : {}), ...(env.OPENROUTER_MODEL ? { model: env.OPENROUTER_MODEL } : {}) };
  }
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_MODEL || env.ANTHROPIC_BASE_URL) {
    providers['anthropic-compatible'] = {
      ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
      ...(env.ANTHROPIC_MODEL ? { model: env.ANTHROPIC_MODEL } : {}),
      ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
    };
  }
  if (env.TTS_BASE_URL || env.TTS_VOICES) {
    const kind = (env.TTS_KIND ?? 'qwentts') as TtsConfig['kind'];
    providers.tts = [
      {
        id: kind === 'openai-compatible' ? 'tts' : kind,
        kind,
        ...(env.TTS_BASE_URL ? { baseURL: env.TTS_BASE_URL } : {}),
        ...(env.TTS_API_KEY ? { apiKey: env.TTS_API_KEY } : {}),
        ...(env.TTS_MODEL ? { model: env.TTS_MODEL } : {}),
        voices: (env.TTS_VOICES ?? '').split(',').map((v) => v.trim()).filter(Boolean),
      },
    ];
  }
  if (env.OPENAI_COMPAT_BASE_URL && env.OPENAI_COMPAT_MODEL) {
    providers['openai-compatible'] = [
      { id: 'openai-compatible', baseURL: env.OPENAI_COMPAT_BASE_URL, model: env.OPENAI_COMPAT_MODEL, ...(env.OPENAI_COMPAT_API_KEY ? { apiKey: env.OPENAI_COMPAT_API_KEY } : {}) },
    ];
  }
  if (Object.keys(providers).length) o.providers = providers as ConfigInput['providers'];
  return o;
}

/** The platform's per-user data directory for the app, resolved at runtime. */
export function defaultDataDir(env: Env = Bun.env, platform: string = process.platform): string {
  const home = env.HOME ?? env.USERPROFILE ?? '.';
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'lesebuehne');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'lesebuehne');
  return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'lesebuehne');
}

export interface LoadedConfig {
  config: ServerConfig;
  dataDir: string;
  /** Config files that were found and merged. */
  files: string[];
}

async function importConfig(path: string): Promise<ConfigInput | undefined> {
  if (!(await Bun.file(path).exists())) return undefined;
  const mod = (await import(path)) as { default?: ConfigInput };
  return mod.default ?? {};
}

/**
 * Defaults ← `lesebuehne.config.ts` (committed, no personal data) ← `lesebuehne.config.local.ts`
 * (gitignored) ← environment.
 */
export async function loadConfig(root: string, env: Env = Bun.env): Promise<LoadedConfig> {
  let config = DEFAULT_CONFIG;
  const files: string[] = [];
  for (const name of ['lesebuehne.config.ts', 'lesebuehne.config.local.ts']) {
    const path = join(root, name);
    const c = await importConfig(path);
    if (c) {
      config = mergeConfig(config, c);
      files.push(name);
    }
  }
  config = mergeConfig(config, envOverrides(env));
  return { config, dataDir: config.dataDir ?? defaultDataDir(env), files };
}
