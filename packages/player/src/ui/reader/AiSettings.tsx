import { useEffect, useState } from 'preact/hooks';
import { aiConnecting, aiPrefs, connectAi, updateAiPrefs } from '../../ai/connect.ts';
import { BROWSER_PROVIDERS, maskKey, type AiPrefs, type BrowserProviderId, type ByokConfig } from '../../ai/prefs.ts';
import { aiBackend, aiDetails, aiStatus, refreshDetails } from '../../ai/state.ts';
import { useEnv } from '../../app/env.ts';
import type { ReaderSession } from '../../app/session.ts';
import { toast } from '../../app/store.ts';
import { t, type MessageKey } from '../../i18n/i18n.ts';

const NEEDS_BASE_URL: ReadonlySet<BrowserProviderId> = new Set(['openai-compatible', 'anthropic-compatible']);

function ByokFields({ id, config, onChange }: { id: BrowserProviderId; config: ByokConfig; onChange: (c: ByokConfig) => void }) {
  const [key, setKey] = useState('');
  return (
    <div class="byok-fields">
      <label class="field-label small" for={`byok-${id}-key`}>
        {t('ai.apiKey')}
      </label>
      <input
        id={`byok-${id}-key`}
        type="password"
        autocomplete="off"
        spellcheck={false}
        placeholder={config.apiKey ? maskKey(config.apiKey) : t('ai.apiKeyPlaceholder')}
        value={key}
        onInput={(e) => setKey(e.currentTarget.value)}
        onBlur={() => {
          if (key.trim()) onChange({ ...config, apiKey: key.trim() });
          setKey('');
        }}
      />
      <label class="field-label small" for={`byok-${id}-model`}>
        {t('ai.model')}
      </label>
      <input id={`byok-${id}-model`} type="text" spellcheck={false} value={config.model} placeholder={t('ai.modelPlaceholder')} onChange={(e) => onChange({ ...config, model: e.currentTarget.value.trim() })} />
      {NEEDS_BASE_URL.has(id) ? (
        <>
          <label class="field-label small" for={`byok-${id}-url`}>
            {t('ai.baseUrl')}
          </label>
          <input id={`byok-${id}-url`} type="url" spellcheck={false} value={config.baseURL} placeholder={id === 'openai-compatible' ? 'https://…/v1' : 'https://api.anthropic.com'} onChange={(e) => onChange({ ...config, baseURL: e.currentTarget.value.trim() })} />
        </>
      ) : null}
      {config.apiKey ? (
        <button type="button" class="btn btn-ghost small" onClick={() => onChange({ ...config, apiKey: '' })}>
          {t('ai.forgetKey')}
        </button>
      ) : null}
    </div>
  );
}

/** Settings → AI director (B8): status, chain, usage, sign-in, BYOK. */
export function AiSettings({ session }: { session: ReaderSession }) {
  const env = useEnv();
  const prefs = aiPrefs.value;
  const details = aiDetails.value;
  const backend = aiBackend.value;
  const status = aiStatus.value;

  useEffect(() => {
    void refreshDetails();
  }, []);

  if (!env.http || !prefs) return null;

  const change = (patch: (p: AiPrefs) => AiPrefs, reconnect = true): void => {
    updateAiPrefs(env, patch);
    if (reconnect) void connectAi(env);
  };
  const move = (id: BrowserProviderId, delta: number): void =>
    change((p) => {
      const order = [...p.order];
      const k = order.indexOf(id);
      const j = k + delta;
      if (k < 0 || j < 0 || j >= order.length) return p;
      [order[k], order[j]] = [order[j]!, order[k]!];
      return { ...p, order };
    });

  const where = backend ? t(`ai.mode.${backend.mode}` as MessageKey) : t('ai.mode.heuristic');
  return (
    <>
      <h3 class="settings-group" id="settings-ai">
        {t('ai.title')}
      </h3>
      <div class="field">
        <span class="field-label" id="ai-mode-label">
          {t('ai.enabled')}
        </span>
        <div class="segmented" role="radiogroup" aria-labelledby="ai-mode-label">
          {(['auto', 'off'] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={prefs.mode === m} onClick={() => change((p) => ({ ...p, mode: m }))}>
              {t(`ai.enabled.${m}`)}
            </button>
          ))}
        </div>
        <p class="field-hint">
          {aiConnecting.value ? t('ai.connecting') : where}
          {status.lastProvider ? ` · ${t('ai.provider')}: ${status.lastProvider}` : ''}
        </p>
      </div>

      {details ? (
        <div class="field">
          <span class="field-label">{t('ai.chain')}</span>
          <ul class="provider-list">
            {details.providers.map((p) => (
              <li key={p.id} class={p.available ? 'is-ok' : 'is-off'}>
                <span class="provider-dot" aria-hidden="true" />
                <span class="provider-text">
                  <span class="provider-name">
                    {p.label}
                    {p.source ? ` · ${p.source}` : ''}
                  </span>
                  <span class="provider-meta">
                    {p.available ? t('ai.available') : (p.reason ?? t('ai.unavailableShort'))}
                    {p.usage && p.usage.calls > 0
                      ? ` · ${t('ai.usage', { calls: p.usage.calls, tokens: Math.round((p.usage.inputTokens + p.usage.outputTokens) / 100) / 10 })}`
                      : ''}
                  </span>
                </span>
                {p.login && backend?.login ? (
                  <button
                    type="button"
                    class="btn btn-ghost small"
                    onClick={async () => {
                      try {
                        const url = await backend.login!(p.id);
                        globalThis.open?.(url, '_blank', 'noopener');
                        toast(t('ai.signInStarted'), 'info', 4000);
                      } catch (e) {
                        toast(e instanceof Error ? e.message : String(e), 'error');
                      }
                    }}
                  >
                    {t('ai.signIn')}
                  </button>
                ) : null}
              </li>
            ))}
            <li class="is-ok">
              <span class="provider-dot" aria-hidden="true" />
              <span class="provider-text">
                <span class="provider-name">{t('ai.heuristic')}</span>
                <span class="provider-meta">{t('ai.heuristicHint')}</span>
              </span>
            </li>
          </ul>
        </div>
      ) : null}

      {session.ai ? (
        <div class="field">
          <button
            type="button"
            class="btn btn-ghost btn-block"
            onClick={() => {
              toast(t('ai.regeneratingStyle'), 'info', 2400);
              void session.ai?.regenerateStyle();
            }}
          >
            {t('ai.regenerateStyle')}
          </button>
          {session.styleBible.value ? (
            <p class="field-hint">
              {t('ai.styleSummary', { mood: session.styleBible.value.mood, concepts: session.styleBible.value.glossary.length })}
            </p>
          ) : null}
        </div>
      ) : null}

      <div class="field">
        <label class="field-label" for="ai-server-url">
          {t('ai.serverUrl')}
        </label>
        <input
          id="ai-server-url"
          type="url"
          spellcheck={false}
          placeholder="http://127.0.0.1:8787"
          value={prefs.serverUrl}
          onChange={(e) => change((p) => ({ ...p, serverUrl: e.currentTarget.value.trim() }))}
        />
        <p class="field-hint">{t('ai.serverHint')}</p>
      </div>

      <div class="field">
        <span class="field-label">{t('ai.byok')}</span>
        <p class="field-hint">{t('ai.byokHint')}</p>
        <ol class="byok-list">
          {prefs.order.map((id, k) => {
            const c = prefs.byok[id];
            return (
              <li key={id}>
                <div class="byok-head">
                  <label class="check">
                    <input type="checkbox" checked={c.enabled} onChange={(e) => change((p) => ({ ...p, byok: { ...p.byok, [id]: { ...c, enabled: e.currentTarget.checked } } }))} />
                    {t(`ai.provider.${id}` as MessageKey)}
                  </label>
                  <span class="byok-order">
                    <button type="button" class="icon-btn small" aria-label={t('ai.up')} disabled={k === 0} onClick={() => move(id, -1)}>
                      ↑
                    </button>
                    <button type="button" class="icon-btn small" aria-label={t('ai.down')} disabled={k === BROWSER_PROVIDERS.length - 1} onClick={() => move(id, 1)}>
                      ↓
                    </button>
                  </span>
                </div>
                {c.enabled ? <ByokFields id={id} config={c} onChange={(next) => change((p) => ({ ...p, byok: { ...p.byok, [id]: next } }))} /> : null}
              </li>
            );
          })}
        </ol>
      </div>
    </>
  );
}
