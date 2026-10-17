import type { VisualPlan } from '@lesebuehne/core';
import type { ReaderSession } from '../../app/session.ts';
import { t } from '../../i18n/i18n.ts';

/** Debug overlay (D): plan mode, rationale, cues with times, voice and boundary state (B8). */
export function DebugOverlay({ session, plan, tau }: { session: ReaderSession; plan: VisualPlan; tau: number }) {
  const sectionId = session.sectionIdAt(session.engine.position.value.entryIndex) ?? '';
  const times = session.visualFor(sectionId)?.times ?? [];
  const voice = session.engine.currentVoice;
  const p = session.engine.position.value;
  return (
    <aside class="debug" aria-label={t('debug.title')}>
      <dl>
        <dt>{t('debug.mode')}</dt>
        <dd>
          {plan.mode}
          {plan.diagram ? ` · ${plan.diagram.template}` : ''}
        </dd>
        <dt>{t('debug.rationale')}</dt>
        <dd>{plan.rationale}</dd>
        <dt>{t('debug.voice')}</dt>
        <dd>{voice ? `${voice.name} (${voice.lang}${voice.localService ? ', local' : ''})` : '–'}</dd>
        <dt>{t('debug.boundaries')}</dt>
        <dd>{voice ? session.engine.detector.state(voice.voiceURI) : '–'}</dd>
        <dt>{t('debug.position')}</dt>
        <dd>
          #{p.entryIndex}:{p.tokenIndex} · τ {tau.toFixed(1)} s
        </dd>
      </dl>
      <h3>
        {t('debug.cues')} ({plan.cues.length})
      </h3>
      <ol class="debug-cues">
        {plan.cues.map((c, k) => (
          <li key={k} class={(times[k] ?? Infinity) <= tau ? 'is-applied' : undefined}>
            <code>{(times[k] ?? 0).toFixed(1)}s</code> {c.action.type === 'reveal' ? `reveal ${c.action.itemId}` : `term “${c.action.term}”`} ← “{c.anchor.phrase}”
          </li>
        ))}
      </ol>
    </aside>
  );
}
