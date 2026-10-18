import { aiDetails, aiStatus, ttsBuffer } from '../../ai/state.ts';
import { ttsStatus } from '../../ai/tts.ts';
import type { ReaderSession } from '../../app/session.ts';
import { settings } from '../../app/store.ts';
import { isTtsVoice } from '../../engine/audio-port.ts';
import { t } from '../../i18n/i18n.ts';

/** Independent speech/stage status, with the applied selection and direct settings links. */
export function AiIndicator({ session }: { session: ReaderSession }) {
  const ai = aiStatus.value;
  const speech = ttsStatus.value;
  const progress = session.generation.value;
  const voice = session.engine.currentVoice;
  const serverVoice = isTtsVoice(voice?.voiceURI);
  const speechState = session.pacerMode ? 'paused' : session.engine.silent ? 'off'
    : !serverVoice ? 'browser' : !ttsBuffer.value ? 'unavailable' : speech.limited ? 'limited'
    : speech.state === 'buffering' || progress.speech.some(r => r.state === 'working' || r.state === 'queued') ? 'working' : 'ready';
  const stageState = !session.stageVisible || session.stageCachePaused.value ? 'paused' : !session.ai ? 'heuristic'
    : ai.limited || progress.stage.some(r => r.state === 'error') ? 'limited'
    : ai.working > 0 || progress.stage.some(r => r.state === 'working' || r.state === 'queued') ? 'working' : 'ready';
  const provider = voice?.provider ?? (serverVoice ? voice?.voiceURI.split(':')[1] : undefined);
  const details = aiDetails.value;
  const stageProviders = details?.chain.filter(id => id !== 'heuristic').map(id => details.providers.find(p => p.id === id)?.label ?? id).join(' → ');
  const items = [
    { kind: 'speech', tab: 'reading', state: speechState, selected: voice?.name ?? t('settings.voiceNone'),
      detail: [provider ? `${t('ai.provider')}: ${provider}` : '', serverVoice && speech.limited ? speech.lastError : ''].filter(Boolean).join('\n') },
    { kind: 'stage', tab: 'stage', state: stageState, selected: t(`ai.visualKinds.${settings.value.visualKinds}`),
      detail: [session.ai ? t(`ai.mode.${ai.mode}`) : t('ai.status.heuristic'), stageProviders ? `${t('ai.chain')}: ${stageProviders}` : '', ai.limited ? ai.lastError : ''].filter(Boolean).join('\n') },
  ] as const;
  return <div class="header-generation">
    {items.map(item => {
      const label = t(`generation.${item.kind}`);
      const status = t(`header.generation.${item.state}`);
      const description = `${label}: ${item.selected} · ${status}`;
      if (item.kind === 'stage') return <div key={item.kind} class={`ai-indicator header-generator header-stage is-${item.state}`} data-generator="stage">
        <button type="button" class="header-stage-settings" title={`${description}\n${item.detail}`} aria-label={`${t('settings.tab.stage')}: ${status}`}
          onClick={() => { session.settingsTab.value = 'stage'; session.panel.value = 'settings'; }}>
          <strong>{label}</strong><span class="header-generator-status"><span class="ai-dot" aria-hidden="true" />{status}</span>
        </button>
        <select class="header-visual-kinds" aria-label={t('ai.visualKinds')} value={settings.value.visualKinds}
          onChange={(e) => { settings.value = { ...settings.value, visualKinds: e.currentTarget.value as 'mixed' | 'images' | 'animations' }; }}>
          {(['mixed', 'images', 'animations'] as const).map(kind => <option key={kind} value={kind}>{t(`ai.visualKinds.${kind}`)}</option>)}
        </select>
      </div>;
      return <button key={item.kind} type="button" class={`ai-indicator header-generator is-${item.state}`} data-generator={item.kind}
        title={`${description}${item.detail ? `\n${item.detail}` : ''}`} aria-label={description}
        onClick={() => { session.settingsTab.value = item.tab; session.panel.value = 'settings'; }}>
        <span class="header-generator-selection"><strong>{label}</strong><span>{item.selected}</span></span>
        <span class="header-generator-status"><span class="ai-dot" aria-hidden="true" />{status}</span>
      </button>;
    })}
  </div>;
}
