import type { CueAction, VisualPlan } from '@lesebuehne/core';
import type { ReaderSession } from '../../app/session.ts';
import { toast } from '../../app/store.ts';
import { t } from '../../i18n/i18n.ts';

/** Debug overlay (D): plan mode, source, rationale, cues with times, voice and boundary state (B8). */
export function DebugOverlay({ session, plan, tau }: { session: ReaderSession; plan: VisualPlan; tau: number }) {
  const sectionId = session.sectionIdAt(session.engine.position.value.entryIndex) ?? '';
  const times = session.visualFor(session.stageKey(sectionId))?.times ?? [];
  const voice = session.engine.currentVoice;
  const p = session.engine.position.value;
  const info = session.planInfo.value.get(sectionId);
  const meta = plan.meta;
  const anim = plan.mode === 'animation' ? session.animations.value.get(sectionId) : undefined;
  const image = plan.mode === 'image' ? session.images.value.get(sectionId) : undefined;
  const source = meta ? `${meta.providerId}${meta.model ? ` · ${meta.model}` : ''} · ${meta.promptVersion}` : `${t('debug.heuristic')} · ${plan.version}`;
  return (
    <aside class="debug" aria-label={t('debug.title')}>
      <dl>
        <dt>{t('debug.mode')}</dt>
        <dd>
          {plan.mode}
          {plan.diagram ? ` · ${plan.diagram.template}` : ''}
          {meta?.downgraded ? ` (${meta.downgraded})` : ''}
        </dd>
        <dt>{t('debug.source')}</dt>
        <dd>
          {source}
          {info?.source === 'ai' && info.variants > 1 ? ` · ${t('debug.variant', { n: info.selected + 1, total: info.variants })}` : ''}
          {info?.error ? ` · ${t('debug.fallback')}` : ''}
        </dd>
        {plan.mode === 'animation' ? (
          <>
            <dt>{t('debug.animation')}</dt>
            <dd>
              {anim
                ? `${anim.status}${anim.reason ? ` (${anim.reason})` : ''} · ${anim.program.code.length} chars${anim.variants > 1 ? ` · ${t('debug.variant', { n: anim.selected + 1, total: anim.variants })}` : ''}`
                : t('debug.animationPending')}
            </dd>
          </>
        ) : null}
        {plan.mode === 'image' ? (
          <>
            <dt>{t('debug.image')}</dt>
            <dd>
              {image
                ? `${image.providerId}${image.variants > 1 ? ` · ${t('debug.variant', { n: image.selected + 1, total: image.variants })}` : ''}`
                : t('debug.imagePending')}
              {plan.image ? ` · ${plan.image.aspect} · ${plan.image.focusRegions.map((r) => r.label).join(', ')}` : ''}
            </dd>
          </>
        ) : null}
        <dt>{t('debug.rationale')}</dt>
        <dd>{plan.rationale}</dd>
        {meta?.dropped?.length ? (
          <>
            <dt>{t('debug.dropped')}</dt>
            <dd>{meta.dropped.join(' · ')}</dd>
          </>
        ) : null}
        <dt>{t('debug.voice')}</dt>
        <dd>{voice ? `${voice.name} (${voice.lang}${voice.localService ? ', local' : ''})` : '–'}</dd>
        <dt>{t('debug.boundaries')}</dt>
        <dd>{voice ? session.engine.detector.state(voice.voiceURI) : '–'}</dd>
        <dt>{t('debug.position')}</dt>
        <dd>
          #{p.entryIndex}:{p.tokenIndex} · τ {tau.toFixed(1)} s
        </dd>
      </dl>
      {session.ai ? (
        <div class="debug-actions">
          {info?.source === 'ai' && info.variants > 1 ? (
            <button type="button" class="btn btn-ghost small" onClick={() => void session.ai?.selectVariant(sectionId, -1)}>
              ‹
            </button>
          ) : null}
          <button
            type="button"
            class="btn btn-ghost small"
            onClick={() => {
              toast(t('ai.regenerating'), 'info', 1800);
              void session.ai?.regenerate(sectionId);
            }}
          >
            {t('debug.regenerate')} (R)
          </button>
          {info?.source === 'ai' && info.variants > 1 ? (
            <button type="button" class="btn btn-ghost small" onClick={() => void session.ai?.selectVariant(sectionId, 1)}>
              ›
            </button>
          ) : null}
        </div>
      ) : null}
      <h3>
        {t('debug.cues')} ({plan.cues.length})
      </h3>
      <ol class="debug-cues">
        {plan.cues.map((c, k) => (
          <li key={k} class={(times[k] ?? Infinity) <= tau ? 'is-applied' : undefined}>
            <code>{(times[k] ?? 0).toFixed(1)}s</code> {cueLabel(c.action)} ← “{c.anchor.phrase}”
          </li>
        ))}
      </ol>
    </aside>
  );
}

function cueLabel(a: CueAction): string {
  switch (a.type) {
    case 'reveal':
    case 'highlight':
    case 'dim':
      return `${a.type} ${a.itemId}`;
    case 'connect':
      return `connect ${a.from}→${a.to}`;
    case 'showTerm':
      return `term “${a.term}”`;
    case 'focus':
      return `focus ${a.regionId}`;
  }
}
