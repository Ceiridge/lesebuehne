import { defineConfig } from '@lesebuehne/server';

/**
 * Lesebühne server defaults (committed: no personal data, no keys). Put your own settings in
 * `lesebuehne.config.local.ts` (gitignored, same shape) and keys in environment variables
 * (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_COMPAT_* …). See README → Providers.
 */
export default defineConfig({
  server: { port: 8787, origins: [] },
  llm: { chain: ['codex-auth', 'chatgpt-plan', 'openrouter', 'anthropic-compatible'] },
  director: { budget: { images: 2, animations: 3 } },
  providers: {
    'codex-auth': { enabled: true, model: 'auto', sources: ['opencode', 'codex-cli', 'own'] },
    'chatgpt-plan': { enabled: true, model: 'auto' },
    openrouter: { enabled: true, maxCallsPerDay: 500 },
    // Example for a local endpoint (Ollama, LM Studio …):
    // 'openai-compatible': [{ id: 'ollama', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' }],
    // Example for a local Qwen3-TTS server (qwentts.cpp `tts-server --port 8080 --max-batch 4`):
    // tts: [{ id: 'qwentts', kind: 'qwentts', baseURL: 'http://127.0.0.1:8080/v1', voices: ['vivian'], concurrency: 4 }],
  },
});
