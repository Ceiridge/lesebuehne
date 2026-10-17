import { effect } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { browserEnv, EnvContext, type AppEnv } from '../app/env.ts';
import { applySettings, dismissToast, route, settings, toasts } from '../app/store.ts';
import { connectAi } from '../ai/connect.ts';
import { IconClose } from './icons.tsx';
import { Reader } from './reader/Reader.tsx';
import { StartPage } from './start/StartPage.tsx';

function Toasts() {
  if (toasts.value.length === 0) return null;
  return (
    <div class="toasts">
      {toasts.value.map((x) => (
        <div key={x.id} class={`toast toast-${x.kind}`} role={x.kind === 'error' ? 'alert' : 'status'}>
          <span>{x.text}</span>
          <button type="button" class="icon-btn small" aria-label="×" onClick={() => dismissToast(x.id)}>
            <IconClose size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The player app: start page or reader, settings applied live (B8). */
export function App({ env }: { env?: AppEnv }) {
  const appEnv = useMemo(() => env ?? browserEnv(), [env]);

  useEffect(() => {
    settings.value = appEnv.settings.load();
    const root = document.documentElement;
    const languages = typeof navigator === 'undefined' ? undefined : navigator.languages;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const save = () => { clearTimeout(saveTimer); appEnv.settings.save(settings.peek()); };
    const stop = effect(() => {
      const s = settings.value;
      applySettings(s, root, appEnv.prefersDark(), languages);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 180);
    });
    const onHidden = () => { if (document.visibilityState === 'hidden') save(); };
    addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', onHidden);
    void connectAi(appEnv);
    const dark = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    const onScheme = (): void => applySettings(settings.value, root, appEnv.prefersDark(), languages);
    dark?.addEventListener?.('change', onScheme);
    return () => {
      stop();
      save();
      removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', onHidden);
      dark?.removeEventListener?.('change', onScheme);
    };
  }, [appEnv]);

  const r = route.value;
  return (
    <EnvContext.Provider value={appEnv}>
      {r.name === 'reader' ? <Reader key={r.session.book.id} session={r.session} /> : <StartPage />}
      <Toasts />
    </EnvContext.Provider>
  );
}
