import { useEffect, useState } from 'preact/hooks';
import { aiConnecting, aiDraft, aiPrefs, connectAi, updateAiPrefs } from '../../ai/connect.ts';
import { BROWSER_IMAGE_PROVIDERS, BROWSER_PROVIDERS, BROWSER_VOICE_PRESETS, maskKey, type AiPrefs, type BrowserProviderId, type ByokConfig } from '../../ai/prefs.ts';
import { aiBackend, aiDetails, aiStatus, refreshDetails } from '../../ai/state.ts';
import { useEnv } from '../../app/env.ts';
import type { ReaderSession } from '../../app/session.ts';
import { toast } from '../../app/store.ts';
import { t, type MessageKey } from '../../i18n/i18n.ts';
import { ModelSettings } from './ModelSettings.tsx';

const NEEDS_BASE_URL: ReadonlySet<BrowserProviderId> = new Set(['openai-compatible', 'anthropic-compatible']);

/** Write-only key input: shows a masked hint, saves on blur. */
function KeyField({ id, value, onChange }: { id: string; value: string; onChange: (key: string) => void }) {
  const [key, setKey] = useState('');
  return (
    <>
      <label class="field-label small" for={id}>
        {t('ai.apiKey')}
      </label>
      <input
        id={id}
        type="password"
        autocomplete="off"
        spellcheck={false}
        placeholder={value ? maskKey(value) : t('ai.apiKeyPlaceholder')}
        value={key}
        onInput={(e) => setKey(e.currentTarget.value)}
        onBlur={() => {
          if (key.trim()) onChange(key.trim());
          setKey('');
        }}
      />
      {value ? (
        <button type="button" class="btn btn-ghost small" onClick={() => onChange('')}>
          {t('ai.forgetKey')}
        </button>
      ) : null}
    </>
  );
}

function TextField({ id, label, value, placeholder, type = 'text', onChange }: { id: string; label: string; value: string; placeholder?: string; type?: string; onChange: (v: string) => void }) {
  return (
    <>
      <label class="field-label small" for={id}>
        {label}
      </label>
      <input id={id} type={type} spellcheck={false} value={value} {...(placeholder ? { placeholder } : {})} onChange={(e) => onChange(e.currentTarget.value.trim())} />
    </>
  );
}

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
export function AiSettings({ session }: { session?: ReaderSession }) {
  const env = useEnv();
  const prefs = aiDraft.value ?? aiPrefs.value;
  const details = aiDetails.value;
  const backend = aiBackend.value;
  const status = aiStatus.value;
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    void refreshDetails();
  }, []);

  if (!env.http || !prefs) return null;

  const change = (patch: (p: AiPrefs) => AiPrefs): void => {
    aiDraft.value = patch(aiDraft.value ?? prefs);
    setSaved(false);
  };
  const apply = async () => {
    setSaveError('');
    if (!aiDraft.value && backend) {
      await refreshDetails();
      await session?.refreshVoices();
      setSaved(true);
      return;
    }
    updateAiPrefs(env, () => aiDraft.value ?? prefs);
    aiDraft.value = undefined;
    try { await connectAi(env); setSaved(true); }
    catch (e) { setSaveError(e instanceof Error ? e.message : String(e)); }
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
    <div class="ai-settings">
      <header class="settings-intro" id="settings-ai"><h3>{t(session ? 'settings.tab.ai' : 'ai.title')}</h3><p>{t('ai.overviewHint')}</p></header>
      <div class="connection-status" role="status"><span class={backend ? 'connection-dot is-ok' : 'connection-dot'} /><div><strong>{aiConnecting.value ? t('ai.connecting') : where}</strong><span>{t(backend?.mode === 'server' ? 'ai.activeServerHint' : backend?.mode === 'browser' ? 'ai.activeBrowserHint' : 'ai.activeOfflineHint')}</span></div></div>
      <Capabilities />
      <ModelSettings />
      <details class="settings-fold"><summary>{t('ai.connectionSetup')}</summary><div class="fold-body">
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
      <div class="field">
        <label class="field-label" for="ai-connection">{t('ai.connection')}</label>
        <select id="ai-connection" value={prefs.connection} onChange={(e) => change((p) => ({ ...p, connection: e.currentTarget.value as AiPrefs['connection'] }))}>
          {(['auto', 'server', 'browser'] as const).map((v) => <option value={v} key={v}>{t(`ai.connection.${v}`)}</option>)}
        </select>
        <p class="field-hint">{t('ai.connectionHint')}</p>
      </div>
      <div class="field">
        <label class="field-label" for="ai-server-url">{t('ai.serverUrl')}</label>
        <input id="ai-server-url" type="url" spellcheck={false} placeholder="http://127.0.0.1:8787" value={prefs.serverUrl} onChange={(e) => change((p) => ({ ...p, serverUrl: e.currentTarget.value.trim() }))} />
        <p class="field-hint">{t('ai.serverHint')}</p>
      </div>
      </div></details>

      {details ? (
        <details class="settings-fold" id="provider-diagnostics"><summary>{t('ai.providerDetails')}<span class="fold-meta">{details.providers.filter((p) => p.available).length} / {details.providers.length}</span></summary><div class="fold-body">
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
        {status.lastError ? <p class="settings-error">{status.lastError}</p> : null}
        <button class="btn" type="button" onClick={() => void refreshDetails()}>{t('ai.checkConnection')}</button>
        </div></details>
      ) : null}

      <details class="settings-fold" id="browser-provider-setup"><summary>{t('ai.browserSetup')}</summary><div class="fold-body">
      {backend?.mode === 'server' && prefs.connection !== 'browser' ? <p class="field-hint">{t('ai.browserInactive')}</p> : null}
      <details class="settings-fold" id="browser-text-setup"><summary>{t('ai.textProviders')}<span class="fold-meta">{prefs.order.filter((id) => prefs.byok[id].enabled).length}</span></summary><div class="fold-body">
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
                {c.enabled ? <details class="provider-config"><summary>{t('ai.configure')}</summary><ByokFields id={id} config={c} onChange={(next) => change((p) => ({ ...p, byok: { ...p.byok, [id]: next } }))} /></details> : null}
              </li>
            );
          })}
        </ol>
      </div>
      </div></details>

      <details class="settings-fold" id="browser-images-setup"><summary>{t('ai.images')}<span class="fold-meta">{t(`ai.images.${prefs.images.provider}` as MessageKey)}</span></summary><div class="fold-body">
      <div class="field">
        <span class="field-label" id="ai-images-label">
          {t('ai.images')}
        </span>
        <div class="segmented" role="radiogroup" aria-labelledby="ai-images-label">
          {BROWSER_IMAGE_PROVIDERS.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={prefs.images.provider === m} onClick={() => change((p) => ({ ...p, images: { ...p.images, provider: m } }))}>
              {t(`ai.images.${m}` as MessageKey)}
            </button>
          ))}
        </div>
        {prefs.images.provider !== 'off' ? (
          <div class="byok-fields">
            <KeyField id="ai-images-key" value={prefs.images.apiKey} onChange={(apiKey) => change((p) => ({ ...p, images: { ...p.images, apiKey } }))} />
            <TextField id="ai-images-model" label={t('ai.model')} value={prefs.images.model} placeholder={t('ai.imageModelPlaceholder')} onChange={(model) => change((p) => ({ ...p, images: { ...p.images, model } }))} />
            {prefs.images.provider === 'openai-compatible' ? (
              <TextField id="ai-images-url" type="url" label={t('ai.baseUrl')} value={prefs.images.baseURL} placeholder="https://…/v1" onChange={(baseURL) => change((p) => ({ ...p, images: { ...p.images, baseURL } }))} />
            ) : null}
          </div>
        ) : null}
        <p class="field-hint">{prefs.images.provider === 'openrouter' ? t('ai.imagesHintOpenRouter') : t('ai.imagesHint')}</p>
      </div>
      </div></details>

      <details class="settings-fold" id="browser-voice-setup"><summary>{t('ai.voice')}<span class="fold-meta">{prefs.voice.enabled ? t(`ai.voice.${prefs.voice.preset}` as MessageKey) : t('ai.enabled.off')}</span></summary><div class="fold-body">
      <div class="field">
        <label class="check">
          <input type="checkbox" checked={prefs.voice.enabled} onChange={(e) => change((p) => ({ ...p, voice: { ...p.voice, enabled: e.currentTarget.checked } }))} />
          {t('ai.voice')}
        </label>
        {prefs.voice.enabled ? (
          <div class="byok-fields">
            <div class="segmented" role="radiogroup" aria-label={t('ai.voice')}>
              {BROWSER_VOICE_PRESETS.map((m) => (
                <button key={m} type="button" role="radio" aria-checked={prefs.voice.preset === m} onClick={() => change((p) => ({ ...p, voice: { ...p.voice, preset: m } }))}>
                  {t(`ai.voice.${m}` as MessageKey)}
                </button>
              ))}
            </div>
            {prefs.voice.preset !== 'openai' ? (
              <TextField
                id="ai-voice-url"
                type="url"
                label={t('ai.baseUrl')}
                value={prefs.voice.baseURL}
                placeholder={prefs.voice.preset === 'qwentts' ? 'http://127.0.0.1:8080/v1' : 'https://…/v1'}
                onChange={(baseURL) => change((p) => ({ ...p, voice: { ...p.voice, baseURL } }))}
              />
            ) : null}
            {prefs.voice.preset !== 'qwentts' ? <KeyField id="ai-voice-key" value={prefs.voice.apiKey} onChange={(apiKey) => change((p) => ({ ...p, voice: { ...p.voice, apiKey } }))} /> : null}
            {prefs.voice.preset !== 'qwentts' ? (
              <TextField id="ai-voice-model" label={t('ai.model')} value={prefs.voice.model} placeholder={prefs.voice.preset === 'openai' ? 'gpt-4o-mini-tts' : ''} onChange={(model) => change((p) => ({ ...p, voice: { ...p.voice, model } }))} />
            ) : null}
            {prefs.voice.preset !== 'openai' ? (
              <TextField
                id="ai-voice-parallel"
                type="number"
                label={t('ai.voiceParallel')}
                value={String(prefs.voice.parallel)}
                onChange={(n) => change((p) => ({ ...p, voice: { ...p.voice, parallel: Math.min(8, Math.max(1, Math.round(Number(n)) || 1)) } }))}
              />
            ) : null}
            <TextField id="ai-voice-voices" label={t('ai.voices')} value={prefs.voice.voices} placeholder={prefs.voice.preset === 'openai' ? 'alloy, nova' : 'serena'} onChange={(voices) => change((p) => ({ ...p, voice: { ...p.voice, voices } }))} />
          </div>
        ) : null}
        <p class="field-hint">{t('ai.voiceHint')}</p>
      </div>
      </div></details>
      </div></details>
      <div class="provider-savebar">
        <p>{aiDraft.value ? t('ai.unsaved') : saved ? t('ai.saved') : t('ai.saveHint')}</p>
        <div><button type="button" class="btn btn-primary" disabled={aiConnecting.value} onClick={() => void apply()}>{aiConnecting.value ? t('ai.connecting') : aiDraft.value ? t('ai.saveConnect') : t('ai.checkConnection')}</button>
        {aiDraft.value ? <button type="button" class="btn btn-ghost" onClick={() => (aiDraft.value = undefined)}>{t('ai.discard')}</button> : null}</div>
      </div>
      {saveError ? <p class="settings-error" role="alert">{saveError}</p> : null}
    </div>
  );
}

/** What works here and what needs the local server (spec 006 B3). */
function Capabilities() {
  const b = aiBackend.value;
  const details = aiDetails.value;
  const available = (kind: string) => !!details?.providers.some((p) => p.kind === kind && p.available);
  const open = (label: MessageKey) => {
    const id = b?.mode === 'server' ? 'provider-diagnostics' : label === 'ai.cap.plans' ? 'browser-text-setup' : label === 'ai.cap.images' ? 'browser-images-setup' : 'browser-voice-setup';
    const target = document.getElementById(id);
    for (let parent = target; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
    target?.scrollIntoView({ block: 'nearest' });
    target?.querySelector('summary')?.focus();
  };
  const rows: Array<[MessageKey, boolean, MessageKey]> = [
    ['ai.cap.reading', true, 'ai.cap.always'],
    ['ai.cap.plans', !!b && b.plans !== false && available('llm'), 'ai.cap.needsKey'],
    ['ai.cap.images', !!b?.image && available('image'), 'ai.cap.needsImages'],
    ['ai.cap.voices', !!b?.tts && available('tts'), 'ai.cap.needsVoice'],
  ];
  return (
    <div class="field">
      <span class="field-label">{t('ai.cap.title')}</span>
      <ul class="provider-list capability-list">
        {rows.map(([label, ok, hint]) => (
          <li key={label} class={ok ? 'is-ok' : 'is-off'}>
            <span class="provider-dot" aria-hidden="true" />
            <span class="provider-text">
              {label === 'ai.cap.reading' ? <span class="provider-name">{t(label)}</span> : <button type="button" class="capability-link" onClick={() => open(label)}>{t(label)} <span aria-hidden="true">→</span></button>}
              <span class="provider-meta">{ok ? t(hint === 'ai.cap.always' ? hint : 'ai.available') : t(hint)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
