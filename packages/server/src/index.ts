/** @lesebuehne/server: local API on 127.0.0.1 (providers, LLM director, cache, sign-in). */
import { join } from 'node:path';
import { createApi, type ApiContext } from './api.ts';
import { loadConfig, type LoadedConfig } from './config.ts';
import { DiskCache } from './disk-cache.ts';
import { buildProviders } from './providers.ts';

export { createApi, SERVER_VERSION, type ApiContext, type ServerEvent } from './api.ts';
export { DEFAULT_CONFIG, defaultDataDir, defineConfig, envOverrides, loadConfig, mergeConfig, type ConfigInput, type ServerConfig } from './config.ts';
export { DiskCache } from './disk-cache.ts';
export { buildProviders, type ProviderSetup } from './providers.ts';

export interface LocalApi {
  loaded: LoadedConfig;
  api: ReturnType<typeof createApi>;
  context: ApiContext;
}

/** Config → providers → disk cache → API, for the dev server, `bun run server` and the doctor. */
export async function createLocalApi(root: string, log: (line: string) => void = (l) => console.log(`[api] ${l}`)): Promise<LocalApi> {
  const loaded = await loadConfig(root);
  const providers = buildProviders(loaded.config, loaded.dataDir);
  const context: ApiContext = {
    config: loaded.config,
    dataDir: loaded.dataDir,
    providers,
    cache: new DiskCache(join(loaded.dataDir, 'cache')),
    log,
  };
  return { loaded, api: createApi(context), context };
}
