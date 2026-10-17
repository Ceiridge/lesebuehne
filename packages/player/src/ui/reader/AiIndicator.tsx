import { aiStatus } from '../../ai/state.ts';
import { t } from '../../i18n/i18n.ts';

/** Quiet top-bar status (B8): heuristic / AI / working / limited. Opens the settings. */
export function AiIndicator({ onOpen }: { onOpen: () => void }) {
  const s = aiStatus.value;
  const state = s.mode === 'heuristic' ? 'heuristic' : s.working > 0 ? 'working' : s.limited ? 'limited' : 'ready';
  const label = t(`ai.status.${state}`);
  const title = [label, s.lastProvider ? `${t('ai.provider')}: ${s.lastProvider}` : '', s.limited && s.lastError ? s.lastError.slice(0, 200) : '']
    .filter(Boolean)
    .join('\n');
  return (
    <button type="button" class={`ai-indicator is-${state} hide-narrow`} title={title} aria-label={label} onClick={onOpen}>
      <span class="ai-dot" aria-hidden="true" />
      <span class="ai-label">{state === 'heuristic' ? t('ai.short.heuristic') : t('ai.short.ai')}</span>
    </button>
  );
}
