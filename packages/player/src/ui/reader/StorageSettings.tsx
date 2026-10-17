import type { CacheScope, CacheStats } from '@lesebuehne/core';
import { useEffect, useState } from 'preact/hooks';
import { aiBackend } from '../../ai/state.ts';
import type { ReaderSession } from '../../app/session.ts';
import { t } from '../../i18n/i18n.ts';

const size = (bytes: number) => bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function StorageSettings({ session }: { session: ReaderSession }) {
  const backend = aiBackend.value;
  const [stats, setStats] = useState<CacheStats>();
  const [busy, setBusy] = useState<CacheScope>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setStats(undefined);
    setError('');
    void backend?.cacheStats?.().then((v) => live && setStats(v), (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => { live = false; };
  }, [backend]);
  const clear = async (scope: CacheScope) => {
    setBusy(scope); setError(''); setMessage('');
    try {
      await session.clearCache(scope);
      setMessage(t(`storage.cleared.${scope}`));
      setStats(await backend?.cacheStats?.());
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(undefined); }
  };
  return <>
    <header class="settings-intro"><h3>{t('storage.title')}</h3><p>{t('storage.hint')}</p></header>
    <p class="storage-location">{t(backend?.mode === 'server' ? 'storage.server' : 'storage.browser')}</p>
    {(['stage', 'speech'] as const).map((scope) => <section class="cache-row" key={scope}>
      <div><h4>{t(`storage.${scope}`)}</h4><p>{t(`storage.${scope}Hint`)}</p><span class="cache-size">{stats ? `${size(stats[scope].bytes)} · ${t('storage.entries', { n: stats[scope].entries })}` : '—'}</span></div>
      <button type="button" class="btn" disabled={!backend?.clearCache || !!busy} onClick={() => void clear(scope)}>{busy === scope ? t('storage.clearing') : t('storage.clear')}</button>
    </section>)}
    {session.stageCachePaused.value ? <button type="button" class="btn btn-primary" onClick={() => session.resumeStage()}>{t('storage.resumeStage')}</button> : null}
    <p class="field-hint">{t('storage.preserved')}</p>
    {message ? <p class="settings-feedback" role="status">{message}</p> : null}
    {error ? <p class="settings-error" role="alert">{error}</p> : null}
  </>;
}
