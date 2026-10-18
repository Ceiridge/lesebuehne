import type { ModelOption } from '@lesebuehne/core';
import { useEffect, useState } from 'preact/hooks';
import type { LlmChoice } from '../../ai/backends.ts';
import { aiBackend, aiDetails } from '../../ai/state.ts';
import { t, type MessageKey } from '../../i18n/i18n.ts';

const KNOWN_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const effortLabel = (effort: string): string => (KNOWN_EFFORTS.includes(effort) ? t(`ai.effort.${effort}` as MessageKey) : effort);

/** The level `auto` sends for a task (mirrors `effortFor` in core: nearest supported level). */
function nearest(levels: readonly string[], wanted: string): string | undefined {
  const target = KNOWN_EFFORTS.indexOf(wanted);
  return [...levels].sort((a, b) => Math.abs(KNOWN_EFFORTS.indexOf(a) - target) - Math.abs(KNOWN_EFFORTS.indexOf(b) - target))[0];
}

/**
 * Settings → Connect AI → text model: model, speed tier and reasoning level for a server text
 * provider that can list its models (the Codex catalog with the ChatGPT sign-in, OpenRouter …).
 * Changes are saved on the server at once and apply to new requests.
 */
export function ModelSettings() {
  const backend = aiBackend.value;
  const providers = (aiDetails.value?.providers ?? []).filter((p) => p.kind === 'llm' && p.models && p.available);
  const [providerId, setProviderId] = useState<string>();
  const [models, setModels] = useState<ModelOption[] | null>();
  const [choice, setChoice] = useState<LlmChoice>({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const id = providerId && providers.some((p) => p.id === providerId) ? providerId : providers[0]?.id;

  useEffect(() => {
    if (!id || !backend?.llmModels) return;
    const ctrl = new AbortController();
    setModels(undefined);
    setError('');
    setSaved(false);
    backend.llmModels(id, ctrl.signal).then((r) => {
      setModels(r.models);
      setChoice(r.choice);
      if (r.error) setError(r.error);
    }, (e: unknown) => !ctrl.signal.aborted && setError(e instanceof Error ? e.message : String(e)));
    return () => ctrl.abort();
  }, [id, backend]);

  if (backend?.mode !== 'server' || !backend.saveLlmChoice || !id) return null;

  const save = (patch: LlmChoice): void => {
    const next = { ...choice, ...patch };
    setChoice(next);
    setSaved(false);
    backend.saveLlmChoice!(id, next).then((c) => { setChoice(c); setSaved(true); }, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  const auto = !choice.model || choice.model === 'auto';
  const selected = models?.find((m) => m.id === (auto ? models[0]?.id : choice.model));
  const levels = selected?.reasoningLevels?.map((l) => l.effort) ?? [];
  const tiers = selected?.serviceTiers ?? [];
  const reasoning = choice.reasoning ?? 'auto';
  const tier = choice.serviceTier ?? 'default';
  const tierInfo = tiers.find((x) => x.id === tier);
  const levelInfo = selected?.reasoningLevels?.find((l) => l.effort === reasoning);

  return (
    <details class="settings-fold" id="model-settings" open>
      <summary>{t('ai.model.title')}<span class="fold-meta">{selected ? selected.name : auto ? t('ai.model.autoNone') : choice.model}</span></summary>
      <div class="fold-body">
        {providers.length > 1 ? (
          <div class="field">
            <label class="field-label" for="model-provider">{t('ai.model.provider')}</label>
            <select id="model-provider" value={id} onChange={(e) => setProviderId(e.currentTarget.value)}>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
        ) : null}
        <div class="field">
          <label class="field-label" for="model-model">{t('ai.model.model')}</label>
          {models === undefined && !error ? <p class="field-hint">{t('ai.model.loading')}</p> : models ? (
            <select id="model-model" value={auto ? 'auto' : choice.model} onChange={(e) => save({ model: e.currentTarget.value })}>
              <option value="auto">{models[0] ? t('ai.model.auto', { name: models[0].name }) : t('ai.model.autoNone')}</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.name === m.id ? m.id : `${m.name} · ${m.id}`}</option>)}
              {!auto && !models.some((m) => m.id === choice.model) ? <option value={choice.model}>{choice.model}</option> : null}
            </select>
          ) : (
            <input id="model-model" type="text" spellcheck={false} value={auto ? '' : choice.model} placeholder="auto" onChange={(e) => save({ model: e.currentTarget.value.trim() || 'auto' })} />
          )}
          {selected?.description ? <p class="field-hint">{selected.description}</p> : null}
        </div>
        {tiers.length ? (
          <div class="field">
            <label class="field-label" for="model-speed">{t('ai.model.speed')}</label>
            <select id="model-speed" value={tier} onChange={(e) => save({ serviceTier: e.currentTarget.value })}>
              <option value="default">{t('ai.model.speed.default')}</option>
              {tiers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
            <p class="field-hint">{tierInfo?.description ? `${tierInfo.description} ` : ''}{t('ai.model.speedHint')}</p>
          </div>
        ) : null}
        {levels.length ? (
          <div class="field">
            <label class="field-label" for="model-reasoning">{t('ai.model.reasoning')}</label>
            <select id="model-reasoning" value={reasoning} onChange={(e) => save({ reasoning: e.currentTarget.value })}>
              <option value="auto">{t('ai.model.reasoning.auto', { plan: effortLabel(nearest(levels, 'low') ?? 'low'), other: effortLabel(nearest(levels, 'medium') ?? 'medium') })}</option>
              <option value="default">{t('ai.model.reasoning.default', { level: selected?.defaultReasoning ? effortLabel(selected.defaultReasoning) : '—' })}</option>
              {levels.map((l) => <option key={l} value={l}>{effortLabel(l)}</option>)}
            </select>
            {levelInfo?.description ? <p class="field-hint">{levelInfo.description}</p> : null}
            <p class="field-hint">{t('ai.model.reasoningHint')}</p>
          </div>
        ) : null}
        {saved ? <p class="settings-feedback" role="status">{t('ai.model.saved')}</p> : null}
        {error ? <p class="settings-error" role="alert">{t('ai.model.loadError', { error })}</p> : null}
      </div>
    </details>
  );
}
